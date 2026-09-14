export type Capability = 'nexus/fast' | 'nexus/reason';

export interface Conversation {
  id: string;
  urn: string;
  title: string;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  urn: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  sequence: number;
  executionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionAttempt {
  index: number;
  provider: string;
  model: string;
  outcome: string;
  emittedVisibleOutput: boolean;
  error: { code: string; message: string } | null;
}

export interface ExecutionRecord {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  capability: string;
  selectedProvider: string | null;
  selectedModel: string | null;
  attempts: ExecutionAttempt[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  failureReason: { code: string; message: string } | null;
  route: { target: string; resolvedRouteId: string; decisionReason: string } | null;
}

export interface ConversationSnapshot {
  conversation: Conversation;
  messages: Message[];
  executions: ExecutionRecord[];
}

export type StreamEvent =
  | { type: 'message'; message: Message }
  | { type: 'message.delta'; messageId: string; content: string }
  | { type: 'execution'; execution: ExecutionRecord }
  | { type: 'error'; failure: { code: string; message: string } }
  | { type: 'done' }
  | { type: 'execution.started'; executionId: string; capability: string }
  | { type: 'attempt.started'; executionId: string; provider: string; model: string }
  | { type: 'attempt.failed'; failure: { message: string }; emittedVisibleOutput: boolean }
  | { type: 'assistant.delta'; text: string }
  | { type: 'assistant.completed'; text: string }
  | { type: 'provider.warning'; message: string; provider?: string }
  | { type: 'provider.failed'; failure: { message: string } }
  | { type: 'execution.failed'; failure: { code: string; message: string } }
  | { type: 'execution.completed'; provider: string | null; model: string | null }
  | { type: string; [key: string]: unknown };

export function runtimeWaitingLabel(message: string | null | undefined): string | null {
  if (!message) return null;
  if (/gpu runtime starting|waiting_runtime|pod_starting|warming|starting the shared/i.test(message)) {
    return 'GPU runtime starting';
  }
  if (/waiting for (the )?shared gpu|pod_busy|profile_change/i.test(message)) {
    return 'Waiting for the shared GPU';
  }
  return message;
}

const jsonHeaders = { 'content-type': 'application/json' };

export async function listConversations(): Promise<Conversation[]> {
  const response = await fetch('/api/conversations');
  if (!response.ok) throw new Error(await readError(response));
  return response.json() as Promise<Conversation[]>;
}

export async function createConversation(title?: string): Promise<Conversation> {
  const response = await fetch('/api/conversations', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(title ? { title } : {}),
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.json() as Promise<Conversation>;
}

export async function getSnapshot(id: string): Promise<ConversationSnapshot> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(await readError(response));
  return response.json() as Promise<ConversationSnapshot>;
}

export async function* sendMessage(
  conversationId: string,
  content: string,
  capability: Capability,
): AsyncGenerator<StreamEvent> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ content, capability }),
  });
  if (!response.ok || !response.body) {
    throw new Error(await readError(response));
  }
  yield* parseSse(response.body);
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? response.statusText;
  } catch {
    return response.statusText;
  }
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const event = decodeFrame(chunk);
      if (event) yield event;
    }
    if (done) {
      const event = decodeFrame(buffer);
      if (event) yield event;
      break;
    }
  }
}

function decodeFrame(chunk: string): StreamEvent | null {
  let data = '';
  for (const line of chunk.split('\n')) {
    if (line.startsWith('data: ')) data += line.slice(6);
  }
  if (!data) return null;
  return JSON.parse(data) as StreamEvent;
}
