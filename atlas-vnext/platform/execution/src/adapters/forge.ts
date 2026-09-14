import type { ProviderHealth } from '@atlas-vnext/contracts';
import { OllamaAdapter } from './ollama.ts';
import { OpenAICompatibleAdapter } from './openai-compatible.ts';
import { ProviderHttpError, connectionFailure, httpFailure } from '../errors.ts';
import { forgeApiKey, MapSecretStore, type SecretStore } from '../secrets.ts';
import { readAllText, type HttpTransport } from '../transport.ts';
import type { ProviderAdapter } from '../types.ts';

export interface ForgeAdapterOptions {
  secrets: SecretStore;
  transport: HttpTransport;
  timeoutMs: number;
  baseUrl: string;
  protocol: 'openai' | 'ollama';
  chatPath: string;
  healthPath: string;
  modelMap?: Record<string, string>;
}

/**
 * Private hosted inference on Hetzner.
 *
 * Accessible Atlas/Caspa trees treat Hetzner as the private-cloud host and
 * Forge as the inference service on that host (Ollama and/or an
 * OpenAI-compatible unified router). They are one runtime/provider
 * relationship: provider id `forge`, locality `private_cloud`.
 */
export function createForgeAdapter(options: ForgeAdapterOptions): ProviderAdapter {
  if (options.protocol === 'ollama') {
    return new OllamaAdapter({
      providerId: 'forge',
      transport: options.transport,
      timeoutMs: options.timeoutMs,
      baseUrl: options.baseUrl,
      modelMap: options.modelMap,
    });
  }
  const key = forgeApiKey(options.secrets);
  return new OpenAICompatibleAdapter({
    providerId: 'forge',
    baseUrl: options.baseUrl,
    secretName: 'FORGE_API_KEY',
    secrets: new MapSecretStore({ FORGE_API_KEY: key }),
    transport: options.transport,
    timeoutMs: options.timeoutMs,
    modelMap: options.modelMap,
    chatPath: options.chatPath,
    includeStreamUsage: false,
    credentialsOptional: true,
    authHeaders: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  });
}

export async function probeForgeHealth(
  options: Pick<ForgeAdapterOptions, 'transport' | 'timeoutMs' | 'baseUrl' | 'healthPath' | 'protocol' | 'secrets'>,
): Promise<{ health: ProviderHealth; models: string[]; detail?: string }> {
  const url =
    options.protocol === 'ollama'
      ? `${options.baseUrl}/api/tags`
      : `${options.baseUrl}${options.healthPath.startsWith('/') ? options.healthPath : `/${options.healthPath}`}`;
  const key = forgeApiKey(options.secrets);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  try {
    const response = await options.transport.send({
      url,
      method: 'GET',
      headers,
      timeoutMs: Math.min(options.timeoutMs, 8_000),
    });
    const text = await readAllText(response.stream);
    if (response.status >= 400) {
      const failure = httpFailure('forge', response.status, text);
      return {
        health: failure.code === 'authentication_failure' ? 'authentication_failure' : 'unhealthy',
        models: [],
        detail: failure.message,
      };
    }
    return { health: 'healthy', models: parseModelNames(text) };
  } catch (err) {
    const failure = connectionFailure('forge', err instanceof Error ? err.message : String(err));
    return { health: 'unhealthy', models: [], detail: failure.message };
  }
}

function parseModelNames(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as {
      models?: Array<{ id?: string; name?: string }>;
      data?: Array<{ id?: string }>;
    };
    const fromOpenAI = (parsed.data ?? []).map((row) => row.id).filter((id): id is string => Boolean(id));
    const fromOllama = (parsed.models ?? [])
      .map((row) => row.id ?? row.name)
      .filter((id): id is string => Boolean(id));
    return [...fromOpenAI, ...fromOllama];
  } catch {
    return [];
  }
}

export { ProviderHttpError };
