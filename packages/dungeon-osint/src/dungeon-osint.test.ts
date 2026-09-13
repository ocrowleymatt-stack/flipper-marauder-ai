import test from 'node:test';
import assert from 'node:assert/strict';
import { DungeonOsint, normalizeTarget } from './index.js';

test('normalizeTarget cleans and standardizes entity queries', () => {
  const norm = normalizeTarget('  UserAdmin@EXAMPLE.COM ', 'email');
  assert.equal(norm.normalized, 'useradmin@example.com');
  assert.equal(norm.type, 'email');
});

test('DungeonOsint exposes valid manifest and capabilities', async () => {
  const dungeon = new DungeonOsint();
  assert.equal(dungeon.manifest.id, 'dungeon-osint');
  assert.ok(dungeon.manifest.capabilitiesProvided.includes('osint:scan'));

  const health = await dungeon.healthCheck();
  assert.equal(health.ok, true);
});
