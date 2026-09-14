import { SECRET_KEYS } from './secrets.ts';

export interface ExecutionConfig {
  timeoutMs: number;
  attemptsPerCandidate: number;
  ollamaBaseUrl: string;
  openaiBaseUrl: string;
  anthropicBaseUrl: string;
  geminiBaseUrl: string;
  veniceBaseUrl: string;
}

const DEFAULTS: ExecutionConfig = {
  timeoutMs: 60_000,
  attemptsPerCandidate: 2,
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  openaiBaseUrl: 'https://api.openai.com/v1',
  anthropicBaseUrl: 'https://api.anthropic.com',
  geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  veniceBaseUrl: 'https://api.venice.ai/api/v1',
};

/**
 * Execution runtime configuration. The composition root may pass `process.env`
 * once; adapters never read the environment themselves.
 */
export function readExecutionConfig(env: Record<string, string | undefined> = process.env): ExecutionConfig {
  return {
    timeoutMs: readPositiveInt(env.ATLAS_PROVIDER_TIMEOUT_MS, DEFAULTS.timeoutMs),
    attemptsPerCandidate: readPositiveInt(env.ATLAS_PROVIDER_ATTEMPTS, DEFAULTS.attemptsPerCandidate),
    ollamaBaseUrl: trimSlash(env.ATLAS_OLLAMA_URL ?? env.OLLAMA_HOST ?? DEFAULTS.ollamaBaseUrl),
    openaiBaseUrl: trimSlash(env.ATLAS_OPENAI_BASE_URL ?? DEFAULTS.openaiBaseUrl),
    anthropicBaseUrl: trimSlash(env.ATLAS_ANTHROPIC_BASE_URL ?? DEFAULTS.anthropicBaseUrl),
    geminiBaseUrl: trimSlash(env.ATLAS_GEMINI_BASE_URL ?? DEFAULTS.geminiBaseUrl),
    veniceBaseUrl: trimSlash(env.ATLAS_VENICE_BASE_URL ?? DEFAULTS.veniceBaseUrl),
  };
}

export function listedSecretNames(): string[] {
  return Object.values(SECRET_KEYS);
}

function trimSlash(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}
