import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryContentAddressedStorage } from './index.js';

test('MemoryContentAddressedStorage stores, retrieves, and deduplicates identical data', async () => {
  const cas = new MemoryContentAddressedStorage();
  const payload = 'Atlas vNext Content Addressed Storage Engine';

  const desc1 = await cas.put(payload, 'text/plain');
  assert.ok(desc1.hash.length === 64);
  assert.equal(desc1.sizeBytes, Buffer.byteLength(payload));

  // Deduplication check
  const desc2 = await cas.put(payload, 'text/plain');
  assert.equal(desc1.hash, desc2.hash);

  const data = await cas.get(desc1.hash);
  assert.ok(data !== null);
  assert.equal(data.toString('utf-8'), payload);

  const exists = await cas.has(desc1.hash);
  assert.equal(exists, true);

  const verified = await cas.verifyIntegrity(desc1.hash);
  assert.equal(verified, true);
});
