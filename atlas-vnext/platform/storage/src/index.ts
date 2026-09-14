export type { BlobStore, CasPutResult, CasStat, CasStore } from './cas.ts';
export {
  CAS_ALGO,
  SHA256_HEX,
  CasHashError,
  CasNotFoundError,
  CasPublicationError,
  assertSha256,
  casObjectRelPath,
  isDiskFullError,
  sha256Hex,
  verifyBytes,
} from './cas.ts';
export { FilesystemCas, openFilesystemCas } from './fs-cas.ts';
export type { FilesystemCasOptions } from './fs-cas.ts';
export { MemoryCas } from './memory-cas.ts';
export { CasManifestStore, hashManifestEntries } from './manifest.ts';
export type { ManifestStore } from './cas.ts';

export { RetentionGuard, RetentionLimitError, BoundedWorkspaceIndex } from './retention.ts';
export type { RetentionKind } from './retention.ts';

/** @deprecated CAS is implemented; kept so existing type imports compile. */
export class StorageNotImplementedError extends Error {
  constructor() {
    super('platform/storage CAS is implemented; this error is unused.');
    this.name = 'StorageNotImplementedError';
  }
}
