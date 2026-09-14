import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeGraph } from './import-graph.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('architecture boundary graph', () => {
  it('passes on the design-gate source tree', () => {
    const report = analyzeGraph(root);
    expect(report.violations, JSON.stringify(report.violations, null, 2)).toEqual([]);
    expect(report.modules.some((m) => m.layer === 'nexus')).toBe(true);
    expect(report.modules.some((m) => m.layer === 'execution' && m.definesCircuitBreaker)).toBe(true);
    expect(report.modules.some((m) => m.layer === 'execution' && m.definesExecutionBroker)).toBe(true);
    expect(report.modules.some((m) => m.layer === 'conversation')).toBe(true);
    expect(report.modules.some((m) => m.layer === 'apps')).toBe(true);
  });

  it('fails when Nexus imports fetch transport', () => {
    const report = analyzeGraph(root, {
      'platform/nexus/src/forbidden-fetch.ts': `
        export async function probe(url: string): Promise<number> {
          const response = await fetch(url);
          return response.status;
        }
      `,
    });
    expect(report.violations.some((v) => v.rule === 'nexus-no-transport')).toBe(true);
  });

  it('fails when Nexus imports undici or HTTP modules', () => {
    const report = analyzeGraph(root, {
      'platform/nexus/src/forbidden-http.ts': `
        import { request } from 'undici';
        import * as https from 'node:https';
        export { request, https };
      `,
    });
    expect(report.violations.some((v) => v.rule === 'nexus-no-transport' && v.detail.includes('undici'))).toBe(
      true,
    );
    expect(report.violations.some((v) => v.detail.includes('node:https'))).toBe(true);
  });

  it('fails when Nexus imports a dungeon, jobs, storage, or Caspa', () => {
    const report = analyzeGraph(root, {
      'platform/nexus/src/forbidden-domain.ts': `
        import { writingDungeon } from '@atlas-vnext/dungeon-writing';
        import type { JobEngine } from '@atlas-vnext/jobs';
        import type { BlobStore } from '@atlas-vnext/storage';
        import { who } from '@ocrowley/osint';
        export { writingDungeon, who };
        export type { JobEngine, BlobStore };
      `,
    });
    expect(report.violations.some((v) => v.rule === 'nexus-layer-import' && v.detail.includes('dungeon'))).toBe(
      true,
    );
    expect(report.violations.some((v) => v.rule === 'nexus-layer-import' && v.detail.includes('jobs'))).toBe(true);
    expect(report.violations.some((v) => v.rule === 'nexus-layer-import' && v.detail.includes('storage'))).toBe(
      true,
    );
    expect(report.violations.some((v) => v.rule === 'nexus-no-legacy')).toBe(true);
  });

  it('fails when Nexus depends on execution, sqlite, or retry libraries in package.json', () => {
    const report = analyzeGraph(root, {
      'platform/nexus/package.json': JSON.stringify({
        name: '@atlas-vnext/nexus',
        dependencies: {
          '@atlas-vnext/contracts': '*',
          '@atlas-vnext/execution': '*',
          'better-sqlite3': '^11.0.0',
          axios: '^1.0.0',
        },
      }),
    });
    expect(report.violations.some((v) => v.rule === 'nexus-package-deps' && v.detail.includes('execution'))).toBe(
      true,
    );
    expect(report.violations.some((v) => v.detail.includes('better-sqlite3'))).toBe(true);
    expect(report.violations.some((v) => v.detail.includes('axios'))).toBe(true);
  });

  it('fails when Nexus defines a circuit breaker', () => {
    const report = analyzeGraph(root, {
      'platform/nexus/src/forbidden-breaker.ts': `
        export class CircuitBreaker {
          isOpen() { return false; }
        }
      `,
    });
    expect(report.violations.some((v) => v.rule === 'nexus-no-circuit-breaker')).toBe(true);
  });

  it('fails when a dungeon imports another dungeon', () => {
    const report = analyzeGraph(root, {
      'dungeons/writing/src/forbidden-peer.ts': `
        import { osintDungeon } from '@atlas-vnext/dungeon-osint';
        export const leak = osintDungeon;
      `,
    });
    expect(report.violations.some((v) => v.rule === 'dungeon-isolation')).toBe(true);
  });

  it('fails when a dungeon imports a provider adapter directly', () => {
    const report = analyzeGraph(root, {
      'dungeons/osint/src/forbidden-adapter.ts': `
        import { MockAdapter } from '../../platform/execution/src/adapters/mock.ts';
        import OpenAI from 'openai';
        export { MockAdapter, OpenAI };
      `,
    });
    expect(report.violations.some((v) => v.rule === 'dungeon-no-adapters')).toBe(true);
  });

  it('fails when execution imports Nexus or a dungeon', () => {
    const report = analyzeGraph(root, {
      'platform/execution/src/forbidden-nexus.ts': `
        import { NexusRouter } from '@atlas-vnext/nexus';
        import { writingDungeon } from '@atlas-vnext/dungeon-writing';
        export { NexusRouter, writingDungeon };
      `,
    });
    expect(report.violations.some((v) => v.rule === 'execution-no-policy-or-domain')).toBe(true);
  });

  it('fails when a platform primitive imports a product dungeon', () => {
    const report = analyzeGraph(root, {
      'platform/jobs/src/forbidden-dungeon.ts': `
        import { osintDungeon } from '@atlas-vnext/dungeon-osint';
        export const leak = osintDungeon;
      `,
    });
    expect(report.violations.some((v) => v.rule === 'platform-no-dungeons')).toBe(true);
  });

  it('fails when an app imports a provider SDK instead of contracts', () => {
    const report = analyzeGraph(root, {
      'apps/web/src/forbidden-sdk.ts': `
        import OpenAI from 'openai';
        export const client = OpenAI;
      `,
    });
    expect(report.violations.some((v) => v.rule === 'apps-no-provider-impl')).toBe(true);
  });

  it('fails when the web UI imports execution or Nexus', () => {
    const report = analyzeGraph(root, {
      'apps/web/src/forbidden-execution.ts': `
        import { ExecutionBroker } from '@atlas-vnext/execution';
        import { NexusRouter } from '@atlas-vnext/nexus';
        export { ExecutionBroker, NexusRouter };
      `,
    });
    expect(report.violations.some((v) => v.rule === 'apps-no-provider-impl' && v.detail.includes('execution'))).toBe(true);
    expect(report.violations.some((v) => v.rule === 'apps-no-provider-impl' && v.detail.includes('nexus'))).toBe(true);
  });

  it('fails when conversation domain imports Nexus, execution, or adapters', () => {
    const report = analyzeGraph(root, {
      'platform/conversation/src/forbidden-wiring.ts': `
        import { NexusRouter } from '@atlas-vnext/nexus';
        import { MockAdapter } from '../../execution/src/adapters/mock.ts';
        export { NexusRouter, MockAdapter };
      `,
    });
    expect(report.violations.some((v) => v.rule === 'conversation-ports-only')).toBe(true);
    expect(report.violations.some((v) => v.rule === 'conversation-no-adapters')).toBe(true);
  });

  it('fails when conversation package.json depends on execution', () => {
    const report = analyzeGraph(root, {
      'platform/conversation/package.json': JSON.stringify({
        name: '@atlas-vnext/conversation',
        dependencies: {
          '@atlas-vnext/contracts': '*',
          '@atlas-vnext/execution': '*',
        },
      }),
    });
    expect(report.violations.some((v) => v.rule === 'conversation-package-deps' && v.detail.includes('execution'))).toBe(
      true,
    );
  });

  it('fails CI when the committed negative fixture is treated as Nexus source', () => {
    const fixture = readFileSync(resolve(root, 'tests/architecture/fixtures/violations/nexus-forbidden.ts'), 'utf8');
    const report = analyzeGraph(root, {
      'platform/nexus/src/from-negative-fixture.ts': fixture,
    });
    expect(report.violations.some((v) => v.rule === 'nexus-no-transport')).toBe(true);
    expect(report.violations.some((v) => v.rule === 'nexus-layer-import')).toBe(true);
  });

  it('fails when Nexus reads process.env', () => {
    const report = analyzeGraph(root, {
      'platform/nexus/src/forbidden-env.ts': `
        export const key = process.env.OPENAI_API_KEY;
      `,
    });
    expect(report.violations.some((v) => v.rule === 'nexus-no-secrets')).toBe(true);
  });

  it('fails when an execution adapter reads process.env instead of SecretStore', () => {
    const report = analyzeGraph(root, {
      'platform/execution/src/adapters/leaky.ts': `
        export function leak() {
          return process.env.OPENAI_API_KEY;
        }
      `,
    });
    expect(report.violations.some((v) => v.rule === 'execution-secrets-abstraction')).toBe(true);
  });

  it('fails when the web UI reads process.env', () => {
    const report = analyzeGraph(root, {
      'apps/web/src/forbidden-env.ts': `
        export const key = process.env.OPENAI_API_KEY;
      `,
    });
    expect(report.violations.some((v) => v.rule === 'apps-no-secrets')).toBe(true);
  });
});
