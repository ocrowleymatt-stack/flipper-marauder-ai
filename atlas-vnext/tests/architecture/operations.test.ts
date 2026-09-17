import { describe, expect, it } from 'vitest';
import { analyzeGraph } from './import-graph.ts';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('operations package boundaries', () => {
  it('does not import Nexus, Execution, or dungeons', () => {
    const report = analyzeGraph(root);
    const modules = report.modules.filter((mod) => mod.relPath.startsWith('platform/operations/'));
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
