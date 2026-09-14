import {
  assertSha256,
  casObjectRelPath,
  sha256Hex,
  verifyBytes,
  type CasPutResult,
  type CasStat,
  type CasStore,
  CasNotFoundError,
} from './cas.ts';

/** In-process CAS for unit tests. Same hash/path identity as the filesystem adapter. */
export class MemoryCas implements CasStore {
  readonly layout = 'sha256/<aa>/<bb>/<hash>' as const;
  readonly root = ':memory:';
  private readonly objects = new Map<string, Uint8Array>();

  objectPath(sha256: string): string {
    return casObjectRelPath(sha256);
  }

  async put(bytes: Uint8Array): Promise<CasPutResult> {
    const sha256 = sha256Hex(bytes);
    const existing = this.objects.get(sha256);
    if (existing) {
      verifyBytes(sha256, existing);
      return { sha256, sizeBytes: existing.byteLength, deduplicated: true };
    }
    this.objects.set(sha256, Uint8Array.from(bytes));
    return { sha256, sizeBytes: bytes.byteLength, deduplicated: false };
  }

  async get(sha256: string): Promise<Uint8Array> {
    const hash = assertSha256(sha256);
    const bytes = this.objects.get(hash);
    if (!bytes) throw new CasNotFoundError(hash);
    verifyBytes(hash, bytes);
    return Uint8Array.from(bytes);
  }

  async has(sha256: string): Promise<boolean> {
    return this.objects.has(assertSha256(sha256));
  }

  async stat(sha256: string): Promise<CasStat | null> {
    const hash = assertSha256(sha256);
    const bytes = this.objects.get(hash);
    if (!bytes) return null;
    return { sha256: hash, sizeBytes: bytes.byteLength };
  }

  async unlink(sha256: string): Promise<boolean> {
    return this.objects.delete(assertSha256(sha256));
  }
}
