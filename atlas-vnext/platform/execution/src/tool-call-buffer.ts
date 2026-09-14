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
