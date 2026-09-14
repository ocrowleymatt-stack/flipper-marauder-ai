import type { StreamChunk, ToolCallRequest } from '@atlas-vnext/contracts';

export interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface BufferedToolCall {
  key: string;
  index?: number;
  id?: string;
  name?: string;
  arguments: string;
  emitted: boolean;
}

/**
 * Assembles OpenAI-compatible streamed tool calls across SSE deltas.
 *
 * Providers emit `function.arguments` as JSON fragments. Those fragments
 * must never be parsed or committed as complete calls.
 */
export class OpenAIToolCallAssembler {
  private readonly calls = new Map<string, BufferedToolCall>();
  private readonly idToKey = new Map<string, string>();

  ingest(deltas: OpenAIToolCallDelta[]): void {
    for (const delta of deltas) {
      const buf = this.bufferFor(delta);
      if (delta.id) {
        buf.id = delta.id;
        this.idToKey.set(delta.id, buf.key);
      }
      if (delta.function?.name) buf.name = delta.function.name;
      if (typeof delta.function?.arguments === 'string') {
        buf.arguments += delta.function.arguments;
      }
    }
  }

  /**
   * Emit structurally complete calls and warnings for leftovers.
   * Call only at finish_reason / [DONE] / stream end — never per delta.
   */
  finish(providerId: string): StreamChunk[] {
    const out: StreamChunk[] = [];
    for (const buf of this.calls.values()) {
      if (buf.emitted) continue;
      const parsed = parseCompleteToolCall(buf);
      if (parsed.ok) {
        buf.emitted = true;
        out.push({ type: 'tool_call', call: parsed.call });
        continue;
      }
      buf.emitted = true;
      out.push({
        type: 'warning',
        message: incompleteToolCallMessage(buf),
        provider: providerId,
      });
    }
    return out;
  }

  private bufferFor(delta: OpenAIToolCallDelta): BufferedToolCall {
    if (delta.id) {
      const existingKey = this.idToKey.get(delta.id);
      if (existingKey) {
        const existing = this.calls.get(existingKey);
        if (existing) return existing;
      }
    }
    if (typeof delta.index === 'number') {
      const key = `index:${delta.index}`;
      const existing = this.calls.get(key);
      if (existing) return existing;
      const created: BufferedToolCall = {
        key,
        index: delta.index,
        arguments: '',
        emitted: false,
      };
      this.calls.set(key, created);
      return created;
    }
    const key = `anon:${this.calls.size}`;
    const created: BufferedToolCall = { key, arguments: '', emitted: false };
    this.calls.set(key, created);
    return created;
  }
}

