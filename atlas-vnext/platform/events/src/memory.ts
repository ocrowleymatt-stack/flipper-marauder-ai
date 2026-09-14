import { randomUUID } from 'node:crypto';
import type { DomainEvent, EventBus } from './types.ts';

export class MemoryEventBus implements EventBus {
  private readonly records: DomainEvent[] = [];
  private readonly listeners = new Map<string, Set<(event: DomainEvent) => void>>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  async publish(event: Omit<DomainEvent, 'eventId' | 'timestamp'>): Promise<DomainEvent> {
    const recorded: DomainEvent = {
      eventId: `evt_${randomUUID()}`,
      timestamp: this.now(),
      ...event,
    };
    this.records.push(recorded);
    const listeners = this.listeners.get(recorded.channel);
    if (listeners) {
      for (const listener of listeners) listener(recorded);
    }
    const wildcard = this.listeners.get('*');
    if (wildcard) {
      for (const listener of wildcard) listener(recorded);
    }
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
    if (channel === '*') return [...this.records];
    return this.records.filter((event) => event.channel === channel);
  }
}
