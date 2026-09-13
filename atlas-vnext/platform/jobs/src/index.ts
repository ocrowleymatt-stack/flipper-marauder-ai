import type { JobRecord } from '@atlas-vnext/contracts';

export interface JobEngine {
  enqueue(input: {
    projectId?: string | null;
    dungeon: string;
    type: string;
    priority?: number;
    traceId?: string;
  }): Promise<JobRecord>;
  get(id: string): Promise<JobRecord | null>;
  checkpoint(id: string, stage: string, progressRatio: number, data: Record<string, unknown>): Promise<JobRecord>;
  complete(id: string): Promise<JobRecord>;
  fail(id: string, error: string): Promise<JobRecord>;
  cancel(id: string): Promise<JobRecord>;
}

export class JobsNotImplementedError extends Error {
  constructor() {
    super('platform/jobs is a design-gate shell; durable implementation is deferred.');
    this.name = 'JobsNotImplementedError';
  }
}
