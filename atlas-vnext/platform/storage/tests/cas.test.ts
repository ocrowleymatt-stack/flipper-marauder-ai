import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CasHashError, FilesystemCas, MemoryCas, casObjectRelPath, sha256Hex } from '@atlas-vnext/storage';

describe('CAS', () => {
  it('addresses objects as sha256/<aa>/<bb>/<hash> and dedups', async () => {
    const cas = new MemoryCas();
    const bytes = new TextEncoder().encode('atlas-cas-one');
    const first = await cas.put(bytes);
    const second = await cas.put(bytes);
    expect(first.sha256).toBe(sha256Hex(bytes));
    expect(first.sha256).toHaveLength(64);
    expect(second.deduplicated).toBe(true);
    expect(cas.objectPath(first.sha256)).toBe(
      `sha256/${first.sha256.slice(0, 2)}/${first.sha256.slice(2, 4)}/${first.sha256}`,
    );
    expect(casObjectRelPath(first.sha256)).toMatch(/^sha256\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
    expect(new TextDecoder().decode(await cas.get(first.sha256))).toBe('atlas-cas-one');
  });

  it('publishes atomically on the filesystem adapter and verifies hashes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atlas-cas-'));
    const cas = new FilesystemCas({ root });
    const bytes = new TextEncoder().encode('filesystem-cas');
    const put = await cas.put(bytes);
    expect(put.deduplicated).toBe(false);
    expect(await cas.has(put.sha256)).toBe(true);
    expect((await cas.get(put.sha256)).byteLength).toBe(bytes.byteLength);
    await expect(cas.get('0'.repeat(64))).rejects.toThrow(/not found/i);
    await expect(async () => cas.objectPath('../escape')).rejects.toThrow(CasHashError);
    expect(await cas.unlink(put.sha256)).toBe(true);
    expect(await cas.has(put.sha256)).toBe(false);
  });
});
