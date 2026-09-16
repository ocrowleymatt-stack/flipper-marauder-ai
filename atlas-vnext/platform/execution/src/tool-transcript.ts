import type { ExecutionContext } from './types.ts';

export type PriorToolResult = NonNullable<ExecutionContext['priorToolResults']>[number];

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
      name: tool.id,
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
      tool_calls: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export function openaiMessagesFrom(context: ExecutionContext): OpenAIChatMessage[] {
  const messages: OpenAIChatMessage[] = [];
  if (context.systemPrompt) messages.push({ role: 'system', content: context.systemPrompt });
  messages.push({ role: 'user', content: context.prompt });
  for (const round of groupPriorToolRounds(context.priorToolResults)) {
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: round.map((row) => ({
        id: row.callId,
        type: 'function',
        function: {
          name: row.toolId,
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
    name: tool.id,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

export type AnthropicMessage =
  | { role: 'user'; content: string | AnthropicUserBlock[] }
  | { role: 'assistant'; content: AnthropicAssistantBlock[] };

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
  const messages: AnthropicMessage[] = [{ role: 'user', content: context.prompt }];
  for (const round of groupPriorToolRounds(context.priorToolResults)) {
    messages.push({
      role: 'assistant',
      content: round.map((row) => ({
        type: 'tool_use',
        id: row.callId,
        name: row.toolId,
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
        name: tool.id,
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
  const firstParts: GeminiPart[] = [];
  if (context.systemPrompt) firstParts.push({ text: context.systemPrompt });
  firstParts.push({ text: context.prompt });
  const contents: GeminiContent[] = [{ role: 'user', parts: firstParts }];
  for (const round of groupPriorToolRounds(context.priorToolResults)) {
    contents.push({
      role: 'model',
      parts: round.map((row) => ({
        functionCall: {
          name: row.toolId,
          args: row.arguments ?? {},
          id: row.callId,
        },
      })),
    });
    contents.push({
      role: 'user',
      parts: round.map((row) => ({
        functionResponse: {
          name: row.toolId,
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
