import { describe, expect, it } from 'vitest';
import { NexusRegistry, NexusRouter } from '@atlas-vnext/nexus';
import type { RegisteredModel } from '@atlas-vnext/contracts';

function model(partial: Partial<RegisteredModel> & Pick<RegisteredModel, 'provider' | 'model' | 'label'>): RegisteredModel {
  return {
    capabilities: { text: true, reasoning: false, tools: true, vision: false, code: false },
    contextWindow: 32_768,
    costClass: 'medium',
    latencyClass: 'fast',
    locality: 'cloud',
    health: 'healthy',
    ...partial,
  };
}

function harness() {
  const registry = new NexusRegistry();
  registry.register(
    model({
      provider: 'anthropic',
      model: 'claude-sonnet',
      label: 'Claude Sonnet',
      capabilities: { text: true, reasoning: true, tools: true, vision: true, code: true },
      contextWindow: 200_000,
      costClass: 'high',
      latencyClass: 'medium',
    }),
  );
  registry.register(
    model({
      provider: 'openai',
      model: 'gpt-4o',
      label: 'GPT-4o',
      capabilities: { text: true, reasoning: false, tools: true, vision: true, code: true },
      costClass: 'medium',
      latencyClass: 'fast',
    }),
  );
  registry.register(
    model({
      provider: 'ollama',
      model: 'llama3.2',
      label: 'Llama 3.2',
      costClass: 'free',
      latencyClass: 'fast',
      locality: 'local',
      contextWindow: 8192,
    }),
  );
  registry.register(
    model({
      provider: 'gemini',
      model: 'flash',
      label: 'Gemini Flash',
      capabilities: { text: true, reasoning: false, tools: true, vision: true, code: true },
      costClass: 'low',
      latencyClass: 'fast',
    }),
  );
  return { registry, router: new NexusRouter(registry) };
}

describe('Nexus router (policy only)', () => {
  it('resolves nexus/fast to a fast candidate', () => {
    const { router } = harness();
    const decision = router.resolve('nexus/fast');
    expect(['openai/gpt-4o', 'ollama/llama3.2', 'gemini/flash']).toContain(decision.resolvedRouteId);
  });

  it('resolves nexus/reason to a reasoning model', () => {
    const { router } = harness();
    expect(router.resolve('nexus/reason').resolvedRouteId).toBe('anthropic/claude-sonnet');
  });

  it('resolves nexus/code to a code-capable model', () => {
    const { router } = harness();
    expect(['anthropic/claude-sonnet', 'openai/gpt-4o', 'gemini/flash']).toContain(
      router.resolve('nexus/code').resolvedRouteId,
    );
  });

  it('resolves nexus/vision without selecting local llama', () => {
    const { router } = harness();
    const decision = router.resolve('nexus/vision');
    expect(decision.resolvedRouteId).not.toBe('ollama/llama3.2');
  });

  it('honours explicit provider/model routes', () => {
    const { router } = harness();
    const decision = router.resolve('openai/gpt-4o');
    expect(decision.candidateChain).toEqual(['openai/gpt-4o']);
    expect(decision.decisionReason).toMatch(/Explicit/);
  });

  it('excludes unhealthy providers', () => {
    const { registry, router } = harness();
    registry.setHealth('anthropic', 'unhealthy');
    expect(() => router.resolve('nexus/reason')).toThrow(/No healthy candidates/);
    expect(router.resolve('nexus/fast').candidateChain.some((id) => id.startsWith('anthropic/'))).toBe(false);
  });

  it('rejects tools-incapable models when tools are required', () => {
    const { registry, router } = harness();
    registry.register(
      model({
        provider: 'toy',
        model: 'no-tools',
        label: 'No Tools',
        capabilities: { text: true, reasoning: false, tools: false, vision: false, code: false },
        latencyClass: 'fast',
        costClass: 'free',
      }),
    );
    const decision = router.resolve('nexus/fast', { requireTools: true });
    expect(decision.candidateChain).not.toContain('toy/no-tools');
  });

  it('rejects prompts that exceed context window', () => {
    const { router } = harness();
    expect(() => router.resolve('ollama/llama3.2', { contextTokens: 50_000 })).toThrow(/exceeds context limit/);
  });

  it('keeps nexus/local on local models only', () => {
    const { router } = harness();
    const decision = router.resolve('nexus/local');
    expect(decision.localOnly).toBe(true);
    expect(decision.resolvedRouteId).toBe('ollama/llama3.2');
  });

  it('resolves nexus/cheap to the free local model', () => {
    const { router } = harness();
    expect(router.resolve('nexus/cheap').resolvedRouteId).toBe('ollama/llama3.2');
  });
});
