import { randomUUID } from 'node:crypto';
import type { DomainEvent, EventPublishInput } from './types.ts';

export type {
  DomainEvent,
  EventBus,
  EventPublishInput,
  EventReplayCursor,
} from './types.ts';
export { EventsNotImplementedError } from './types.ts';
export { MemoryEventBus } from './memory.ts';

export function createEvent(
  partial: EventPublishInput,
  now = () => new Date().toISOString(),
): DomainEvent {
  return {
    eventId: partial.eventId ?? `evt_${randomUUID()}`,
    timestamp: now(),
    channel: partial.channel,
    type: partial.type,
    payload: partial.payload,
    seq: 0,
    tenantId: partial.tenantId,
    workspaceId: partial.workspaceId ?? null,
    conversationId: partial.conversationId ?? null,
    jobId: partial.jobId ?? null,
    idempotencyKey: partial.idempotencyKey ?? null,
  };
}
