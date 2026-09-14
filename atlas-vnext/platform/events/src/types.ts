export interface DomainEvent {
  eventId: string;
  channel: string;
  type: string;
  timestamp: string;
  payload: unknown;
  /** Monotonic per stream/channel. Assigned at commit. */
  seq: number;
  tenantId?: string;
  workspaceId?: string | null;
  conversationId?: string | null;
  jobId?: string | null;
  idempotencyKey?: string | null;
}

export interface EventPublishInput {
  channel: string;
  type: string;
  payload: unknown;
  tenantId?: string;
  workspaceId?: string | null;
  conversationId?: string | null;
  jobId?: string | null;
  idempotencyKey?: string | null;
  eventId?: string;
}

export interface EventReplayCursor {
  eventId?: string;
  seq?: number;
}

export interface EventBus {
  publish(event: EventPublishInput): Promise<DomainEvent>;
  subscribe(channel: string, listener: (event: DomainEvent) => void): () => void;
  history(channel: string): Promise<DomainEvent[]>;
  replay(channel: string, after?: EventReplayCursor): Promise<DomainEvent[]>;
}

export class EventsNotImplementedError extends Error {
  constructor() {
    super('platform/events is a design-gate shell; durable implementation is deferred.');
    this.name = 'EventsNotImplementedError';
  }
}
