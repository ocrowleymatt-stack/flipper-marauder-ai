import type { RegisteredModel } from '@atlas-vnext/contracts';

/**
 * Dev/test catalogue. Health is recorded here; Nexus never probes providers.
 * Adding a model is a registry change, not a router rewrite.
 */
export const DEV_CATALOGUE: RegisteredModel[] = [
  {
    provider: 'openai',
    model: 'gpt-4o',
    label: 'GPT-4o',
    capabilities: { text: true, reasoning: false, tools: true, vision: true, code: true },
    contextWindow: 128_000,
    costClass: 'medium',
    latencyClass: 'fast',
    locality: 'cloud',
    health: 'healthy',
    privacyEligibility: 'any',
    runtimeRequirements: [],
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet',
    label: 'Claude Sonnet',
    capabilities: { text: true, reasoning: true, tools: true, vision: true, code: true },
    contextWindow: 200_000,
    costClass: 'high',
    latencyClass: 'medium',
    locality: 'cloud',
    health: 'healthy',
    privacyEligibility: 'any',
    runtimeRequirements: [],
  },
  {
    provider: 'gemini',
    model: 'flash',
    label: 'Gemini Flash',
    capabilities: { text: true, reasoning: false, tools: true, vision: true, code: true },
    contextWindow: 128_000,
    costClass: 'low',
    latencyClass: 'fast',
    locality: 'cloud',
    health: 'healthy',
    privacyEligibility: 'any',
    runtimeRequirements: [],
  },
  {
    provider: 'ollama',
    model: 'llama3.2',
    label: 'Llama 3.2',
    capabilities: { text: true, reasoning: false, tools: true, vision: false, code: false },
    contextWindow: 8192,
    costClass: 'free',
    latencyClass: 'fast',
    locality: 'local',
    health: 'healthy',
    privacyEligibility: 'local_only',
    runtimeRequirements: [],
  },
];
