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
    const messages =
      next.role === 'user' ? snapshot.messages.filter((item) => !item.id.startsWith('local_user_')) : snapshot.messages;
    snapshot = { ...snapshot, messages: upsertMessage(messages, next) };
  }

  const applyChunk = (chunk: string, ids: { messageId?: string | null; executionId?: string | null }) => {
    if (!chunk || sealedResponse) return;
    // Runtime emits paired assistant.delta + message.delta with the same chunk.
    if (lastStreamedText === chunk) {
      lastStreamedText = null;
      return;
    }
    snapshot = appendAssistantText(snapshot, chunk, ids);
    lastStreamedText = chunk;
  };

  if (event.type === 'message.delta' && typeof event.messageId === 'string' && typeof event.content === 'string') {
    applyChunk(event.content, {
      messageId: event.messageId,
      executionId: field(event, 'executionId'),
    });
  }

  if (event.type === 'assistant.delta' && typeof event.text === 'string') {
    applyChunk(event.text, {
      messageId: field(event, 'messageId'),
      executionId: field(event, 'executionId') ?? snapshot.executions.at(-1)?.id ?? null,
    });
    waitLabel = null;
  }

  if (event.type === 'assistant.completed') {
    waitLabel = null;
    const completedText = typeof event.text === 'string' ? event.text : '';
    if (completedText) {
      const assistant = lastAssistant(snapshot.messages);
      if (assistant && (!assistant.content || completedText.startsWith(assistant.content))) {
        snapshot = {
          ...snapshot,
          messages: snapshot.messages.map((item) => (item.id === assistant.id ? { ...item, content: completedText } : item)),
        };
      } else if (!assistant) {
        snapshot = appendAssistantText(snapshot, completedText, {
          executionId: field(event, 'executionId') ?? snapshot.executions.at(-1)?.id ?? null,
        });
      }
    }
  }

  if (event.type === 'message.delta') {
    waitLabel = null;
  }

  if (event.type === 'execution' && event.execution) {
    const next = event.execution as ExecutionRecord;
    const previousLatest = snapshot.executions.at(-1);
    snapshot = { ...snapshot, executions: upsert(snapshot.executions, next) };
    if (!previousLatest || previousLatest.id !== next.id) {
      sealedResponse = false;
      classifiedFailure = null;
      lastStreamedText = null;
      waitLabel = waitLabel ?? 'Generating…';
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
    classifiedFailure = String((event.failure as { failure?: { message?: string }; message?: string }).message);
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

function appendAssistantText(
  snapshot: ConversationSnapshot,
  text: string,
  ids: { messageId?: string | null; executionId?: string | null },
): ConversationSnapshot {
  const messages = snapshot.messages;
  const target =
    (ids.messageId ? messages.find((item) => item.id === ids.messageId) : undefined) ?? lastAssistant(messages);
  if (target) {
    return {
      ...snapshot,
      messages: messages.map((item) => (item.id === target.id ? { ...item, content: `${item.content}${text}` } : item)),
    };
  }
  const created: Message = {
    id: ids.messageId || `local_assistant_${ids.executionId || 'stream'}`,
    urn: '',
    conversationId: snapshot.conversation.id,
    role: 'assistant',
    content: text,
    sequence: (messages.at(-1)?.sequence ?? 0) + 1,
    executionId: ids.executionId ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return { ...snapshot, messages: [...messages, created] };
}

function upsert<T extends { id: string }>(items: T[], next: T): T[] {
  return items.some((item) => item.id === next.id)
    ? items.map((item) => (item.id === next.id ? next : item))
    : [...items, next];
}

function upsertMessage(items: Message[], next: Message): Message[] {
  const existing = items.find((item) => item.id === next.id);
  if (!existing) return [...items, next];
  const content = next.content ? next.content : existing.content;
  return items.map((item) => (item.id === next.id ? { ...next, content } : item));
}

export function liveExecution(
  busy: boolean,
  snapshotExecution: ExecutionRecord | null | undefined,
  inspectedExecution: ExecutionRecord | null | undefined,
): ExecutionRecord | null {
  if (busy && snapshotExecution && snapshotExecution.status !== 'completed' && snapshotExecution.status !== 'failed' && snapshotExecution.status !== 'cancelled') {
    return snapshotExecution;
  }
  if (busy && snapshotExecution && inspectedExecution && snapshotExecution.id !== inspectedExecution.id) {
    return snapshotExecution;
  }
  return inspectedExecution ?? snapshotExecution ?? null;
}

export function executionToStop(
  busy: boolean,
  snapshotExecution: ExecutionRecord | null | undefined,
): ExecutionRecord | null {
  if (!busy || !snapshotExecution) return null;
  if (snapshotExecution.status === 'running' || snapshotExecution.status === 'queued') return snapshotExecution;
  return null;
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

export function doctorTone(state: string | null | undefined, checks: Array<{ id: string; state: string }> = []): {
  label: 'Healthy' | 'Attention' | 'Problem';
  tone: 'ok' | 'attention' | 'problem';
} {
  const normalised = (state ?? '').toLowerCase();
  const provider = checks.find((item) => item.id === 'providers');
  const requiredBroken = checks.some(
    (item) =>
      (item.id === 'postgres' || item.id === 'cas' || item.id === 'jobs' || item.id === 'architecture') &&
      /error|failed|down|unhealthy/i.test(item.state),
  );
  if (requiredBroken || /error|failed|problem|critical/.test(normalised)) {
    return { label: 'Problem', tone: 'problem' };
  }
  if (normalised.includes('attention') || provider?.state === 'error' || /unhealthy|degraded/.test(normalised)) {
    return { label: 'Attention', tone: 'attention' };
  }
  return { label: 'Healthy', tone: 'ok' };
}

export function visibleAssistantText(messages: Array<{ role: string; content: string }>): string {
  return messages
    .filter((item) => item.role === 'assistant')
    .map((item) => item.content)
    .join('\n');
}

export function approvalAuthorityLine(tool: {
  risk: string;
  sideEffectClass: string;
  requiredCapabilities: string[];
}): string {
  const caps = tool.requiredCapabilities.length > 0 ? tool.requiredCapabilities.join(', ') : 'none';
  return `Risk ${tool.risk} · ${tool.sideEffectClass} · Authority ${caps}`;
}
