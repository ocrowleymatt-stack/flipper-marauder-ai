import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeGraph } from './import-graph.ts';
import { CASPA_WRITING_DUNGEON, composeWritingPrompt, writingRouteRequirements } from '@atlas-vnext/dungeon-writing';
import { WRITING_PROMPT_PRECEDENCE } from '@atlas-vnext/contracts';
import { AuthorityEngine } from '@atlas-vnext/permissions';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function writingSources(): string[] {
  const report = analyzeGraph(root);
  return report.modules.filter((mod) => mod.dungeon === 'writing').map((mod) => join(root, mod.relPath));
}

describe('Caspa architecture boundaries', () => {
  it('registers a small writing dungeon, not a marketplace', () => {
    expect(CASPA_WRITING_DUNGEON.id).toBe('writing');
    expect(CASPA_WRITING_DUNGEON.slug).toBe('caspa');
    expect(CASPA_WRITING_DUNGEON.surface).toBe('caspa-writing');
    expect(CASPA_WRITING_DUNGEON.permissions.write).toBe('artifact.write');
    expect(Object.keys(CASPA_WRITING_DUNGEON)).not.toContain('price');
  });

  it('does not import Nexus, Execution, auth, secrets, provider SDKs, or RunPod', () => {
    const report = analyzeGraph(root);
    expect(report.violations, JSON.stringify(report.violations, null, 2)).toEqual([]);
    const writing = report.modules.filter((mod) => mod.dungeon === 'writing');
    expect(writing.length).toBeGreaterThan(0);
    for (const mod of writing) {
      expect(mod.specifiers.some((item) => item === '@atlas-vnext/nexus' || item === '@atlas-vnext/execution')).toBe(false);
      expect(mod.specifiers.some((item) => item === '@atlas-vnext/auth' || item === '@atlas-vnext/secrets')).toBe(false);
      expect(mod.fetchCalls).toBe(false);
      expect(mod.processEnvAccess).toBe(false);
    }
  });

  it('contains no provider credentials, RunPod details, or if-writing-then-OpenAI lists', () => {
    const blobs = [
      ...writingSources().map((file) => readFileSync(file, 'utf8')),
      readFileSync(join(root, 'apps/web/src/caspa.tsx'), 'utf8'),
    ].join('\n');
    expect(blobs).not.toMatch(/OPENAI_API_KEY|ANTHROPIC_API_KEY|RUNPOD_API|sk-[a-zA-Z0-9]/);
    expect(blobs).not.toMatch(/runpod/i);
    expect(blobs).not.toMatch(/if\s*\(.*writing.*\)[\s\S]{0,80}openai/i);
    expect(blobs).not.toMatch(/from 'openai'|from "openai"|@anthropic-ai\/sdk/);
  });

  it('keeps Behaviour composition explicit and Open does not grant Authority', () => {
    const composed = composeWritingPrompt({
      behaviour: 'open',
      projectContext: 'File notes.md',
      operation: 'rewrite',
      instruction: 'Make it shorter.',
      currentDocument: 'Long text.',
    });
    expect(composed.precedence).toEqual(WRITING_PROMPT_PRECEDENCE);
    expect(composed.text.indexOf(composed.layers.capabilityPolicy)).toBe(0);
    expect(composed.text.indexOf(composed.layers.requestInstructions)).toBeGreaterThan(
      composed.text.indexOf(composed.layers.dungeonWritingBehaviour),
    );
    const authority = new AuthorityEngine();
    const open = authority.decide({
      principal: { principalId: 'p1', kind: 'user', tenantId: 't1' },
      capability: 'artifact.write',
      behaviour: 'open',
      resource: { type: 'artifact', id: 'doc_1', tenantId: 't1', workspaceId: 'proj_1' },
    });
    expect(open.decision).toBe('DENY');
  });

  it('expresses Nexus requirements without naming providers', () => {
    const requirements = writingRouteRequirements({
      operation: 'restructure',
      contentChars: 20_000,
      selectedFileCount: 2,
      privacy: 'local_only',
    });
    expect(requirements.target).toBe('nexus/local');
    expect(requirements.requireReasoning).toBe(true);
    expect(JSON.stringify(requirements)).not.toMatch(/openai|anthropic|runpod/i);
  });
});
