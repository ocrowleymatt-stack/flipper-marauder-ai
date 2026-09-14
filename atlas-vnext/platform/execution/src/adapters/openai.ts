import type { SecretStore } from '../secrets.ts';
import type { HttpTransport } from '../transport.ts';
import { MapSecretStore, xaiApiKey } from '../secrets.ts';
import { OpenAICompatibleAdapter } from './openai-compatible.ts';

export function createOpenAIAdapter(options: {
  secrets: SecretStore;
  transport: HttpTransport;
  timeoutMs: number;
  baseUrl: string;
  modelMap?: Record<string, string>;
}): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    providerId: 'openai',
    baseUrl: options.baseUrl,
    secretName: 'OPENAI_API_KEY',
    secrets: options.secrets,
    transport: options.transport,
    timeoutMs: options.timeoutMs,
    modelMap: options.modelMap,
    authHeaders: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  });
}

export function createVeniceAdapter(options: {
  secrets: SecretStore;
  transport: HttpTransport;
  timeoutMs: number;
  baseUrl: string;
  modelMap?: Record<string, string>;
}): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    providerId: 'venice',
    baseUrl: options.baseUrl,
    secretName: 'VENICE_API_KEY',
    secrets: options.secrets,
    transport: options.transport,
    timeoutMs: options.timeoutMs,
    modelMap: options.modelMap,
    extraBody: { venice_parameters: { include_venice_system_prompt: false } },
    authHeaders: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  });
}

/**
 * xAI Grok. OpenAI-compatible Chat Completions at api.x.ai.
 * Do not duplicate transport — this is a configured OpenAICompatibleAdapter.
 */
export function createXaiAdapter(options: {
  secrets: SecretStore;
  transport: HttpTransport;
  timeoutMs: number;
  baseUrl: string;
  modelMap?: Record<string, string>;
}): OpenAICompatibleAdapter {
  const key = xaiApiKey(options.secrets);
  return new OpenAICompatibleAdapter({
    providerId: 'xai',
    baseUrl: options.baseUrl,
    secretName: 'XAI_API_KEY',
    secrets: new MapSecretStore({ XAI_API_KEY: key }),
    transport: options.transport,
    timeoutMs: options.timeoutMs,
    modelMap: options.modelMap,
    authHeaders: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  });
}
