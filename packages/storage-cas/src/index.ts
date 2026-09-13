import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  IContentAddressedStorage,
  StorageDescriptor,
} from '@atlas/core-contracts';

export class MemoryContentAddressedStorage implements IContentAddressedStorage {
  readonly #store = new Map<string, { buffer: Buffer; descriptor: StorageDescriptor }>();

  async put(
    data: Buffer | Uint8Array | string,
    mimeType = 'application/octet-stream',
    metadata?: Record<string, unknown>,
  ): Promise<StorageDescriptor> {
    const buffer = Buffer.isBuffer(data)
      ? data
      : typeof data === 'string'
      ? Buffer.from(data, 'utf-8')
      : Buffer.from(data);

    const hash = createHash('sha256').update(buffer).digest('hex');

    // Content-addressing naturally deduplicates identical payloads
    const existing = this.#store.get(hash);
    if (existing) {
      return existing.descriptor;
    }

    const descriptor: StorageDescriptor = {
      hash,
      sizeBytes: buffer.length,
      mimeType,
      createdAt: new Date().toISOString(),
      metadata: metadata ? Object.freeze({ ...metadata }) : undefined,
    };

    this.#store.set(hash, { buffer, descriptor });
    return descriptor;
  }

  async get(hash: string): Promise<Buffer | null> {
    const item = this.#store.get(hash);
    if (!item) return null;

    // Verify integrity prior to returning
    const computed = createHash('sha256').update(item.buffer).digest('hex');
    if (!timingSafeEqual(Buffer.from(computed), Buffer.from(hash))) {
      throw new Error(`Data corruption detected for CAS blob: ${hash}`);
    }
    return Buffer.from(item.buffer);
  }

  async has(hash: string): Promise<boolean> {
    return this.#store.has(hash);
  }

  async verifyIntegrity(hash: string): Promise<boolean> {
    const item = this.#store.get(hash);
    if (!item) return false;
    const computed = createHash('sha256').update(item.buffer).digest('hex');
    return timingSafeEqual(Buffer.from(computed), Buffer.from(hash));
  }
}
