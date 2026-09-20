import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeGraph } from './import-graph.ts';
import { MUSIC_DUNGEON } from '@atlas-vnext/dungeon-music';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function musicSources(): string[] {
  const report = analyzeGraph(root);
  return report.modules.filter((mod) => mod.dungeon === 'music').map((mod) => join(root, mod.relPath));
}

describe('Music architecture boundaries', () => {
  it('registers a thin music dungeon', () => {
    expect(MUSIC_DUNGEON.id).toBe('music');
    expect(MUSIC_DUNGEON.surface).toBe('music-studio');
    expect(MUSIC_DUNGEON.permissions.write).toBe('artifact.write');
  });

  it('does not import Nexus, Execution, auth, secrets, or fetch', () => {
    const report = analyzeGraph(root);
    expect(report.violations, JSON.stringify(report.violations, null, 2)).toEqual([]);
    const music = report.modules.filter((mod) => mod.dungeon === 'music');
    expect(music.length).toBeGreaterThan(0);
    for (const mod of music) {
      expect(mod.specifiers.some((item) => item === '@atlas-vnext/nexus' || item === '@atlas-vnext/execution')).toBe(false);
      expect(mod.specifiers.some((item) => item === '@atlas-vnext/auth' || item === '@atlas-vnext/secrets')).toBe(false);
      expect(mod.fetchCalls).toBe(false);
      expect(mod.processEnvAccess).toBe(false);
    }
  });

  it('owns conversation result-return through a host score port, not a second conversation', () => {
    const blobs = musicSources().map((file) => readFileSync(file, 'utf8')).join('\n');
    const host = readFileSync(join(root, 'apps/host/src/compose.ts'), 'utf8');
    const generatePort = readFileSync(join(root, 'apps/host/src/music-score.ts'), 'utf8');
    expect(blobs).toMatch(/maybeRunFromConversation/);
    expect(blobs).toMatch(/MusicScorePort/);
    expect(blobs).not.toMatch(/runtime\.sendMessage/);
    expect(blobs).not.toMatch(/createConversation/);
    expect(blobs).not.toMatch(/@atlas-vnext\/conversation/);
    expect(blobs).not.toMatch(/callServerAi/);
    expect(blobs).not.toMatch(/from 'openai'|from "openai"|@anthropic-ai\/sdk/);
    expect(blobs).not.toMatch(/ACE-Step|RunPod|ATLAS_MUSIC_GPU|content_base64/i);
    expect(host).toMatch(/looksLikeMusicRequest/);
    expect(host).toMatch(/NodeMusicScore/);
    expect(host.indexOf('if (looksLikeMusicRequest')).toBeGreaterThan(host.indexOf('if (looksLikeWebsiteRequest'));
    expect(host.indexOf('if (looksLikeMusicRequest')).toBeLessThan(host.indexOf('research!.maybeRunFromConversation'));
    expect(generatePort).toMatch(/onAttempt\(\)/);
    expect(generatePort).toMatch(/beginRun/);
    expect(generatePort).toMatch(/assertGeneratedOutput/);
    expect(generatePort).not.toMatch(/failover after visible|visibleOutputAlready:\s*true/);
    const estate = readFileSync(join(root, 'apps/host/src/estate.ts'), 'utf8');
    expect(estate).toMatch(/admitRun:\s*true/);
    expect(blobs).toMatch(/admitRun \? actor\.tenantId : undefined/);
  });

  it('does not copy Execution circuit-open into Nexus routing eligibility', () => {
    const compose = readFileSync(join(root, 'apps/host/src/compose.ts'), 'utf8');
    const handlerStart = compose.indexOf('onProviderHealth(provider, health');
    const handlerEnd = compose.indexOf('for (const [provider, health] of Object.entries(plane.health)');
    expect(handlerStart).toBeGreaterThan(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    const handler = compose.slice(handlerStart, handlerEnd);
    expect(handler).toMatch(/detail === 'circuit_open'/);
    expect(handler.indexOf("detail === 'circuit_open'")).toBeLessThan(handler.indexOf('registry.setHealth'));
    expect(handler).toMatch(/recordProviderHealth/);
  });
});
