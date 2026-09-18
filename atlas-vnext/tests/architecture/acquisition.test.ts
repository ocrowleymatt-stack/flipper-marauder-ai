import { describe, expect, it } from 'vitest';
import { analyzeGraph } from './import-graph.ts';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('acquisition package boundaries', () => {
  it('keeps acquisition off Nexus, Execution, and dungeons', () => {
    const report = analyzeGraph(root);
    const modules = report.modules.filter((mod) => mod.relPath.startsWith('platform/acquisition/'));
    expect(modules.length).toBeGreaterThan(0);
    for (const mod of modules) {
      expect(mod.specifiers.some((item) => item === '@atlas-vnext/nexus' || item === '@atlas-vnext/execution')).toBe(
        false,
      );
      expect(mod.specifiers.some((item) => item.startsWith('@atlas-vnext/dungeon-'))).toBe(false);
      expect(mod.fetchCalls).toBe(false);
    }
  });

  it('fails when acquisition depends on a dungeon', () => {
    const report = analyzeGraph(root, {
      'platform/acquisition/package.json': JSON.stringify({
        name: '@atlas-vnext/acquisition',
        dependencies: {
          '@atlas-vnext/contracts': '*',
          '@atlas-vnext/dungeon-investigation': '*',
        },
      }),
    });
    expect(
      report.packageViolations
        .concat(report.violations)
        .some((item) => item.rule === 'platform-package-deps' && item.detail.includes('@atlas-vnext/dungeon-investigation')),
    ).toBe(true);
  });
});
