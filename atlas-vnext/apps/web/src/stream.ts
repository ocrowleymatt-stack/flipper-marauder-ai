import type { ConversationSnapshot, ExecutionRecord, Message, StreamEvent } from './api';

export interface StreamView {
  snapshot: ConversationSnapshot;
  waitLabel: string | null;
  sealedResponse: boolean;
  classifiedFailure: string | null;
  lastStreamedText: string | null;
}

export function applyStream(
  view: StreamView,
  conversationId: string,
  event: StreamEvent,
  waitFrom: (message: string) => string | null,
): StreamView {
  if (view.snapshot.conversation.id !== conversationId) return view;
  let snapshot = view.snapshot;
  let waitLabel = view.waitLabel;
  let sealedResponse = view.sealedResponse;
  let classifiedFailure = view.classifiedFailure;
  let lastStreamedText = view.lastStreamedText;

  if (event.type === 'message' && event.message && typeof event.message === 'object' && 'id' in event.message) {
    const next = event.message as Message;
    snapshot = { ...snapshot, messages: upsertMessage(snapshot.messages, next) };
  }

  if (event.type === 'message.delta' && typeof event.messageId === 'string' && typeof event.content === 'string') {
    waitLabel = null;
    if (sealedResponse) {
      return { snapshot, waitLabel, sealedResponse, classifiedFailure, lastStreamedText };
    }
    const applied = applyTextChunk(snapshot, event.content, lastStreamedText, conversationId, event.messageId, null);
    snapshot = applied.snapshot;
    lastStreamedText = applied.lastStreamedText;
  }

  if (event.type === 'assistant.delta' && typeof (event as { text?: unknown }).text === 'string') {
    const text = String((event as { text: string }).text);
    waitLabel = null;
    if (!sealedResponse) {
      const executionId = typeof event.executionId === 'string' ? event.executionId : null;
      const applied = applyTextChunk(snapshot, text, lastStreamedText, conversationId, undefined, executionId);
      snapshot = applied.snapshot;
      lastStreamedText = applied.lastStreamedText;
    }
  }

  if (event.type === 'assistant.completed') {
    waitLabel = null;
    const full = typeof (event as { text?: unknown }).text === 'string' ? String((event as { text: string }).text) : '';
    if (full && !sealedResponse) {
      const executionId = typeof event.executionId === 'string' ? event.executionId : null;
      snapshot = { ...snapshot, messages: completeAssistant(snapshot.messages, full, conversationId, executionId) };
    }
  }

  if (event.type === 'execution' && event.execution) {
    const next = event.execution as ExecutionRecord;
    const previousLatest = snapshot.executions.at(-1);
    snapshot = { ...snapshot, executions: upsert(snapshot.executions, next) };
    if (!previousLatest || previousLatest.id !== next.id) {
      sealedResponse = false;
      classifiedFailure = null;
      waitLabel = null;
      lastStreamedText = null;
    }
    if (next.status === 'failed' && next.failureReason) {
      classifiedFailure = next.failureReason.message;
      if (next.attempts.some((attempt) => attempt.emittedVisibleOutput)) {
        sealedResponse = true;
      }
    }
    if (next.status === 'completed' || next.status === 'cancelled') {
      waitLabel = null;
    }
  }
  if (event.type === 'execution.started' && typeof event.executionId === 'string') {
    const latest = snapshot.executions.at(-1);
    if (!latest || latest.id !== event.executionId) {
      sealedResponse = false;
      classifiedFailure = null;
      lastStreamedText = null;
    }
  }
  if (event.type === 'attempt.failed') {
    const visible = Boolean(event.emittedVisibleOutput);
    if (visible) {
      sealedResponse = true;
      classifiedFailure =
        typeof event.failure === 'object' && event.failure && 'message' in event.failure
          ? String((event.failure as { message: string }).message)
          : 'The provider failed after visible output. Atlas did not switch providers mid-reply.';
    }
  }
  if (event.type === 'error' && event.failure && typeof event.failure === 'object' && 'message' in event.failure) {
    classifiedFailure = String((event.failure as { message: string }).message);
  }
  if (event.type === 'provider.warning' && typeof event.message === 'string') {
    waitLabel = waitFrom(event.message);
  }
  if (event.type === 'execution.failed' && event.failure && typeof event.failure === 'object' && 'message' in event.failure) {
    classifiedFailure = String((event.failure as { message: string }).message);
  }
  return { snapshot, waitLabel, sealedResponse, classifiedFailure, lastStreamedText };
}

function upsert<T extends { id: string }>(items: T[], next: T): T[] {
  return items.some((item) => item.id === next.id) ? items.map((item) => (item.id === next.id ? next : item)) : [...items, next];
}

function upsertMessage(items: Message[], next: Message): Message[] {
  const existing = items.find((item) => item.id === next.id);
  if (!existing) return [...items, next];
  const content = mergeContent(existing.content, next.content);
  return items.map((item) => (item.id === next.id ? { ...next, content } : item));
}