function parseCompleteToolCall(
  buf: BufferedToolCall,
): { ok: true; call: ToolCallRequest } | { ok: false } {
  const name = buf.name?.trim();
  const id = buf.id?.trim();
  if (!name || !id) return { ok: false };

  const raw = buf.arguments.trim();
  if (raw.length === 0) {
    return { ok: true, call: { id, toolId: name, arguments: {} } };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return { ok: false };
    return { ok: true, call: { id, toolId: name, arguments: parsed } };
  } catch {
    return { ok: false };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function incompleteToolCallMessage(buf: BufferedToolCall): string {
  const label = buf.name ?? buf.id ?? (buf.index != null ? `index ${buf.index}` : 'unknown');
  return `Dropped incomplete tool call (${label}); streamed arguments were not structurally complete.`;
}

interface AnthropicBufferedTool {
  index: number;
  id?: string;
  name?: string;
  json: string;
  emitted: boolean;
}

/**
 * Assembles Anthropic `input_json_delta` fragments. Never parse or execute
 * a tool call until the JSON object is structurally complete.
 */
export class AnthropicToolCallAssembler {
  private readonly blocks = new Map<number, AnthropicBufferedTool>();

  start(index: number, block: { type?: string; id?: string; name?: string }): void {
    if (block.type && block.type !== 'tool_use') return;
    this.blocks.set(index, {
      index,
      id: block.id,
      name: block.name,
      json: '',
      emitted: false,
    });
  }

  ingestDelta(index: number, delta: { type?: string; partial_json?: string }): void {
    if (delta.type !== 'input_json_delta') return;
    const buf = this.blocks.get(index) ?? {
      index,
      json: '',
      emitted: false,
    };
    if (typeof delta.partial_json === 'string') buf.json += delta.partial_json;
    this.blocks.set(index, buf);
  }

  finishBlock(index: number, providerId: string): StreamChunk[] {
    const buf = this.blocks.get(index);
    if (!buf || buf.emitted) return [];
    return this.emit(buf, providerId);
  }

  finish(providerId: string): StreamChunk[] {
    const out: StreamChunk[] = [];
    for (const buf of this.blocks.values()) {
      if (buf.emitted) continue;
      out.push(...this.emit(buf, providerId));
    }
    return out;
  }

  private emit(buf: AnthropicBufferedTool, providerId: string): StreamChunk[] {
    buf.emitted = true;
    const name = buf.name?.trim();
    const id = buf.id?.trim();
    if (!name || !id) {
      return [
        {
          type: 'warning',
          message: `Dropped incomplete tool call (${name ?? id ?? `index ${buf.index}`}); streamed arguments were not structurally complete.`,
          provider: providerId,
        },
      ];
    }
    const raw = buf.json.trim();
    if (raw.length === 0) {
      return [{ type: 'tool_call', call: { id, toolId: name, arguments: {} } }];
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isPlainObject(parsed)) {
        return [
          {
            type: 'warning',
            message: `Dropped incomplete tool call (${name}); streamed arguments were not structurally complete.`,
            provider: providerId,
          },
        ];
      }
      return [{ type: 'tool_call', call: { id, toolId: name, arguments: parsed } }];
    } catch {
      return [
        {
          type: 'warning',
          message: `Dropped incomplete tool call (${name}); streamed arguments were not structurally complete.`,
          provider: providerId,
        },
      ];
    }
  }
}

export interface GeminiFunctionCallPart {
  name?: string;
  args?: unknown;
  /** Provider-supplied call id when present; never used as a name-only key. */
  id?: string;
}

interface GeminiBufferedTool {
  key: string;
  providerId?: string;
  ordinal: number;
  partIndex: number;
  name?: string;
  argsJson: string;
  argsObject: Record<string, unknown>;
  hasObjectArgs: boolean;
  emitted: boolean;
}

/**
 * Assembles Gemini `functionCall` parts that may arrive split across SSE
 * events (name first, args later, or JSON-string fragments).
 *
 * Identity is the provider call id, else part index + call ordinal.
 * Function name alone is never a key — two calls to the same function stay distinct.
 */
export class GeminiFunctionCallAssembler {
  private readonly calls = new Map<string, GeminiBufferedTool>();
  private readonly idToKey = new Map<string, string>();
  private currentKey: string | null = null;
  private nextOrdinal = 0;

  ingest(part: { functionCall?: GeminiFunctionCallPart }, index = 0): void {
    const call = part.functionCall;
    if (!call) return;
    const buf = this.bufferFor(call, index);
    if (call.name) buf.name = call.name;
    if (typeof call.args === 'string') {
      buf.argsJson += call.args;
    } else if (isPlainObject(call.args)) {
      buf.hasObjectArgs = true;
      buf.argsObject = { ...buf.argsObject, ...call.args };
    }
    this.calls.set(buf.key, buf);
    this.currentKey = buf.key;
  }

  /**
   * Emit structurally complete calls and warnings for leftovers.
   * Call only at stream end — never per delta, and never before args are complete.
   */
  finish(providerId: string): StreamChunk[] {
    const out: StreamChunk[] = [];
    for (const buf of this.calls.values()) {
      if (buf.emitted) continue;
      buf.emitted = true;
      const name = buf.name?.trim();
      if (!name) {
        out.push({
          type: 'warning',
          message: 'Dropped incomplete tool call (unknown); streamed arguments were not structurally complete.',
          provider: providerId,
        });
        continue;
      }
      if (buf.argsJson.length > 0) {
        try {
          const parsed: unknown = JSON.parse(buf.argsJson);
          if (!isPlainObject(parsed)) {
            out.push({
              type: 'warning',
              message: `Dropped incomplete tool call (${name}); streamed arguments were not structurally complete.`,
              provider: providerId,
            });
            continue;
          }
          out.push({ type: 'tool_call', call: { id: this.emitId(buf), toolId: name, arguments: parsed } });
        } catch {
          out.push({
            type: 'warning',
            message: `Dropped incomplete tool call (${name}); streamed arguments were not structurally complete.`,
            provider: providerId,
          });
        }
        continue;
      }
      out.push({
        type: 'tool_call',
        call: {
          id: this.emitId(buf),
          toolId: name,
          arguments: buf.hasObjectArgs ? buf.argsObject : {},
        },
      });
    }
    return out;
  }

  private bufferFor(call: GeminiFunctionCallPart, partIndex: number): GeminiBufferedTool {
    const providerId = call.id?.trim();
    if (providerId) {
      const existingKey = this.idToKey.get(providerId);
      if (existingKey) {
        const existing = this.calls.get(existingKey);
        if (existing) return existing;
      }
      const created = this.createBuffer(`id:${providerId}`, partIndex, providerId);
      this.idToKey.set(providerId, created.key);
      return created;
    }

    const name = call.name?.trim();
    if (!name) {
      const byPartIndex = this.unfinishedAtPartIndex(partIndex);
      if (byPartIndex) return byPartIndex;
      if (this.currentKey) {
        const current = this.calls.get(this.currentKey);
        if (current && !current.emitted) return current;
      }
    }

    if (this.currentKey) {
      const current = this.calls.get(this.currentKey);
      if (
        current &&
        !current.emitted &&
        current.partIndex === partIndex &&
        !this.isStructurallyComplete(current) &&
        (!name || !current.name || current.name === name)
      ) {
        return current;
      }
    }

    return this.createBuffer(`part:${partIndex}:ord:${this.nextOrdinal}`, partIndex);
  }

  private unfinishedAtPartIndex(partIndex: number): GeminiBufferedTool | undefined {
    let found: GeminiBufferedTool | undefined;
    for (const buf of this.calls.values()) {
      if (buf.emitted || buf.partIndex !== partIndex) continue;
      if (this.isStructurallyComplete(buf)) continue;
      if (!found || buf.ordinal > found.ordinal) found = buf;
    }
    return found;
  }

  private createBuffer(key: string, partIndex: number, providerId?: string): GeminiBufferedTool {
    const ordinal = this.nextOrdinal;
    this.nextOrdinal += 1;
    const created: GeminiBufferedTool = {
      key,
      providerId,
      ordinal,
      partIndex,
      argsJson: '',
      argsObject: {},
      hasObjectArgs: false,
      emitted: false,
    };
    this.calls.set(key, created);
    return created;
  }

  private isStructurallyComplete(buf: GeminiBufferedTool): boolean {
    if (!buf.name?.trim()) return false;
    if (buf.argsJson.length > 0) {
      try {
        return isPlainObject(JSON.parse(buf.argsJson));
      } catch {
        return false;
      }
    }
    return buf.hasObjectArgs;
  }

  private emitId(buf: GeminiBufferedTool): string {
    return buf.providerId ?? `gcall:${buf.ordinal}`;
  }
}
