import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { casObjectRelPath, sha256Hex } from '@atlas-vnext/storage';
import { FilesystemCas } from '../../platform/storage/src/fs-cas.ts';
import { verifyCasObjects } from '../../scripts/cas-integrity.ts';

describe('CAS integrity helper', () => {
  it('accepts blobs whose bytes match the metadata hash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atlas-cas-ok-'));
    const cas = new FilesystemCas({ root });
    const bytes = new TextEncoder().encode('restore-me');
    const put = await cas.put(bytes);
    await expect(verifyCasObjects(root, [put.sha256])).resolves.toBeUndefined();
  });

  it('rejects missing or hash-mismatched CAS objects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atlas-cas-bad-'));
    const bytes = new TextEncoder().encode('good-bytes');
    const hash = sha256Hex(bytes);
    const dest = join(root, casObjectRelPath(hash));
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, 'truncated');
    await expect(verifyCasObjects(root, [hash])).rejects.toThrow(/CAS integrity failed/);
    await expect(verifyCasObjects(root, ['ab'.repeat(32)])).rejects.toThrow(/CAS integrity failed/);
  });
});
