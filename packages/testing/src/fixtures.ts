import type { ModelRecord, ProviderRecord, ProviderRegistry } from '@atlas/contracts';

function provider(
  id: string,
  locality: ProviderRecord['locality'],
  health: ProviderRecord['health'] = 'healthy',
): ProviderRecord {
  return { schemaVersion: 1, id, label: id, locality, health };
}

function model(partial: Omit<ModelRecord, 'schemaVersion' | 'label' | 'flagged'> & { label?: string; flagged?: boolean }): ModelRecord {
  return {
    schemaVersion: 1,
    label: partial.label ?? `${partial.providerId}/${partial.id}`,
    flagged: partial.flagged ?? false,
    ...partial,
  };
}

/**
 * Deterministic registry for Nexus contract tests.
 * Health, cost, locality and capabilities are the only levers; names are stable.
 */
export function contractRegistry(): ProviderRegistry {
  return {
    schemaVersion: 1,
    providers: [
      provider('hetzner', 'cloud'),
      provider('openai', 'cloud'),
      provider('anthropic', 'cloud'),
      provider('gemini', 'cloud'),
      provider('venice', 'cloud'),
      provider('ollama', 'local'),
      provider('runpod', 'cloud'),
      provider('downcloud', 'cloud', 'unhealthy'),
    ],
    models: [
      model({
        providerId: 'hetzner',
        id: 'forge-fast',
        capabilities: { text: true, reasoning: false, tools: true, vision: false, code: false },
        contextWindow: 32_000,
        costClass: 'low',
        latencyClass: 'low',
        locality: 'cloud',
        health: 'healthy',
      }),
      model({
        providerId: 'openai',
        id: 'gpt-code',
        capabilities: { text: true, reasoning: false, tools: true, vision: false, code: true },
        contextWindow: 128_000,
        costClass: 'medium',
        latencyClass: 'medium',
        locality: 'cloud',
        health: 'healthy',
      }),
      model({
        providerId: 'openai',
        id: 'gpt-vision',
        capabilities: { text: true, reasoning: false, tools: true, vision: true, code: false },
        contextWindow: 16_000,
        costClass: 'medium',
        latencyClass: 'medium',
        locality: 'cloud',
        health: 'healthy',
      }),
      model({
        providerId: 'anthropic',
        id: 'claude-reason',
        capabilities: { text: true, reasoning: true, tools: true, vision: false, code: true },
        contextWindow: 200_000,
        costClass: 'high',
        latencyClass: 'medium',
        locality: 'cloud',
        health: 'healthy',
      }),
      model({
        providerId: 'gemini',
        id: 'gemini-flash-vision',
        capabilities: { text: true, reasoning: false, tools: false, vision: true, code: false },
        contextWindow: 64_000,
        costClass: 'low',
        latencyClass: 'low',
        locality: 'cloud',
        health: 'healthy',
      }),
      model({
        providerId: 'venice',
        id: 'deepseek-cheap',
        capabilities: { text: true, reasoning: false, tools: false, vision: false, code: false },
        contextWindow: 8_192,
        costClass: 'low',
        latencyClass: 'low',
        locality: 'cloud',
        health: 'healthy',
      }),
      model({
        providerId: 'ollama',
        id: 'llama-local',
        capabilities: { text: true, reasoning: false, tools: true, vision: false, code: true },
        contextWindow: 8_192,
        costClass: 'zero',
        latencyClass: 'high',
        locality: 'local',
        health: 'healthy',
      }),
      model({
        providerId: 'runpod',
        id: 'bulk-gpu',
        capabilities: { text: true, reasoning: false, tools: false, vision: false, code: true },
        contextWindow: 32_000,
        costClass: 'low',
        latencyClass: 'high',
        locality: 'cloud',
        health: 'healthy',
      }),
      model({
        providerId: 'openai',
        id: 'gpt-down',
        capabilities: { text: true, reasoning: true, tools: true, vision: false, code: true },
        contextWindow: 128_000,
        costClass: 'high',
        latencyClass: 'low',
        locality: 'cloud',
        health: 'unhealthy',
      }),
      model({
        providerId: 'downcloud',
        id: 'ghost',
        capabilities: { text: true, reasoning: true, tools: true, vision: true, code: true },
        contextWindow: 1_000_000,
        costClass: 'zero',
        latencyClass: 'low',
        locality: 'cloud',
        health: 'healthy',
      }),
    ],
  };
}

export function withHealth(
  registry: ProviderRegistry,
  providerId: string,
  modelId: string,
  health: ModelRecord['health'],
): ProviderRegistry {
  return {
    ...registry,
    models: registry.models.map((item) =>
      item.providerId === providerId && item.id === modelId ? { ...item, health } : item,
    ),
  };
}
