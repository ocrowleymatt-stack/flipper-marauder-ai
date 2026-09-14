import type { RuntimeEvent, RuntimeSnapshot } from './types.ts';

/**
 * Structured runtime/cost observability. Never console.log secrets or pod tokens.
 */
export class RuntimeObserver {
  private readonly events: RuntimeEvent[] = [];
  private readonly listeners: Array<(event: RuntimeEvent) => void> = [];

  record(event: RuntimeEvent): void {
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
  }

  onEvent(listener: (event: RuntimeEvent) => void): void {
    this.listeners.push(listener);
  }

  list(): RuntimeEvent[] {
    return [...this.events];
  }

  snapshot(base: Omit<RuntimeSnapshot, 'events'>): RuntimeSnapshot {
    return { ...base, events: this.list() };
  }
}
