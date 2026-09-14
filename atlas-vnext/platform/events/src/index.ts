import { randomUUID } from 'node:crypto';
import type { DomainEvent, EventBus } from './types.ts';

export type { DomainEvent, EventBus } from './types.ts';
export { EventsNotImplementedError } from './types.ts';
export { MemoryEventBus } from './memory.ts';

export function createEvent(partial: Omit<DomainEvent, 'eventId' | 'timestamp'>, now = () => new Date().toISOString()): DomainEvent {
  return {
    eventId: `evt_${randomUUID()}`,
    timestamp: now(),
    ...partial,
  };
}
