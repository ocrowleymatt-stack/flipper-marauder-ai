import test from 'node:test';
import assert from 'node:assert/strict';
import { DungeonKnowledge, decryptOAuthToken, encryptOAuthToken } from './index.js';

test('encryptOAuthToken and decryptOAuthToken round-trip securely using AES-256-GCM', () => {
  const secretKey = 'atlas_high_entropy_master_secret';
  const rawToken = 'ya29.a0AfH6SMD_dropbox_refresh_token_example';

  const envelope = encryptOAuthToken(rawToken, secretKey);
  assert.equal(envelope.algorithm, 'aes-256-gcm');
  assert.ok(envelope.ciphertext.length > 0);
  assert.ok(envelope.iv.length === 24); // 12 bytes in hex

  const decrypted = decryptOAuthToken(envelope, secretKey);
  assert.equal(decrypted, rawToken);

  // Wrong key fails decryption
  assert.throws(() => {
    decryptOAuthToken(envelope, 'wrong_key');
  });
});

test('DungeonKnowledge exposes valid manifest and passes healthcheck', async () => {
  const dungeon = new DungeonKnowledge();
  assert.equal(dungeon.manifest.id, 'dungeon-knowledge');
  assert.ok(dungeon.manifest.capabilitiesProvided.includes('knowledge:sync'));

  const health = await dungeon.healthCheck();
  assert.equal(health.ok, true);
});
