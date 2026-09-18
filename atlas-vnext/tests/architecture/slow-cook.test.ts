import { describe, expect, it } from 'vitest';
import { analyzeGraph } from './import-graph.ts';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('compiled context and Slow Cook boundaries', () => {
  it('does not let context compilation or Slow Cook import Nexus, dungeons, or provider transports', () => {
    const report = analyzeGraph(root);
    expect(report.violations, JSON.stringify(report.violations, null, 2)).toEqual([]);
    const modules = report.modules.filter(
      (mod) =>
        mod.relPath === 'platform/context/src/compile.ts' ||
        mod.relPath === 'platform/jobs/src/slow-cook.ts' ||
        mod.relPath === 'packages/contracts/src/compiled-context.ts' ||
        mod.relPath === 'packages/contracts/src/slow-cook.ts',
    );
    expect(modules.length).toBeGreaterThan(0);
    for (const mod of modules) {
      expect(mod.specifiers.some((item) => item === '@atlas-vnext/nexus' || item === '@atlas-vnext/execution')).toBe(
        false,
      );
      expect(mod.specifiers.some((item) => item.startsWith('@atlas-vnext/dungeon-'))).toBe(false);
      expect(mod.fetchCalls).toBe(false);
    }
  });
});
