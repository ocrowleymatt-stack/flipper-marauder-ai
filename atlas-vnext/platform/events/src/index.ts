export interface DomainEvent {
  eventId: string;
  channel: string;
  type: string;
  timestamp: string;
  payload: unknown;
}

export interface EventBus {
  publish(event: Omit<DomainEvent, 'eventId' | 'timestamp'>): Promise<DomainEvent>;
  subscribe(channel: string, listener: (event: DomainEvent) => void): () => void;
}

export class EventsNotImplementedError extends Error {
  constructor() {
    super('platform/events is a design-gate shell; durable implementation is deferred.');
    this.name = 'EventsNotImplementedError';
  }
}
