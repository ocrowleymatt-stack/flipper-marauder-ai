import { describe, expect, it } from 'vitest';

import { contractRegistry, withHealth } from '@atlas/testing';

import { NexusRouter, RouteError } from '../src/index.js';

function key(providerId: string, modelId: string) {
  return `${providerId}/${modelId}`;
}

describe('Nexus contract: alias resolution', () => {
  const router = new NexusRouter(contractRegistry());

  it('resolves nexus/fast to a healthy low-latency text model', () => {
    const decision = router.resolve({ schemaVersion: 1, alias: 'nexus/fast' });
    const primary = decision.candidates[0]!;
    const model = contractRegistry().models.find((item) => item.providerId === primary.providerId && item.id === primary.modelId)!;
    expect(model.capabilities.text).toBe(true);
    expect(model.latencyClass).toBe('low');
    expect(model.health).toBe('healthy');
    expect(decision.trace.alias).toBe('nexus/fast');
    expect(decision.trace.selected[0]).toBe(key(primary.providerId, primary.modelId));
  });

  it('resolves nexus/reason to a reasoning model', () => {
    const decision = router.resolve({ schemaVersion: 1, alias: 'nexus/reason' });
    const primary = decision.candidates[0]!;
    expect(primary.providerId).toBe('anthropic');
    expect(primary.modelId).toBe('claude-reason');
    expect(decision.candidates.every((candidate) => {
      const model = contractRegistry().models.find((item) => item.providerId === candidate.providerId && item.id === candidate.modelId);
      return model?.capabilities.reasoning;
    })).toBe(true);
  });

  it('resolves nexus/code to a tools+code model', () => {
    const decision = router.resolve({ schemaVersion: 1, alias: 'nexus/code' });
    const primary = decision.candidates[0]!;
    const model = contractRegistry().models.find((item) => item.providerId === primary.providerId && item.id === primary.modelId)!;
    expect(model.capabilities.code).toBe(true);
    expect(model.capabilities.tools).toBe(true);
  });

  it('resolves nexus/vision to a vision model', () => {
    const decision = router.resolve({ schemaVersion: 1, alias: 'nexus/vision' });
    const primary = decision.candidates[0]!;
    const model = contractRegistry().models.find((item) => item.providerId === primary.providerId && item.id === primary.modelId)!;
    expect(model.capabilities.vision).toBe(true);
    expect(primary.providerId).toBe('gemini');
  });

  it('resolves nexus/cheap by lowest cost class that can answer', () => {
    const decision = router.resolve({ schemaVersion: 1, alias: 'nexus/cheap' });
    const primary = decision.candidates[0]!;
    expect(primary.providerId).toBe('ollama');
    expect(primary.modelId).toBe('llama-local');
    const costs = decision.candidates.map((candidate) => {
      const model = contractRegistry().models.find((item) => item.providerId === candidate.providerId && item.id === candidate.modelId)!;
      return model.costClass;
    });
    expect(costs[0]).toBe('zero');
  });

  it('resolves nexus/frontier to a high cost-class reasoning model', () => {
    const decision = router.resolve({ schemaVersion: 1, alias: 'nexus/frontier' });
    const primary = decision.candidates[0]!;
    expect(primary.providerId).toBe('anthropic');
    expect(primary.modelId).toBe('claude-reason');
  });

  it('resolves nexus/local to locality=local only', () => {
    const decision = router.resolve({ schemaVersion: 1, alias: 'nexus/local' });
    expect(decision.candidates.length).toBeGreaterThan(0);
    for (const candidate of decision.candidates) {
      const model = contractRegistry().models.find((item) => item.providerId === candidate.providerId && item.id === candidate.modelId)!;
      expect(model.locality).toBe('local');
    }
  });
});

