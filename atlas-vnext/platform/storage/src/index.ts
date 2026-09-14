import type { ManifestEntry, ProjectManifest } from '@atlas-vnext/contracts';

export interface BlobStore {
  put(bytes: Uint8Array): Promise<{ sha256: string; sizeBytes: number; deduplicated: boolean }>;
  get(sha256: string): Promise<Uint8Array>;
  has(sha256: string): Promise<boolean>;
}

export interface ManifestStore {
  put(projectId: string, entries: ManifestEntry[]): Promise<ProjectManifest>;
  get(manifestHash: string): Promise<ProjectManifest | null>;
}

export class StorageNotImplementedError extends Error {
  constructor() {
    super('platform/storage is a design-gate shell; CAS implementation is deferred.');
    this.name = 'StorageNotImplementedError';
  }
}

export { RetentionGuard, RetentionLimitError, BoundedWorkspaceIndex } from './retention.ts';
export type { RetentionKind } from './retention.ts';
