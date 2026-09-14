import type { ConversationSnapshot, ExecutionRecord, Message, StreamEvent } from './api';

export interface StreamView {
  snapshot: ConversationSnapshot;
  waitLabel: string | null;
  sealedResponse: boolean;
  classifiedFailure: string | null;
}

export function applyStream(view: StreamView, conversationId: string, event: StreamEvent, waitFrom: (message: string) => string | null): StreamView {
  if (view.snapshot.conversation.id !== conversationId) return view;
  let snapshot = view.snapshot;
  let waitLabel = view.waitLabel;
  let sealedResponse = view.sealedResponse;
  let classifiedFailure = view.classifiedFailure;

  if (event.type === 'message' && event.message && typeof event.message === 'object' && 'id' in event.message) {
    const next = event.message as Message;
    snapshot = { ...snapshot, messages: upsert(snapshot.messages, next) };
  }
  if (event.type === 'message.delta' && typeof event.messageId === 'string' && typeof event.content === 'string') {
    if (sealedResponse) {
      return { snapshot, waitLabel, sealedResponse, classifiedFailure };
    }
    snapshot = {
      ...snapshot,
      messages: snapshot.messages.map((item) => (item.id === event.messageId ? { ...item, content: event.content as string } : item)),
    };
  }
  if (event.type === 'assistant.delta' || event.type === 'assistant.completed' || event.type === 'message.delta') {
    waitLabel = null;
  }
  if (event.type === 'execution' && event.execution) {
    const next = event.execution as ExecutionRecord;
    snapshot = { ...snapshot, executions: upsert(snapshot.executions, next) };
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
  return { snapshot, waitLabel, sealedResponse, classifiedFailure };
}

function upsert<T extends { id: string }>(items: T[], next: T): T[] {
  return items.some((item) => item.id === next.id) ? items.map((item) => (item.id === next.id ? next : item)) : [...items, next];
}

export function emptyView(conversation: ConversationSnapshot['conversation']): StreamView {
  return {
    snapshot: { conversation, messages: [], executions: [] },
    waitLabel: null,
    sealedResponse: false,
    classifiedFailure: null,
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