function mergeContent(existing: string, incoming: string): string {
  if (!incoming) return existing;
  if (!existing) return incoming;
  if (incoming.startsWith(existing) || existing.startsWith(incoming)) {
    return incoming.length >= existing.length ? incoming : existing;
  }
  return incoming;
}

/**
 * Runtime emits paired `assistant.delta` + `message.delta` with the same chunk.
 * Apply the first, ignore the immediate duplicate, keep later identical tokens.
 */
function applyTextChunk(
  snapshot: ConversationSnapshot,
  chunk: string,
  lastStreamedText: string | null,
  conversationId: string,
  messageId?: string,
  executionId?: string | null,
): { snapshot: ConversationSnapshot; lastStreamedText: string | null } {
  if (!chunk) return { snapshot, lastStreamedText };
  if (lastStreamedText === chunk) {
    return { snapshot, lastStreamedText: null };
  }
  const messages = snapshot.messages;
  const targetId =
    messageId ??
    [...messages]
      .reverse()
      .find((item) => item.role === 'assistant' && (!executionId || item.executionId === executionId || !item.executionId))
      ?.id;
  if (targetId && messages.some((item) => item.id === targetId)) {
    return {
      snapshot: {
        ...snapshot,
        messages: messages.map((item) => (item.id === targetId ? { ...item, content: `${item.content}${chunk}` } : item)),
      },
      lastStreamedText: chunk,
    };
  }
  return {
    snapshot: {
      ...snapshot,
      messages: [...messages, stubAssistantMessage(conversationId, chunk, executionId ?? null, targetId)],
    },
    lastStreamedText: chunk,
  };
}

function completeAssistant(
  messages: Message[],
  full: string,
  conversationId: string,
  executionId: string | null,
): Message[] {
  const latest = [...messages].reverse().find((item) => item.role === 'assistant');
  if (!latest) {
    return [...messages, stubAssistantMessage(conversationId, full, executionId)];
  }
  const content = mergeContent(latest.content, full);
  return messages.map((item) => (item.id === latest.id ? { ...item, content } : item));
}

function stubAssistantMessage(
  conversationId: string,
  content: string,
  executionId: string | null,
  id?: string,
): Message {
  const messageId = id ?? `msg_stream_${conversationId}`;
  const now = new Date().toISOString();
  return {
    id: messageId,
    urn: `urn:atlas:message:${messageId}`,
    conversationId,
    role: 'assistant',
    content,
    sequence: 0,
    executionId,
    createdAt: now,
    updatedAt: now,
  };
}

export function conversationStub(
  id: string,
  projectId: string | null,
  existing?: ConversationSnapshot['conversation'] | null,
): ConversationSnapshot['conversation'] {
  return {
    id,
    urn: existing?.urn ?? `urn:atlas:conversation:${id}`,
    title: existing?.title ?? 'Conversation',
    projectId: existing?.projectId ?? projectId,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: existing?.updatedAt ?? new Date().toISOString(),
  };
}

export function ensureView(
  current: StreamView | null,
  conversationId: string,
  fallback: ConversationSnapshot['conversation'],
): StreamView {
  if (current && current.snapshot.conversation.id === conversationId) {
    return { ...current, sealedResponse: false, classifiedFailure: null, waitLabel: null };
  }
  return emptyView(conversationStub(conversationId, fallback.projectId ?? null, fallback));
}

export function emptyView(conversation: ConversationSnapshot['conversation']): StreamView {
  return {
    snapshot: { conversation, messages: [], executions: [] },
    waitLabel: null,
    sealedResponse: false,
    classifiedFailure: null,
    lastStreamedText: null,
  };
}

export function viewFromSnapshot(snapshot: ConversationSnapshot): StreamView {
  const latest = snapshot.executions.at(-1);
  const sealed =
    latest?.status === 'failed' && latest.attempts.some((attempt) => attempt.emittedVisibleOutput);
  return {
    snapshot,
    waitLabel: null,
    sealedResponse: Boolean(sealed),
    classifiedFailure: latest?.failureReason?.message ?? null,
    lastStreamedText: null,
  };
}

export function runStatusLabel(status: string | undefined, awaitingApproval: boolean): string {
  if (awaitingApproval) return 'awaiting approval';
  switch (status) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'interrupted';
    default:
      return status || 'idle';
  }
}

export function userRunLabel(
  status: string | undefined,
  awaitingApproval: boolean,
  busy: boolean,
): string {
  if (awaitingApproval) return 'Needs approval';
  if (busy && (status === 'running' || status === 'queued' || !status)) return 'Working';
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Working';
    case 'completed':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Stopped';
    default:
      return busy ? 'Working' : 'Ready';
  }
}

export function capabilityLabel(id: string | undefined): string {
  if (!id) return 'Fast';
  switch (id) {
    case 'nexus/fast':
      return 'Fast';
    case 'nexus/reason':
      return 'Reason';
    case 'nexus/code':
      return 'Code';
    case 'nexus/cheap':
      return 'Cheap';
    case 'nexus/local':
      return 'Local';
    case 'nexus/vision':
      return 'Vision';
    case 'nexus/frontier':
      return 'Frontier';
    default:
      return id.replace(/^nexus\//, '');
  }
}
