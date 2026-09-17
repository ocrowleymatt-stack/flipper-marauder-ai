import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeGraph } from './import-graph.ts';
import { OSINT_DUNGEON } from '@atlas-vnext/dungeon-osint';
import { INVESTIGATION_DUNGEON } from '@atlas-vnext/dungeon-investigation';
import { RESEARCH_DUNGEON } from '@atlas-vnext/dungeon-research';
import { WEBSITE_DUNGEON } from '@atlas-vnext/dungeon-website';
import { MUSIC_DUNGEON } from '@atlas-vnext/dungeon-music';
import { PRIVACY_DUNGEON } from '@atlas-vnext/dungeon-privacy';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DUNGEONS = ['osint', 'investigation', 'research', 'website', 'music', 'privacy'] as const;

describe('migrated dungeon architecture', () => {
  it('keeps dungeons isolated from Nexus, Execution, auth, secrets, sockets, and each other', () => {
    const report = analyzeGraph(root);
    expect(report.violations, JSON.stringify(report.violations, null, 2)).toEqual([]);
    for (const id of DUNGEONS) {
      const modules = report.modules.filter((mod) => mod.dungeon === id);
      expect(modules.length, id).toBeGreaterThan(0);
      for (const mod of modules) {
        expect(mod.specifiers.some((item) => item === '@atlas-vnext/nexus' || item === '@atlas-vnext/execution')).toBe(
          false,
        );
        expect(mod.specifiers.some((item) => item === '@atlas-vnext/auth' || item === '@atlas-vnext/secrets')).toBe(
          false,
        );
        expect(mod.fetchCalls).toBe(false);
        expect(mod.processEnvAccess).toBe(false);
      }
    }
  });

  it('does not vendor scanners, provider SDKs, or GPU vendor names into dungeon contracts', () => {
    const blobs = DUNGEONS.flatMap((id) =>
      analyzeGraph(root)
        .modules.filter((mod) => mod.dungeon === id)
        .map((mod) => readFileSync(join(root, mod.relPath), 'utf8')),
    ).join('\n');
    expect(blobs).not.toMatch(/OPENAI_API_KEY|ANTHROPIC_API_KEY|RUNPOD_API|sk-[a-zA-Z0-9]/);
    expect(blobs).not.toMatch(/from 'openai'|from "openai"|@anthropic-ai\/sdk|node:https|node:dns/);
    expect(blobs).not.toMatch(/TheBigBrother|SpiderFoot/);
    expect(MUSIC_DUNGEON.description).not.toMatch(/runpod/i);
  });

  it('fails when the Privacy dungeon package.json depends on transports or control-plane', () => {
    const report = analyzeGraph(root, {
      'dungeons/privacy/package.json': JSON.stringify({
        name: '@atlas-vnext/dungeon-privacy',
        dependencies: {
          '@atlas-vnext/contracts': '*',
          eventsource: '^2.0.0',
          '@atlas-vnext/nexus': '*',
          '@atlas-vnext/dungeon-osint': '*',
        },
      }),
    });
    expect(
      report.violations.some((item) => item.rule === 'dungeon-package-deps' && item.detail.includes('eventsource')),
    ).toBe(true);
    expect(report.violations.some((item) => item.detail.includes('@atlas-vnext/nexus'))).toBe(true);
    expect(report.violations.some((item) => item.detail.includes('@atlas-vnext/dungeon-osint'))).toBe(true);
  });

  it('registers specialist surfaces rather than Caspa clones', () => {
    expect(new Set([OSINT_DUNGEON.surface, INVESTIGATION_DUNGEON.surface, RESEARCH_DUNGEON.surface, WEBSITE_DUNGEON.surface, MUSIC_DUNGEON.surface, PRIVACY_DUNGEON.surface]).size).toBe(6);
    expect(PRIVACY_DUNGEON.ownerOnly).toBe(true);
    expect(WEBSITE_DUNGEON.capabilities).toContain('deployment.promote');
    expect(OSINT_DUNGEON.capabilities).toContain('network.public');
  });
});
