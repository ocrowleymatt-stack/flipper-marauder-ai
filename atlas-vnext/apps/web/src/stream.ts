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
  let lastStreamedText = view.lastStreamedText ?? null;

  if (event.type === 'message' && event.message && typeof event.message === 'object' && 'id' in event.message) {
    const next = event.message as Message;
    const base =
      next.role === 'user' ? snapshot.messages.filter((item) => !item.id.startsWith('local_user_')) : snapshot.messages;
    snapshot = { ...snapshot, messages: upsertMessage(base, next) };
  }

  if (event.type === 'message.delta' && typeof event.messageId === 'string' && typeof event.content === 'string') {
    waitLabel = null;
    if (!sealedResponse) {
      const applied = applyTextChunk(snapshot, event.content, lastStreamedText, conversationId, event.messageId, field(event, 'executionId'));
      snapshot = applied.snapshot;
      lastStreamedText = applied.lastStreamedText;
    }
  }

  if (event.type === 'assistant.delta' && typeof event.text === 'string') {
    waitLabel = null;
    if (!sealedResponse) {
      const applied = applyTextChunk(
        snapshot,
        event.text,
        lastStreamedText,
        conversationId,
        field(event, 'messageId'),
        field(event, 'executionId') ?? snapshot.executions.at(-1)?.id ?? null,
      );
      snapshot = applied.snapshot;
      lastStreamedText = applied.lastStreamedText;
    }
  }

  if (event.type === 'assistant.completed') {
    waitLabel = null;
    const full = typeof event.text === 'string' ? event.text : '';
    if (full && !sealedResponse) {
      snapshot = {
        ...snapshot,
        messages: completeAssistant(snapshot.messages, full, conversationId, field(event, 'executionId') ?? snapshot.executions.at(-1)?.id ?? null),
      };
    }
  }

  if (event.type === 'execution' && event.execution) {
    const next = event.execution as ExecutionRecord;
    const previousLatest = snapshot.executions.at(-1);
    snapshot = { ...snapshot, executions: upsert(snapshot.executions, next) };
    if (!previousLatest || previousLatest.id !== next.id) {
      sealedResponse = false;
      classifiedFailure = null;
      waitLabel = waitLabel ?? 'Generating…';
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
    if (!waitLabel) waitLabel = 'Generating…';
  }
  if (event.type === 'attempt.started') {
    if (!lastAssistant(snapshot.messages)?.content) waitLabel = waitLabel ?? 'Generating…';
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

function field(event: StreamEvent, key: string): string | null {
  if (!event || typeof event !== 'object') return null;
  const value = (event as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function lastAssistant(messages: Message[]): Message | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') return messages[index];
  }
  return undefined;
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
  messageId?: string | null,
  executionId?: string | null,
): { snapshot: ConversationSnapshot; lastStreamedText: string | null } {
  if (!chunk) return { snapshot, lastStreamedText };
  if (lastStreamedText === chunk) {
    return { snapshot, lastStreamedText: null };
  }
  const messages = snapshot.messages;
  const target =
    (messageId ? messages.find((item) => item.id === messageId) : undefined) ??
    lastAssistant(messages.filter((item) => !executionId || item.executionId === executionId || !item.executionId));
  if (target) {
    return {
      snapshot: {
        ...snapshot,
        messages: messages.map((item) => (item.id === target.id ? { ...item, content: `${item.content}${chunk}` } : item)),
      },
      lastStreamedText: chunk,
    };
  }
  return {
    snapshot: {
      ...snapshot,
      messages: [...messages, stubAssistantMessage(conversationId, chunk, executionId ?? null, messageId)],
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
  const latest = lastAssistant(messages);
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
  id?: string | null,
): Message {
  const messageId = id || `local_assistant_${executionId || conversationId}`;
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
  current: StreamView | null | undefined,
  conversationId: string,
  fallback: ConversationSnapshot['conversation'],
): StreamView {
  if (current && current.snapshot.conversation.id === conversationId) {
    return { ...current, sealedResponse: false, classifiedFailure: null };
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
  const sealed = latest?.status === 'failed' && latest.attempts.some((attempt) => attempt.emittedVisibleOutput);
  return {
    snapshot,
    waitLabel: null,
    sealedResponse: Boolean(sealed),
    classifiedFailure: latest?.failureReason?.message ?? null,
    lastStreamedText: null,
  };
}

export function runStatusLabel(status: string | undefined, awaitingApproval: boolean): string {
  if (awaitingApproval) return 'Waiting for approval';
  switch (status) {
    case 'queued':
    case 'running':
      return 'Generating…';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Stopped';
    default:
      return status || 'Ready';
  }
}

export function userRunLabel(status: string | undefined, awaitingApproval: boolean, busy: boolean): string {
  if (awaitingApproval) return 'Waiting for approval';
  if (busy) return 'Generating…';
  return runStatusLabel(status, false);
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

export function conversationDisplayTitle(title: string | null | undefined, fallback = 'New conversation'): string {
  const trimmed = title?.replace(/\s+/g, ' ').trim() ?? '';
  if (!trimmed || /^new conversation$/i.test(trimmed) || trimmed === 'Untitled') return fallback;
  return trimmed;
}

export function ellipsize(value: string, limit = 52): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, limit - 1).trimEnd()}…`;
}

export function doctorTone(
  state: string | null | undefined,
  checks: Array<{ id: string; state: string; summary?: string }> = [],
): {
  label: 'Healthy' | 'Attention' | 'Problem';
  tone: 'ok' | 'attention' | 'problem';
} {
  const normalised = (state ?? '').toLowerCase();
  const requiredBroken = checks.some(
    (item) =>
      (item.id === 'postgres' || item.id === 'cas' || item.id === 'jobs' || item.id === 'architecture') &&
      /error|failed|down|unhealthy/i.test(item.state),
  );
  if (requiredBroken || /critical|problem/.test(normalised) || normalised === 'failed') {
    return { label: 'Problem', tone: 'problem' };
  }
  const failing = checks.filter((item) => item.state === 'error' || item.state === 'warn');
  const optionalOnly =
    failing.length > 0 &&
    failing.every((item) => /ollama|optional|providers/i.test(`${item.id} ${item.summary ?? ''}`));
  if (optionalOnly || normalised.includes('attention') || /unhealthy|degraded/.test(normalised)) {
    return { label: 'Attention', tone: 'attention' };
  }
  if (normalised.includes('error') && !optionalOnly) {
    return { label: 'Problem', tone: 'problem' };
  }
  return { label: 'Healthy', tone: 'ok' };
}

export function visibleAssistantText(messages: Array<{ role: string; content: string }>): string {
  return messages
    .filter((item) => item.role === 'assistant')
    .map((item) => item.content)
    .join('\n');
}
