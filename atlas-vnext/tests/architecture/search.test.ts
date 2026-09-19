import { describe, expect, it } from 'vitest';
import { analyzeGraph } from './import-graph.ts';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('search package boundaries', () => {
  it('keeps shared search off Nexus, Execution, and dungeons, and does not fetch', () => {
    const report = analyzeGraph(root);
    const modules = report.modules.filter((mod) => mod.relPath.startsWith('platform/search/'));
    expect(modules.length).toBeGreaterThan(0);
    for (const mod of modules) {
      expect(mod.specifiers.some((item) => item === '@atlas-vnext/nexus' || item === '@atlas-vnext/execution')).toBe(
        false,
      );
      expect(mod.specifiers.some((item) => item.startsWith('@atlas-vnext/dungeon-'))).toBe(false);
      expect(mod.fetchCalls).toBe(false);
    }
  });

  it('fails when search depends on a dungeon', () => {
    const report = analyzeGraph(root, {
      'platform/search/package.json': JSON.stringify({
        name: '@atlas-vnext/search',
        dependencies: {
          '@atlas-vnext/contracts': '*',
          '@atlas-vnext/dungeon-research': '*',
        },
      }),
    });
    expect(
      report.packageViolations
        .concat(report.violations)
        .some((item) => item.rule === 'platform-package-deps' && item.detail.includes('@atlas-vnext/dungeon-research')),
    ).toBe(true);
  });

  it('keeps the research dungeon from fetching or reading process.env', () => {
    const report = analyzeGraph(root);
    const modules = report.modules.filter((mod) => mod.dungeon === 'research');
    expect(modules.length).toBeGreaterThan(0);
    for (const mod of modules) {
      expect(mod.fetchCalls).toBe(false);
      expect(mod.processEnvAccess).toBe(false);
    }
  });
});
