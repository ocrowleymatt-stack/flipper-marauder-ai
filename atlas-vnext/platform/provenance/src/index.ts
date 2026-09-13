import type { ProvenanceRecord } from '@atlas-vnext/contracts';

export interface ProvenanceStore {
  record(entry: ProvenanceRecord): Promise<void>;
  forArtefact(artefactId: string): Promise<ProvenanceRecord | null>;
  forJob(jobId: string): Promise<ProvenanceRecord[]>;
}

export class ProvenanceNotImplementedError extends Error {
  constructor() {
    super('platform/provenance is a design-gate shell; durable implementation is deferred.');
    this.name = 'ProvenanceNotImplementedError';
  }
}
