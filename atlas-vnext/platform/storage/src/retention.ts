import {
  DEFAULT_RETENTION_BOUNDS,
  retentionBoundsSchema,
  type RetentionBounds,
} from '@atlas-vnext/contracts';

export class RetentionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetentionLimitError';
  }
}

export type RetentionKind = 'artefacts' | 'workspaces' | 'releases' | 'events';

/**
 * Fail-closed disk-pressure hygiene. Caps artefact/workspace/release/event
 * growth. Product prune jobs are deferred; this stub locks the bounds.
 */
export class RetentionGuard {
  readonly bounds: RetentionBounds;

  constructor(bounds: RetentionBounds = DEFAULT_RETENTION_BOUNDS) {
    this.bounds = retentionBoundsSchema.parse(bounds);
  }

  cap(kind: RetentionKind): number {
    if (kind === 'artefacts') return this.bounds.maxArtefacts;
    if (kind === 'workspaces') return this.bounds.maxWorkspaces;
    if (kind === 'releases') return this.bounds.maxReleases;
    return this.bounds.maxEventLogEntries;
  }

  prune<T>(kind: RetentionKind, items: readonly T[]): T[] {
    const max = this.cap(kind);
    if (items.length <= max) return [...items];
    return items.slice(items.length - max);
  }

  assertWithinBounds(usage: {
    artefacts: number;
    workspaces: number;
    releases: number;
    events: number;
    workspaceBytes: number;
  }): void {
    if (usage.artefacts > this.bounds.maxArtefacts) {
      throw new RetentionLimitError(`Artefact retention exceeded (${usage.artefacts} > ${this.bounds.maxArtefacts}).`);
    }
    if (usage.workspaces > this.bounds.maxWorkspaces) {
      throw new RetentionLimitError(
        `Workspace retention exceeded (${usage.workspaces} > ${this.bounds.maxWorkspaces}).`,
      );
    }
    if (usage.releases > this.bounds.maxReleases) {
      throw new RetentionLimitError(`Release retention exceeded (${usage.releases} > ${this.bounds.maxReleases}).`);
    }
    if (usage.events > this.bounds.maxEventLogEntries) {
      throw new RetentionLimitError(`Event log retention exceeded (${usage.events} > ${this.bounds.maxEventLogEntries}).`);
    }
    if (usage.workspaceBytes > this.bounds.maxWorkspaceBytes) {
      throw new RetentionLimitError(
        `Workspace byte retention exceeded (${usage.workspaceBytes} > ${this.bounds.maxWorkspaceBytes}).`,
      );
    }
  }
}

export class BoundedWorkspaceIndex {
  private readonly entries: Array<{ id: string; bytes: number }> = [];

  constructor(
    private readonly guard: RetentionGuard,
    private readonly maxBytes = guard.bounds.maxWorkspaceBytes,
  ) {}

  add(id: string, bytes: number): void {
    this.entries.push({ id, bytes });
    while (this.entries.length > this.guard.bounds.maxWorkspaces) this.entries.shift();
    while (this.totalBytes() > this.maxBytes && this.entries.length > 0) this.entries.shift();
  }

  list(): Array<{ id: string; bytes: number }> {
    return [...this.entries];
  }

  totalBytes(): number {
    return this.entries.reduce((sum, entry) => sum + entry.bytes, 0);
  }
}
