import { describe, expect, it } from 'vitest';
import { NexusRegistry, NexusRouter } from '@atlas-vnext/nexus';
import type { RegisteredModel } from '@atlas-vnext/contracts';

function model(partial: Partial<RegisteredModel> & Pick<RegisteredModel, 'provider' | 'model' | 'label'>): RegisteredModel {
  return {
    contextWindow: 32_768,
    costClass: 'medium',
    latencyClass: 'fast',
    locality: 'public_cloud',
    health: 'healthy',
    privacyEligibility: 'any',
    runtimeRequirements: [],
    runtimeClass: 'always_available',
    ...partial,
    capabilities: {
      text: true,
      reasoning: false,
      tools: true,
      vision: false,
      code: false,
      ...partial.capabilities,
    },
  };
}

/** Frozen catalogue used for deterministic routing assertions. */
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
      privacyEligibility: 'local_only',
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
  it('resolves nexus/fast to the first healthy fast candidate (deterministic fixture)', () => {
    const { router } = harness();
    expect(router.resolve('nexus/fast').resolvedRouteId).toBe('openai/gpt-4o');
  });

  it('resolves nexus/reason to a reasoning model', () => {
    const { router } = harness();
    expect(router.resolve('nexus/reason').resolvedRouteId).toBe('anthropic/claude-sonnet');
  });

  it('resolves nexus/code to a code-capable model', () => {
    const { router } = harness();
    expect(router.resolve('nexus/code').resolvedRouteId).toBe('openai/gpt-4o');
  });

  it('resolves nexus/vision without selecting local llama', () => {
    const { router } = harness();
    const decision = router.resolve('nexus/vision');
    expect(decision.resolvedRouteId).toBe('openai/gpt-4o');
    expect(decision.candidateChain).not.toContain('ollama/llama3.2');
  });

  it('resolves nexus/frontier to a high-capability model', () => {
    const { router } = harness();
    expect(router.resolve('nexus/frontier').resolvedRouteId).toBe('anthropic/claude-sonnet');
  });

  it('honours explicit provider/model routes', () => {
    const { router } = harness();
    const decision = router.resolve('openai/gpt-4o');
    expect(decision.candidateChain).toEqual(['openai/gpt-4o']);
    expect(decision.decisionReason).toMatch(/Explicit/);
  });

  it('rejects missing explicit providers', () => {
    const { router } = harness();
    expect(() => router.resolve('venice/uncensored')).toThrow(/not registered/);
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

  it('mountain-compat: keeps nexus/local on local models only', () => {
    const { router } = harness();
    const decision = router.resolve('nexus/local');
    expect(decision.localOnly).toBe(true);
    expect(decision.resolvedRouteId).toBe('ollama/llama3.2');
    expect(decision.candidateChain.every((id) => id.startsWith('ollama/'))).toBe(true);
  });

  it('mountain-compat: enforces local-only privacy policy even on non-local aliases', () => {
    const { router } = harness();
    const decision = router.resolve('nexus/fast', { privacy: 'local_only' });
    expect(decision.localOnly).toBe(true);
    expect(decision.resolvedRouteId).toBe('ollama/llama3.2');
    expect(() => router.resolve('openai/gpt-4o', { privacy: 'local_only' })).toThrow(/local-only privacy/);
  });

  it('resolves nexus/cheap to the free local model', () => {
    const { router } = harness();
    expect(router.resolve('nexus/cheap').resolvedRouteId).toBe('ollama/llama3.2');
  });

  it('does not change unrelated aliases when a new provider is added', () => {
    const { registry, router } = harness();
    const reasonBefore = router.resolve('nexus/reason').resolvedRouteId;
    const fastBefore = router.resolve('nexus/fast').resolvedRouteId;
    registry.register(
      model({
        provider: 'venice',
        model: 'uncensored',
        label: 'Venice',
        latencyClass: 'medium',
        costClass: 'low',
        capabilities: { text: true, reasoning: false, tools: false, vision: false, code: false },
      }),
    );
    expect(router.resolve('nexus/reason').resolvedRouteId).toBe(reasonBefore);
    expect(router.resolve('nexus/fast').resolvedRouteId).toBe(fastBefore);
    expect(router.resolve('nexus/cheap').candidateChain).toContain('venice/uncensored');
  });

  it('rejects malformed provider metadata at the registration boundary', () => {
    const registry = new NexusRegistry();
    expect(() =>
      registry.register({
        provider: '',
        model: 'x',
        label: 'bad',
        capabilities: { text: true, reasoning: false, tools: false, vision: false, code: false },
        contextWindow: 100,
        costClass: 'low',
        latencyClass: 'fast',
        locality: 'public_cloud',
      }),
    ).toThrow();
    expect(() =>
      registry.register({
        provider: 'openai',
        model: 'gpt',
        label: 'GPT',
        contextWindow: -1,
        costClass: 'medium',
        latencyClass: 'fast',
        locality: 'public_cloud',
      }),
    ).toThrow();
    expect(registry.list()).toEqual([]);
  });

  it('does not invoke provider adapters; adapter exceptions cannot crash the router', () => {
    const { router } = harness();
    const explodingAdapter = {
      stream() {
        throw new Error('adapter exploded');
      },
    };
    expect(() => router.resolve('nexus/fast')).not.toThrow();
    expect(() => explodingAdapter.stream()).toThrow(/adapter exploded/);
    expect(router.resolve('nexus/reason').provider).toBe('anthropic');
  });

  it('excludes unavailable providers from alias chains', () => {
    const { registry, router } = harness();
    registry.setHealth('openai', 'unavailable');
    const decision = router.resolve('nexus/fast');
    expect(decision.candidateChain.every((id) => !id.startsWith('openai/'))).toBe(true);
  });

  it('mountain-compat: does not wake expensive burst capacity when private-hosted Forge can satisfy', () => {
    const { registry, router } = harness();
    registry.register(
      model({
        provider: 'forge',
        model: 'qwen3',
        label: 'Forge Qwen',
        costClass: 'free',
        latencyClass: 'fast',
        locality: 'private_cloud',
        runtimeClass: 'private_hosted',
        runtimeRequirements: ['forge'],
      }),
    );
    registry.register(
      model({
        provider: 'runpod',
        model: 'llm',
        label: 'RunPod LLM',
        costClass: 'high',
        latencyClass: 'fast',
        locality: 'private_cloud',
        runtimeClass: 'expensive_burst',
        runtimeRequirements: ['runpod'],
      }),
    );
    const cheap = router.resolve('nexus/cheap', { availableRuntimes: ['ollama', 'forge', 'runpod'] });
    expect(cheap.resolvedRouteId).toBe('ollama/llama3.2');
    expect(cheap.candidateChain.indexOf('forge/qwen3')).toBeLessThan(cheap.candidateChain.indexOf('runpod/llm'));
    registry.setHealth('ollama', 'unavailable');
    registry.setHealth('openai', 'unavailable');
    registry.setHealth('gemini', 'unavailable');
    const privateFirst = router.resolve('nexus/fast', { availableRuntimes: ['forge', 'runpod'] });
    expect(privateFirst.resolvedRouteId).toBe('forge/qwen3');
    expect(privateFirst.candidateChain[0]).not.toBe('runpod/llm');
  });

  it('enforces runtime requirements on explicit routes', () => {
    const registry = new NexusRegistry();
    registry.register(
      model({
        provider: 'openai',
        model: 'gpt-4o',
        label: 'GPT-4o',
        runtimeRequirements: ['openai'],
      }),
    );
    const router = new NexusRouter(registry);
    expect(() => router.resolve('openai/gpt-4o', { availableRuntimes: ['ollama'] })).toThrow(/requires runtime openai/);
    expect(router.resolve('openai/gpt-4o', { availableRuntimes: ['openai'] }).resolvedRouteId).toBe('openai/gpt-4o');
  });
});
