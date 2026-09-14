import { randomUUID } from 'node:crypto';
import { DEFAULT_RETENTION_BOUNDS } from '@atlas-vnext/contracts';
import type { DomainEvent, EventBus, EventPublishInput, EventReplayCursor } from './types.ts';

export class MemoryEventBus implements EventBus {
  private readonly records: DomainEvent[] = [];
  private readonly listeners = new Map<string, Set<(event: DomainEvent) => void>>();
  private readonly seqByChannel = new Map<string, number>();
  private readonly byIdempotency = new Map<string, DomainEvent>();

  constructor(
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly maxRecords: number = DEFAULT_RETENTION_BOUNDS.maxEventLogEntries,
  ) {}

  async publish(event: EventPublishInput): Promise<DomainEvent> {
    if (event.idempotencyKey) {
      const key = idempotencyLookup(event.tenantId, event.idempotencyKey);
      const existing = this.byIdempotency.get(key);
      if (existing) return existing;
    }

    const seq = (this.seqByChannel.get(event.channel) ?? 0) + 1;
    this.seqByChannel.set(event.channel, seq);
    const recorded: DomainEvent = {
      eventId: event.eventId ?? `evt_${randomUUID()}`,
      timestamp: this.now(),
      channel: event.channel,
      type: event.type,
      payload: event.payload,
      seq,
      tenantId: event.tenantId,
      workspaceId: event.workspaceId ?? null,
      conversationId: event.conversationId ?? null,
      jobId: event.jobId ?? null,
      idempotencyKey: event.idempotencyKey ?? null,
    };
    this.records.push(recorded);
    if (event.idempotencyKey) {
      this.byIdempotency.set(idempotencyLookup(event.tenantId, event.idempotencyKey), recorded);
    }
    if (this.records.length > this.maxRecords) {
      const removed = this.records.splice(0, this.records.length - this.maxRecords);
      for (const item of removed) {
        if (item.idempotencyKey) this.byIdempotency.delete(idempotencyLookup(item.tenantId, item.idempotencyKey));
      }
    }
    this.emit(recorded);
    return recorded;
  }

  subscribe(channel: string, listener: (event: DomainEvent) => void): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  async history(channel: string): Promise<DomainEvent[]> {
    return this.replay(channel);
  }

  async replay(channel: string, after?: EventReplayCursor): Promise<DomainEvent[]> {
    let records = channel === '*' ? [...this.records] : this.records.filter((event) => event.channel === channel);
    const afterSeq = await this.resolveCursor(records, after);
    if (afterSeq !== undefined) records = records.filter((event) => event.seq > afterSeq);
    return records.sort((a, b) => a.seq - b.seq || a.timestamp.localeCompare(b.timestamp));
  }

  applyRetention(maxRecords = this.maxRecords): number {
    if (this.records.length <= maxRecords) return 0;
    const removed = this.records.splice(0, this.records.length - maxRecords);
    for (const item of removed) {
      if (item.idempotencyKey) this.byIdempotency.delete(idempotencyLookup(item.tenantId, item.idempotencyKey));
    }
    return removed.length;
  }

  private async resolveCursor(records: DomainEvent[], after?: EventReplayCursor): Promise<number | undefined> {
    if (!after) return undefined;
    if (typeof after.seq === 'number') return after.seq;
    if (after.eventId) {
      const found = records.find((event) => event.eventId === after.eventId) ?? this.records.find((event) => event.eventId === after.eventId);
      return found?.seq;
    }
    return undefined;
  }

  private emit(recorded: DomainEvent): void {
    const listeners = this.listeners.get(recorded.channel);
    if (listeners) {
      for (const listener of listeners) listener(recorded);
    }
    const wildcard = this.listeners.get('*');
    if (wildcard) {
      for (const listener of wildcard) listener(recorded);
    }
  }
}

function idempotencyLookup(tenantId: string | undefined, key: string): string {
  return `${tenantId ?? '*'}::${key}`;
}
