import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
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

export interface FilesystemCasOptions {
  root: string;
}

/**
 * Filesystem CAS adapter.
 *
 * - SHA-256 identity
 * - Path: `<root>/sha256/<aa>/<bb>/<hash>`
 * - Atomic publish: write tmp + rename into place
 * - Dedup: existing object is not rewritten
 * - Hash verified on put and get
 */
export class FilesystemCas implements CasStore {
  readonly layout = 'sha256/<aa>/<bb>/<hash>' as const;
  readonly root: string;

  constructor(options: FilesystemCasOptions) {
    this.root = resolve(options.root);
  }

  objectPath(sha256: string): string {
    const rel = casObjectRelPath(sha256);
    const full = resolve(this.root, rel);
    if (!full.startsWith(this.root + sep) && full !== this.root) {
      throw new Error('CAS path escaped the store root.');
    }
    return full;
  }

  async put(bytes: Uint8Array): Promise<CasPutResult> {
    const sha256 = sha256Hex(bytes);
    const dest = this.objectPath(sha256);
    if (await this.has(sha256)) {
      const existing = await this.get(sha256);
      if (existing.byteLength !== bytes.byteLength) {
        throw new Error(`CAS size mismatch for existing object ${sha256}.`);
      }
      return { sha256, sizeBytes: bytes.byteLength, deduplicated: true };
    }
    const tmpDir = join(this.root, 'tmp');
    await mkdir(tmpDir, { recursive: true });
    await mkdir(dirname(dest), { recursive: true });
    const tmp = join(tmpDir, `${randomUUID()}.part`);
    try {
      await writeFile(tmp, bytes, { flag: 'wx' });
      verifyBytes(sha256, await readFile(tmp));
      try {
        await rename(tmp, dest);
      } catch (err) {
        if (await this.has(sha256)) {
          await rm(tmp, { force: true });
          return { sha256, sizeBytes: bytes.byteLength, deduplicated: true };
        }
        throw err;
      }
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      if (await this.has(sha256)) {
        return { sha256, sizeBytes: bytes.byteLength, deduplicated: true };
      }
      throw err;
    }
    return { sha256, sizeBytes: bytes.byteLength, deduplicated: false };
  }

  async get(sha256: string): Promise<Uint8Array> {
    const hash = assertSha256(sha256);
    const dest = this.objectPath(hash);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(dest);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new CasNotFoundError(hash);
      throw err;
    }
    verifyBytes(hash, bytes);
    return bytes;
  }

  async has(sha256: string): Promise<boolean> {
    return (await this.stat(sha256)) !== null;
  }

  async stat(sha256: string): Promise<CasStat | null> {
    const hash = assertSha256(sha256);
    try {
      const info = await stat(this.objectPath(hash));
      if (!info.isFile()) return null;
      return { sha256: hash, sizeBytes: info.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async unlink(sha256: string): Promise<boolean> {
    const hash = assertSha256(sha256);
    try {
      await rm(this.objectPath(hash), { force: false });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }
}

export async function openFilesystemCas(root: string): Promise<FilesystemCas> {
  await mkdir(root, { recursive: true });
  return new FilesystemCas({ root });
}
