import test from 'node:test';
import assert from 'node:assert/strict';
import { DungeonCreative, evaluateTextQuality } from './index.js';

test('evaluateTextQuality flags AI clichés and scores appropriately', () => {
  const cleanText = 'The inspector checked the latch on the cellar window. It was bolted from the inside.';
  const cleanScore = evaluateTextQuality(cleanText);
  assert.equal(cleanScore.status, 'pass');
  assert.equal(cleanScore.fogMatches, 0);

  const fogText = "In today's fast-paced world, it is important to remember that we must delve into the tapestry of human existence.";
  const fogScore = evaluateTextQuality(fogText);
  assert.equal(fogScore.status, 'fail');
  assert.ok(fogScore.fogMatches >= 3);
  assert.ok(fogScore.score < 60);
});

test('DungeonCreative exposes valid manifest and passes healthcheck', async () => {
  const dungeon = new DungeonCreative();
  assert.equal(dungeon.manifest.id, 'dungeon-creative');
  assert.ok(dungeon.manifest.capabilitiesProvided.includes('creative:draft'));

  const health = await dungeon.healthCheck();
  assert.equal(health.ok, true);
});
