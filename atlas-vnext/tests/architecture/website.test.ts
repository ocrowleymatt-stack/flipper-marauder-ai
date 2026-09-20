import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeGraph } from './import-graph.ts';
import { WEBSITE_DUNGEON } from '@atlas-vnext/dungeon-website';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function websiteSources(): string[] {
  const report = analyzeGraph(root);
  return report.modules.filter((mod) => mod.dungeon === 'website').map((mod) => join(root, mod.relPath));
}

describe('Website Studio architecture boundaries', () => {
  it('registers a thin website dungeon', () => {
    expect(WEBSITE_DUNGEON.id).toBe('website');
    expect(WEBSITE_DUNGEON.surface).toBe('website-studio');
    expect(WEBSITE_DUNGEON.permissions.write).toBe('artifact.write');
  });

  it('does not import Nexus, Execution, auth, secrets, or fetch', () => {
    const report = analyzeGraph(root);
    expect(report.violations, JSON.stringify(report.violations, null, 2)).toEqual([]);
    const website = report.modules.filter((mod) => mod.dungeon === 'website');
    expect(website.length).toBeGreaterThan(0);
    for (const mod of website) {
      expect(mod.specifiers.some((item) => item === '@atlas-vnext/nexus' || item === '@atlas-vnext/execution')).toBe(false);
      expect(mod.specifiers.some((item) => item === '@atlas-vnext/auth' || item === '@atlas-vnext/secrets')).toBe(false);
      expect(mod.fetchCalls).toBe(false);
      expect(mod.processEnvAccess).toBe(false);
    }
  });

  it('owns conversation result-return through a host generate port, not a second conversation', () => {
    const blobs = websiteSources().map((file) => readFileSync(file, 'utf8')).join('\n');
    const host = readFileSync(join(root, 'apps/host/src/compose.ts'), 'utf8');
    const generatePort = readFileSync(join(root, 'apps/host/src/site-generate.ts'), 'utf8');
    expect(blobs).toMatch(/maybeRunFromConversation/);
    expect(blobs).toMatch(/SiteGeneratePort/);
    expect(blobs).not.toMatch(/runtime\.sendMessage/);
    expect(blobs).not.toMatch(/createConversation/);
    expect(blobs).not.toMatch(/@atlas-vnext\/conversation/);
    expect(blobs).not.toMatch(/callServerAi/);
    expect(blobs).not.toMatch(/from 'openai'|from "openai"|@anthropic-ai\/sdk/);
    expect(host).toMatch(/looksLikeWebsiteRequest/);
    expect(host).toMatch(/NodeSiteGenerate/);
    expect(host.indexOf('if (looksLikeWebsiteRequest')).toBeGreaterThan(host.indexOf('if (looksLikeWritingRequest'));
    expect(host.indexOf('if (looksLikeWebsiteRequest')).toBeLessThan(host.indexOf('research!.maybeRunFromConversation'));
    expect(generatePort).toMatch(/onAttempt\(\)/);
    expect(generatePort).toMatch(/beginRun/);
    expect(generatePort).toMatch(/assertGeneratedOutput/);
    expect(generatePort).not.toMatch(/failover after visible|visibleOutputAlready:\s*true/);
  });
});
