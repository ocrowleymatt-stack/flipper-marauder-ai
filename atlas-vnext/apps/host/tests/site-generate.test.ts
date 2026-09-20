import { describe, expect, it } from 'vitest';
import { DEFAULT_OPERATIONAL_LIMITS, type RouteDecision } from '@atlas-vnext/contracts';
import type { CapabilityRouter, ModelExecutor } from '@atlas-vnext/conversation';
import { ResourceGuard } from '../src/limits.ts';
import { NodeSiteGenerate } from '../src/site-generate.ts';

const decision: RouteDecision = {
  target: 'nexus/code',
  resolvedRouteId: 'mock',
  provider: 'mock',
  model: 'mock-html',
  candidateChain: ['mock'],
  localOnly: false,
  locality: 'public_cloud',
  runtimeClass: 'always_available',
  decisionReason: 'test',
  traceId: 'trace',
  evaluatedAt: '2026-09-20T00:00:00.000Z',
};

function router(): CapabilityRouter {
  return { resolve: () => decision };
}

function textExecutor(chunks: string[], hang?: Promise<void>): ModelExecutor {
  return {
    async *execute() {
      for (const text of chunks) yield { type: 'text', text };
      if (hang) await hang;
    },
  };
}

describe('NodeSiteGenerate resource guards', () => {
  it('aborts before returning HTML over the generated-output byte limit', async () => {
    const resources = new ResourceGuard({ ...DEFAULT_OPERATIONAL_LIMITS, maxGeneratedBytes: 8 });
    const port = new NodeSiteGenerate(router(), textExecutor(['abcdefghij']), resources);
    await expect(port.generateHtml({ brief: 'Build a website about cocoa.', tenantId: 'tenant_a' })).rejects.toMatchObject({
      name: 'PlatformHttpError',
      code: 'payload_too_large',
      httpStatus: 413,
    });
    expect(resources.occupancy('tenant_a').runs).toBe(0);
  });

  it('admits direct generate through the concurrent-run guard', async () => {
    const resources = new ResourceGuard({ ...DEFAULT_OPERATIONAL_LIMITS, maxConcurrentRuns: 1 });
    let releaseHang!: () => void;
    const hang = new Promise<void>((resolve) => {
      releaseHang = resolve;
    });
    const busy = new NodeSiteGenerate(router(), textExecutor(['<p>ok</p>'], hang), resources);
    const blocked = new NodeSiteGenerate(router(), textExecutor(['<p>no</p>']), resources);
    const first = busy.generateHtml({ brief: 'Build a website about cocoa tents.', tenantId: 'tenant_a' });
    await expect
      .poll(() => resources.occupancy('tenant_a').runs, { timeout: 1_000 })
      .toBe(1);
    await expect(blocked.generateHtml({ brief: 'Build a website about cocoa tents.', tenantId: 'tenant_a' })).rejects.toMatchObject({
      name: 'PlatformHttpError',
      code: 'rate_limit',
      httpStatus: 429,
    });
    releaseHang();
    await expect(first).resolves.toEqual({ html: '<p>ok</p>' });
    expect(resources.occupancy('tenant_a').runs).toBe(0);
  });
});
