import type { ProviderHealth, RegisteredModel } from '@atlas-vnext/contracts';
import { AnthropicAdapter } from './adapters/anthropic.ts';
import { GeminiAdapter } from './adapters/gemini.ts';
import { MockAdapter } from './adapters/mock.ts';
import { OllamaAdapter } from './adapters/ollama.ts';
import { createOpenAIAdapter, createVeniceAdapter } from './adapters/openai.ts';
import { PLACEHOLDER_PROVIDERS } from './adapters/placeholder.ts';
import { ExecutionBroker } from './broker.ts';
import { readExecutionConfig, type ExecutionConfig } from './config.ts';
import { EnvSecretStore, SECRET_KEYS, type SecretStore } from './secrets.ts';
import { FetchTransport, type HttpTransport } from './transport.ts';
import type { HealthObserver, ProviderAdapter } from './types.ts';

export type ExecutionMode = 'live' | 'mock';

export interface ExecutionPlaneOptions {
  mode: ExecutionMode;
  secrets?: SecretStore;
  env?: Record<string, string | undefined>;
  config?: ExecutionConfig;
  transport?: HttpTransport;
  health?: HealthObserver;
  streamDelayMs?: number;
  catalogue?: RegisteredModel[];
}

export interface ExecutionPlane {
  broker: ExecutionBroker;
  available: string[];
  unavailable: string[];
  health: Record<string, ProviderHealth>;
  config: ExecutionConfig;
  ollama: OllamaAdapter | null;
  mode: ExecutionMode;
  refreshOllamaHealth(): Promise<ProviderHealth>;
}

const MOCK_PROVIDERS = ['openai', 'anthropic', 'gemini', 'ollama'] as const;

/**
 * Composition helper for the execution plane. Hosts call this; Nexus does not.
 * Missing credentials mark a provider unavailable instead of crashing startup.
 */
export function createExecutionPlane(options: ExecutionPlaneOptions): ExecutionPlane {
  const env = options.env ?? {};
  const config = options.config ?? readExecutionConfig(env);
  const secrets = options.secrets ?? new EnvSecretStore(env);
  const transport = options.transport ?? new FetchTransport(config.timeoutMs);
  const health: Record<string, ProviderHealth> = {};
  const available: string[] = [];
  const unavailable: string[] = [];
  const broker = new ExecutionBroker(options.mode === 'mock' ? 1 : config.attemptsPerCandidate, {
    health: options.health,
  });

  if (options.mode === 'mock') {
    for (const id of MOCK_PROVIDERS) {
      broker.register(new MockAdapter(id, { delayMs: options.streamDelayMs ?? 0 }));
      available.push(id);
      health[id] = 'healthy';
      options.health?.onProviderHealth(id, 'healthy');
    }
    for (const id of ['venice', ...PLACEHOLDER_PROVIDERS]) {
      health[id] = 'unavailable';
      unavailable.push(id);
      options.health?.onProviderHealth(id, 'unavailable', id === 'venice' ? 'mock_mode' : 'placeholder');
    }
    return {
      broker,
      available,
      unavailable,
      health,
      config,
      ollama: null,
      mode: 'mock',
      async refreshOllamaHealth() {
        return 'healthy';
      },
    };
  }

  const modelMaps = mapsFromCatalogue(options.catalogue ?? []);

  const liveAdapters: Array<{ id: string; adapter: ProviderAdapter | null; ready: boolean }> = [
    {
      id: 'openai',
      ready: Boolean(secrets.get(SECRET_KEYS.openai)),
      adapter: secrets.get(SECRET_KEYS.openai)
        ? createOpenAIAdapter({
            secrets,
            transport,
            timeoutMs: config.timeoutMs,
            baseUrl: config.openaiBaseUrl,
            modelMap: modelMaps.openai,
          })
        : null,
    },
    {
      id: 'anthropic',
      ready: Boolean(secrets.get(SECRET_KEYS.anthropic)),
      adapter: secrets.get(SECRET_KEYS.anthropic)
        ? new AnthropicAdapter({
            secrets,
            transport,
            timeoutMs: config.timeoutMs,
            baseUrl: config.anthropicBaseUrl,
            modelMap: modelMaps.anthropic,
          })
        : null,
    },
    {
      id: 'gemini',
      ready: Boolean(secrets.get(SECRET_KEYS.gemini)),
      adapter: secrets.get(SECRET_KEYS.gemini)
        ? new GeminiAdapter({
            secrets,
            transport,
            timeoutMs: config.timeoutMs,
            baseUrl: config.geminiBaseUrl,
            modelMap: modelMaps.gemini,
          })
        : null,
    },
    {
      id: 'venice',
      ready: Boolean(secrets.get(SECRET_KEYS.venice)),
      adapter: secrets.get(SECRET_KEYS.venice)
        ? createVeniceAdapter({
            secrets,
            transport,
            timeoutMs: config.timeoutMs,
            baseUrl: config.veniceBaseUrl,
            modelMap: modelMaps.venice,
          })
        : null,
    },
  ];

  for (const entry of liveAdapters) {
    if (entry.adapter && entry.ready) {
      broker.register(entry.adapter);
      available.push(entry.id);
      health[entry.id] = 'configured';
      options.health?.onProviderHealth(entry.id, 'configured');
    } else {
      unavailable.push(entry.id);
      health[entry.id] = 'unavailable';
      options.health?.onProviderHealth(entry.id, 'unavailable', 'missing_credentials');
    }
  }

  const ollama = new OllamaAdapter({
    transport,
    timeoutMs: config.timeoutMs,
    baseUrl: config.ollamaBaseUrl,
    modelMap: modelMaps.ollama,
  });
  broker.register(ollama);
  available.push('ollama');
  health.ollama = 'configured';
  options.health?.onProviderHealth('ollama', 'configured');

  for (const id of PLACEHOLDER_PROVIDERS) {
    unavailable.push(id);
    health[id] = 'unavailable';
    options.health?.onProviderHealth(id, 'unavailable', 'placeholder');
  }

  return {
    broker,
    available,
    unavailable,
    health,
    config,
    ollama,
    mode: 'live',
    async refreshOllamaHealth() {
      try {
        const names = await ollama.discover();
        const next: ProviderHealth = names.length > 0 ? 'healthy' : 'unhealthy';
        health.ollama = next;
        options.health?.onProviderHealth('ollama', next, names.length === 0 ? 'no_local_models' : undefined);
        return next;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        health.ollama = 'unhealthy';
        options.health?.onProviderHealth('ollama', 'unhealthy', detail);
        return 'unhealthy';
      }
    },
  };
}

function mapsFromCatalogue(catalogue: RegisteredModel[]): Record<string, Record<string, string>> {
  const maps: Record<string, Record<string, string>> = {};
  for (const model of catalogue) {
    if (!model.upstreamId) continue;
    maps[model.provider] ??= {};
    maps[model.provider]![model.model] = model.upstreamId;
  }
  return maps;
}
