import type { Provenance } from "./provenance.js";

export interface VNextEvent {
  id: string;
  sequence: number;
  occurredAt: string;
  correlationId: string;
  projectId: string;
  jobId?: string;
  type: `${string}:${string}`;
  payload: Record<string, unknown>;
  provenance?: Provenance;
}