describe('Nexus contract: explicit, health, requirements', () => {
  const router = new NexusRouter(contractRegistry());

  it('routes an explicit provider/model pair', () => {
    const decision = router.resolve({
      schemaVersion: 1,
      explicit: { providerId: 'openai', modelId: 'gpt-code' },
    });
    expect(decision.candidates).toEqual([
      { providerId: 'openai', modelId: 'gpt-code', reason: 'explicit' },
    ]);
    expect(decision.trace.explicit).toEqual({ providerId: 'openai', modelId: 'gpt-code' });
    expect(decision.candidates).toHaveLength(1);
  });

  it('ignores alias when explicit is set', () => {
    const decision = router.resolve({
      schemaVersion: 1,
      alias: 'nexus/reason',
      explicit: { providerId: 'venice', modelId: 'deepseek-cheap' },
    });
    expect(decision.trace.aliasIgnored).toBe(true);
    expect(decision.candidates[0]?.modelId).toBe('deepseek-cheap');
  });

  it('excludes unhealthy models and unhealthy providers from alias candidates', () => {
    const decision = router.resolve({ schemaVersion: 1, alias: 'nexus/reason' });
    const selected = decision.trace.selected;
    expect(selected).not.toContain('openai/gpt-down');
    expect(selected).not.toContain('downcloud/ghost');
    expect(decision.trace.excluded.some((item) => item.modelId === 'gpt-down' && item.reason === 'unhealthy')).toBe(true);
    expect(decision.trace.excluded.some((item) => item.providerId === 'downcloud' && item.reason === 'unhealthy')).toBe(true);
  });

  it('fails closed when an explicit target is unhealthy', () => {
    expect(() =>
      router.resolve({
        schemaVersion: 1,
        explicit: { providerId: 'openai', modelId: 'gpt-down' },
      }),
    ).toThrowError(RouteError);
    try {
      router.resolve({ schemaVersion: 1, explicit: { providerId: 'openai', modelId: 'gpt-down' } });
    } catch (error) {
      expect(error).toBeInstanceOf(RouteError);
      expect((error as RouteError).code).toBe('route.explicit_unhealthy');
    }
  });

  it('fails closed when the explicit provider is unhealthy even if the model row is healthy', () => {
    try {
      router.resolve({ schemaVersion: 1, explicit: { providerId: 'downcloud', modelId: 'ghost' } });
      throw new Error('expected throw');
    } catch (error) {
      expect((error as RouteError).code).toBe('route.explicit_unhealthy');
    }
  });

  it('honours tool capability requirements', () => {
    const decision = router.resolve({
      schemaVersion: 1,
      alias: 'nexus/cheap',
      requirements: { tools: true },
    });
    for (const candidate of decision.candidates) {
      const model = contractRegistry().models.find((item) => item.providerId === candidate.providerId && item.id === candidate.modelId)!;
      expect(model.capabilities.tools).toBe(true);
    }
    expect(decision.trace.excluded.some((item) => item.modelId === 'deepseek-cheap' && item.reason === 'capability')).toBe(true);
  });

  it('respects context window limits', () => {
    const decision = router.resolve({
      schemaVersion: 1,
      alias: 'nexus/fast',
      requirements: { minContextWindow: 100_000 },
    });
    for (const candidate of decision.candidates) {
      const model = contractRegistry().models.find((item) => item.providerId === candidate.providerId && item.id === candidate.modelId)!;
      expect(model.contextWindow).toBeGreaterThanOrEqual(100_000);
    }
    expect(decision.trace.excluded.some((item) => item.reason === 'context_window')).toBe(true);
  });

  it('respects local-only policy even on a cloud alias', () => {
    const decision = router.resolve({
      schemaVersion: 1,
      alias: 'nexus/fast',
      policy: { localOnly: true },
    });
    expect(decision.candidates.every((candidate) => candidate.providerId === 'ollama')).toBe(true);
  });

  it('honours cheapest cost preference override', () => {
    const decision = router.resolve({
      schemaVersion: 1,
      alias: 'nexus/reason',
      policy: { costPreference: 'cheapest' },
    });
    // Only claude-reason is a healthy reasoning model in the fixture.
    expect(decision.candidates[0]?.modelId).toBe('claude-reason');
  });

  it('skips a primary that becomes unhealthy and still returns fallbacks', () => {
    const registry = withHealth(contractRegistry(), 'anthropic', 'claude-reason', 'unhealthy');
    const unhealthyRouter = new NexusRouter(registry);
    try {
      unhealthyRouter.resolve({ schemaVersion: 1, alias: 'nexus/reason' });
      throw new Error('expected no healthy reasoning fallback in this fixture');
    } catch (error) {
      expect((error as RouteError).code).toBe('route.no_candidate');
    }
  });

  it('rejects unknown explicit targets', () => {
    try {
      router.resolve({ schemaVersion: 1, explicit: { providerId: 'nope', modelId: 'nope' } });
      throw new Error('expected throw');
    } catch (error) {
      expect((error as RouteError).code).toBe('route.unknown_target');
    }
  });
});
