import type { StreamChunk } from '@atlas-vnext/contracts';
import type { ExecutionContext } from './types.ts';

export type PriorToolResult = NonNullable<ExecutionContext['priorToolResults']>[number];

/** OpenAI/Anthropic function names: letters, digits, underscore, hyphen. */
const PROVIDER_TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export function toProviderToolName(toolId: string): string {
  if (PROVIDER_TOOL_NAME_RE.test(toolId)) return toolId;
  const aliased = toolId.replaceAll('.', '__');
  if (PROVIDER_TOOL_NAME_RE.test(aliased)) return aliased;
  return aliased.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function fromProviderToolName(name: string, knownIds: Iterable<string> = []): string {
  const ids = [...knownIds];
  if (ids.includes(name)) return name;
  const aliasedMatch = ids.find((id) => toProviderToolName(id) === name);
  if (aliasedMatch) return aliasedMatch;
  return name;
}

export function knownProviderToolIds(context: ExecutionContext): string[] {
  const ids = new Set<string>();
  for (const tool of context.tools ?? []) ids.add(tool.id);
  for (const row of context.priorToolResults ?? []) ids.add(row.toolId);
  return [...ids];
}

export function remapProviderToolChunks(chunks: Iterable<StreamChunk>, knownIds: Iterable<string>): StreamChunk[] {
  const ids = [...knownIds];
  return [...chunks].map((chunk) => {
    if (chunk.type !== 'tool_call') return chunk;
    return {
      ...chunk,
      call: {
        ...chunk.call,
        toolId: fromProviderToolName(chunk.call.toolId, ids),
      },
    };
  });
}

export type ToolRound = PriorToolResult[];

export function groupPriorToolRounds(results: ExecutionContext['priorToolResults']): ToolRound[] {
  if (!results?.length) return [];
  const grouped = new Map<number, ToolRound>();
  const order: number[] = [];
  for (const [index, row] of results.entries()) {
    const key = row.round ?? index;
    let bucket = grouped.get(key);
    if (!bucket) {
      bucket = [];
      grouped.set(key, bucket);
      order.push(key);
    }
    bucket.push(row);
  }
  return order.map((key) => grouped.get(key)!);
}

export function serializeToolResult(row: PriorToolResult): string {
  return JSON.stringify({
    status: row.status,
    output: row.output ?? null,
    resultRef: row.resultRef ?? null,
  });
}

export function openaiToolsFrom(context: ExecutionContext): Array<Record<string, unknown>> | null {
  if (!context.tools?.length) return null;
  return context.tools.map((tool) => ({
    type: 'function',
    function: {
      name: toProviderToolName(tool.id),
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

export type OpenAIChatMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export function openaiMessagesFrom(context: ExecutionContext): OpenAIChatMessage[] {
  const messages: OpenAIChatMessage[] = [];
  if (context.systemPrompt) messages.push({ role: 'system', content: context.systemPrompt });
  for (const turn of context.history ?? []) {
    if (turn.role === 'system') continue;
    if (turn.role === 'assistant') messages.push({ role: 'assistant', content: turn.content });
    else messages.push({ role: 'user', content: turn.content });
  }
  messages.push({ role: 'user', content: context.prompt });
  for (const round of groupPriorToolRounds(context.priorToolResults)) {
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: round.map((row) => ({
        id: row.callId,
        type: 'function',
        function: {
          name: toProviderToolName(row.toolId),
          arguments: JSON.stringify(row.arguments ?? {}),
        },
      })),
    });
    for (const row of round) {
      messages.push({
        role: 'tool',
        tool_call_id: row.callId,
        content: serializeToolResult(row),
      });
    }
  }
  return messages;
}

export function anthropicToolsFrom(context: ExecutionContext): Array<Record<string, unknown>> | null {
  if (!context.tools?.length) return null;
  return context.tools.map((tool) => ({
    name: toProviderToolName(tool.id),
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

export type AnthropicMessage =
  | { role: 'user'; content: string | AnthropicUserBlock[] }
  | { role: 'assistant'; content: string | AnthropicAssistantBlock[] };

export interface AnthropicAssistantBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicUserBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export function anthropicMessagesFrom(context: ExecutionContext): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];
  const push = (role: 'user' | 'assistant', content: string) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role && typeof last.content === 'string') {
      last.content = `${last.content}\n\n${content}`;
      return;
    }
    if (role === 'assistant') messages.push({ role: 'assistant', content });
    else messages.push({ role: 'user', content });
  };
  for (const turn of context.history ?? []) {
    if (turn.role === 'system') continue;
    push(turn.role === 'assistant' ? 'assistant' : 'user', turn.content);
  }
  push('user', context.prompt);
  for (const round of groupPriorToolRounds(context.priorToolResults)) {
    messages.push({
      role: 'assistant',
      content: round.map((row) => ({
        type: 'tool_use',
        id: row.callId,
        name: toProviderToolName(row.toolId),
        input: row.arguments ?? {},
      })),
    });
    messages.push({
      role: 'user',
      content: round.map((row) => ({
        type: 'tool_result',
        tool_use_id: row.callId,
        content: serializeToolResult(row),
      })),
    });
  }
  return messages;
}

export function geminiToolsFrom(context: ExecutionContext): Array<Record<string, unknown>> | null {
  if (!context.tools?.length) return null;
  return [
    {
      functionDeclarations: context.tools.map((tool) => ({
        name: toProviderToolName(tool.id),
        description: tool.description,
        parameters: tool.inputSchema,
      })),
    },
  ];
}

export interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export function geminiContentsFrom(context: ExecutionContext): GeminiContent[] {
  const contents: GeminiContent[] = [];
  const firstParts: GeminiPart[] = [];
  if (context.systemPrompt) firstParts.push({ text: context.systemPrompt });
  for (const turn of context.history ?? []) {
    if (turn.role === 'system') {
      firstParts.push({ text: turn.content });
      continue;
    }
    if (firstParts.length && contents.length === 0) {
      contents.push({ role: 'user', parts: [...firstParts] });
      firstParts.length = 0;
    }
    contents.push({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: turn.content }],
    });
  }
  firstParts.push({ text: context.prompt });
  contents.push({ role: 'user', parts: firstParts.length ? firstParts : [{ text: context.prompt }] });
  for (const round of groupPriorToolRounds(context.priorToolResults)) {
    contents.push({
      role: 'model',
      parts: round.map((row) => ({
        functionCall: {
          name: toProviderToolName(row.toolId),
          args: row.arguments ?? {},
          id: row.callId,
        },
      })),
    });
    contents.push({
      role: 'user',
      parts: round.map((row) => ({
        functionResponse: {
          name: toProviderToolName(row.toolId),
          id: row.callId,
          response: {
            status: row.status,
            output: row.output ?? null,
            resultRef: row.resultRef ?? null,
          },
        },
      })),
    });
  }
  return contents;
}
