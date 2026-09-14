import type { RuntimeEvent, RuntimeSnapshot } from './types.ts';

/** Hard cap so idle/wait loops cannot grow an unbounded in-memory event log. */
export const MAX_RUNTIME_EVENTS = 128;

/**
 * Structured runtime/cost observability. Never console.log secrets or pod tokens.
 */
export class RuntimeObserver {
  private readonly events: RuntimeEvent[] = [];
  private readonly listeners: Array<(event: RuntimeEvent) => void> = [];

  record(event: RuntimeEvent): void {
    const last = this.events.at(-1);
    if (
      last &&
      last.type === event.type &&
      last.state === event.state &&
      last.jobId === event.jobId &&
      last.detail === event.detail &&
      last.queuedJobs === event.queuedJobs
    ) {
      return;
    }
    this.events.push(event);
    if (this.events.length > MAX_RUNTIME_EVENTS) {
      this.events.splice(0, this.events.length - MAX_RUNTIME_EVENTS);
    }
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
