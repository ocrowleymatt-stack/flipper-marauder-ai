import type { RegisteredModel } from '@atlas-vnext/contracts';
import { NexusRegistry, NexusRouter } from '@atlas-vnext/nexus';

export function model(
  partial: Partial<RegisteredModel> & Pick<RegisteredModel, 'provider' | 'model' | 'label'>,
): RegisteredModel {
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

/** Frozen catalogue for Mountain-compat routing assertions. */
export function routingHarness() {
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
  registry.register(
    model({
      provider: 'xai',
      model: 'grok-build',
      label: 'Grok Build',
      // Host catalogue on main: alias grok-build → upstream grok-build-0.1.
      capabilities: { text: true, reasoning: true, tools: true, vision: true, code: true },
      contextWindow: 256_000,
      costClass: 'medium',
      latencyClass: 'fast',
      runtimeRequirements: ['xai'],
    }),
  );
  registry.register(
    model({
      provider: 'forge',
      model: 'qwen3',
      label: 'Forge Qwen',
      capabilities: { text: true, reasoning: false, tools: true, vision: true, code: true },
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
      capabilities: { text: true, reasoning: false, tools: true, vision: true, code: true },
      costClass: 'high',
      latencyClass: 'fast',
      locality: 'private_cloud',
      runtimeClass: 'expensive_burst',
      runtimeRequirements: ['runpod'],
    }),
  );
  return { registry, router: new NexusRouter(registry) };
}
