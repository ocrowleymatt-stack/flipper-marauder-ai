import { createHash } from 'node:crypto';

export const CAS_ALGO = 'sha256';
export const SHA256_HEX = /^[a-f0-9]{64}$/;

export interface CasPutResult {
  sha256: string;
  sizeBytes: number;
  deduplicated: boolean;
}

export interface CasStat {
  sha256: string;
  sizeBytes: number;
}

export interface BlobStore {
  put(bytes: Uint8Array): Promise<CasPutResult>;
  get(sha256: string): Promise<Uint8Array>;
  has(sha256: string): Promise<boolean>;
}

/**
 * Content-addressed blob store. Bytes live on the adapter; PostgreSQL stores
 * hashes and refcounts only.
 */
export interface CasStore extends BlobStore {
  readonly layout: 'sha256/<aa>/<bb>/<hash>';
  objectPath(sha256: string): string;
  stat(sha256: string): Promise<CasStat | null>;
  /**
   * GC hook. Unlink the object only after metadata refcount is zero.
   * Returns true when a file was removed.
   */
  unlink(sha256: string): Promise<boolean>;
}

export interface ManifestStore {
  put(projectId: string, entries: import('@atlas-vnext/contracts').ManifestEntry[]): Promise<
    import('@atlas-vnext/contracts').ProjectManifest
  >;
  get(manifestHash: string): Promise<import('@atlas-vnext/contracts').ProjectManifest | null>;
}

export class CasHashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CasHashError';
  }
}

export class CasNotFoundError extends Error {
  constructor(sha256: string) {
    super(`CAS object sha256/${sha256} was not found.`);
    this.name = 'CasNotFoundError';
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function assertSha256(sha256: string): string {
  const normalised = sha256.trim().toLowerCase();
  if (!SHA256_HEX.test(normalised)) {
    throw new CasHashError(`Invalid SHA-256 hex: ${sha256}`);
  }
  return normalised;
}

/** Layout: sha256/<prefix>/<prefix>/<hash> with two 2-hex path segments. */
export function casObjectRelPath(sha256: string): string {
  const hash = assertSha256(sha256);
  return `${CAS_ALGO}/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
}

export function verifyBytes(sha256: string, bytes: Uint8Array): void {
  const actual = sha256Hex(bytes);
  const expected = assertSha256(sha256);
  if (actual !== expected) {
    throw new CasHashError(`CAS hash mismatch: expected ${expected}, got ${actual}.`);
  }
}
