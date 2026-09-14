import { SECRET_KEYS } from './secrets.ts';

export type ForgeProtocol = 'openai' | 'ollama';

export interface ExecutionConfig {
  timeoutMs: number;
  attemptsPerCandidate: number;
  ollamaBaseUrl: string;
  openaiBaseUrl: string;
  anthropicBaseUrl: string;
  geminiBaseUrl: string;
  veniceBaseUrl: string;
  xaiBaseUrl: string;
  forgeBaseUrl: string | null;
  forgeProtocol: ForgeProtocol;
  forgeChatPath: string;
  forgeHealthPath: string;
  runpodApiBaseUrl: string;
  runpodPodId: string | null;
  runpodInferenceBaseUrl: string | null;
  runpodInferencePort: number;
  runpodModel: string;
  runpodIdleShutdownSeconds: number;
  runpodMaxActivePods: number;
  runpodWarmTimeoutMs: number;
  runpodLeaseTtlSeconds: number;
  runtimeStatePath: string | null;
}

const DEFAULTS = {
  timeoutMs: 60_000,
  attemptsPerCandidate: 2,
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  openaiBaseUrl: 'https://api.openai.com/v1',
  anthropicBaseUrl: 'https://api.anthropic.com',
  geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  veniceBaseUrl: 'https://api.venice.ai/api/v1',
  xaiBaseUrl: 'https://api.x.ai/v1',
  forgeChatPath: '/v1/chat/completions',
  forgeHealthPath: '/v1/models',
  runpodApiBaseUrl: 'https://rest.runpod.io/v1',
  runpodInferencePort: 8000,
  runpodModel: 'llm',
  /** Short enough to prevent runaway spend; long enough to reuse a warm pod. */
  runpodIdleShutdownSeconds: 120,
  runpodMaxActivePods: 1,
  runpodWarmTimeoutMs: 180_000,
  runpodLeaseTtlSeconds: 900,
} as const;

/**
 * Execution runtime configuration. The composition root may pass `process.env`
 * once; adapters never read the environment themselves.
 */
export function readExecutionConfig(env: Record<string, string | undefined> = process.env): ExecutionConfig {
  const requestedMaxPods = readPositiveInt(env.RUNPOD_MAX_ACTIVE_PODS, DEFAULTS.runpodMaxActivePods);
  return {
    timeoutMs: readPositiveInt(env.ATLAS_PROVIDER_TIMEOUT_MS, DEFAULTS.timeoutMs),
    attemptsPerCandidate: readPositiveInt(env.ATLAS_PROVIDER_ATTEMPTS, DEFAULTS.attemptsPerCandidate),
    ollamaBaseUrl: trimSlash(env.ATLAS_OLLAMA_URL ?? env.OLLAMA_HOST ?? DEFAULTS.ollamaBaseUrl),
    openaiBaseUrl: trimSlash(env.ATLAS_OPENAI_BASE_URL ?? DEFAULTS.openaiBaseUrl),
    anthropicBaseUrl: trimSlash(env.ATLAS_ANTHROPIC_BASE_URL ?? DEFAULTS.anthropicBaseUrl),
    geminiBaseUrl: trimSlash(env.ATLAS_GEMINI_BASE_URL ?? DEFAULTS.geminiBaseUrl),
    veniceBaseUrl: trimSlash(env.ATLAS_VENICE_BASE_URL ?? DEFAULTS.veniceBaseUrl),
    xaiBaseUrl: trimSlash(env.ATLAS_XAI_BASE_URL ?? DEFAULTS.xaiBaseUrl),
    forgeBaseUrl: optionalUrl(
      env.ATLAS_FORGE_BASE_URL ?? env.ATLAS_HETZNER_INFERENCE_URL ?? env.FORGE_BASE_URL ?? env.HETZNER_INFERENCE_URL,
    ),
    forgeProtocol: env.ATLAS_FORGE_PROTOCOL === 'ollama' ? 'ollama' : 'openai',
    forgeChatPath: env.ATLAS_FORGE_CHAT_PATH?.trim() || DEFAULTS.forgeChatPath,
    forgeHealthPath: env.ATLAS_FORGE_HEALTH_PATH?.trim() || DEFAULTS.forgeHealthPath,
    runpodApiBaseUrl: trimSlash(env.ATLAS_RUNPOD_API_BASE_URL ?? DEFAULTS.runpodApiBaseUrl),
    runpodPodId: optionalText(env.RUNPOD_POD_ID ?? env.ATLAS_RUNPOD_POD_ID),
    runpodInferenceBaseUrl: optionalUrl(env.RUNPOD_INFERENCE_BASE_URL ?? env.ATLAS_RUNPOD_INFERENCE_URL),
    runpodInferencePort: readPositiveInt(env.RUNPOD_INFERENCE_PORT, DEFAULTS.runpodInferencePort),
    runpodModel: optionalText(env.RUNPOD_MODEL) ?? DEFAULTS.runpodModel,
    runpodIdleShutdownSeconds: readPositiveInt(env.RUNPOD_IDLE_SHUTDOWN_SECONDS, DEFAULTS.runpodIdleShutdownSeconds),
    runpodMaxActivePods: Math.min(1, requestedMaxPods),
    runpodWarmTimeoutMs: readPositiveInt(env.RUNPOD_WARM_TIMEOUT_MS, DEFAULTS.runpodWarmTimeoutMs),
    runpodLeaseTtlSeconds: readPositiveInt(env.RUNPOD_LEASE_TTL_SECONDS, DEFAULTS.runpodLeaseTtlSeconds),
    runtimeStatePath: optionalText(env.ATLAS_RUNTIME_STATE_PATH),
  };
}

export function listedSecretNames(): string[] {
  return Object.values(SECRET_KEYS);
}

function trimSlash(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function optionalText(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

function optionalUrl(raw: string | undefined): string | null {
  const trimmed = optionalText(raw);
  return trimmed ? trimSlash(trimmed) : null;
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}
