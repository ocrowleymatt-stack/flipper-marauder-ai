import type { ProviderHealth, RegisteredModel } from '@atlas-vnext/contracts';
import { AnthropicAdapter } from './adapters/anthropic.ts';
import { GeminiAdapter } from './adapters/gemini.ts';
import { MockAdapter } from './adapters/mock.ts';
import { OllamaAdapter } from './adapters/ollama.ts';
import { createForgeAdapter, probeForgeHealth } from './adapters/forge.ts';
import { createOpenAIAdapter, createVeniceAdapter, createXaiAdapter } from './adapters/openai.ts';
import { RunPodAdapter } from './adapters/runpod.ts';
import { ExecutionBroker } from './broker.ts';
import { readExecutionConfig, type ExecutionConfig } from './config.ts';
import { EnvSecretStore, forgeApiKey, geminiApiKey, SECRET_KEYS, xaiApiKey, type SecretStore } from './secrets.ts';
import { HttpRunPodClient } from './runtime/client.ts';
import { RuntimeObserver } from './runtime/observer.ts';
import { RuntimeScheduler } from './runtime/scheduler.ts';
import { FileRuntimeStateStore, MemoryRuntimeStateStore } from './runtime/store.ts';
import type { RunPodClient, RuntimeSnapshot } from './runtime/types.ts';
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
  runpodClient?: RunPodClient;
  runtimeStatePath?: string | null;
}

export interface ExecutionPlane {
  broker: ExecutionBroker;
  available: string[];
  unavailable: string[];
  health: Record<string, ProviderHealth>;
  config: ExecutionConfig;
  ollama: OllamaAdapter | null;
  scheduler: RuntimeScheduler | null;
  runtimeObserver: RuntimeObserver | null;
  mode: ExecutionMode;
  refreshOllamaHealth(): Promise<ProviderHealth>;
  refreshForgeHealth(): Promise<ProviderHealth>;
  runtimeSnapshot(): RuntimeSnapshot | null;
}

const MOCK_PROVIDERS = ['openai', 'anthropic', 'gemini', 'ollama', 'xai'] as const;

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
  const runtimeObserver = new RuntimeObserver();

  const mark = (id: string, status: ProviderHealth, detail?: string, adapter?: ProviderAdapter | null) => {
    health[id] = status;
    options.health?.onProviderHealth(id, status, detail);
    if (adapter && (status === 'configured' || status === 'healthy')) {
      broker.register(adapter);
      available.push(id);
    } else {
      unavailable.push(id);
    }
  };

  if (options.mode === 'mock') {
    for (const id of MOCK_PROVIDERS) {
      broker.register(new MockAdapter(id, { delayMs: options.streamDelayMs ?? 0 }));
      available.push(id);
      health[id] = 'healthy';
      options.health?.onProviderHealth(id, 'healthy');
    }
    for (const id of ['venice', 'forge', 'runpod']) {
      health[id] = 'unavailable';
      unavailable.push(id);
      options.health?.onProviderHealth(id, 'unavailable', 'mock_mode');
    }
    return {
      broker,
      available,
      unavailable,
      health,
      config,
      ollama: null,
      scheduler: null,
      runtimeObserver: null,
      mode: 'mock',
      async refreshOllamaHealth() {
        return 'healthy';
      },
      async refreshForgeHealth() {
        return 'unavailable';
      },
      runtimeSnapshot() {
        return null;
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
      ready: Boolean(geminiApiKey(secrets)),
      adapter: geminiApiKey(secrets)
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
    {
      id: 'xai',
      ready: Boolean(xaiApiKey(secrets)),
      adapter: xaiApiKey(secrets)
        ? createXaiAdapter({
            secrets,
            transport,
            timeoutMs: config.timeoutMs,
            baseUrl: config.xaiBaseUrl,
            modelMap: modelMaps.xai,
          })
        : null,
    },
  ];

  for (const entry of liveAdapters) {
    if (entry.adapter && entry.ready) {
      mark(entry.id, 'configured', undefined, entry.adapter);
    } else {
      mark(entry.id, 'unavailable', 'missing_credentials');
    }
  }

  const ollama = new OllamaAdapter({
    transport,
    timeoutMs: config.timeoutMs,
    baseUrl: config.ollamaBaseUrl,
    modelMap: modelMaps.ollama,
  });
  mark('ollama', 'configured', undefined, ollama);

  let forgeAdapter: ProviderAdapter | null = null;
  if (config.forgeBaseUrl) {
    forgeAdapter = createForgeAdapter({
      secrets,
      transport,
      timeoutMs: config.timeoutMs,
      baseUrl: config.forgeBaseUrl,
      protocol: config.forgeProtocol,
      chatPath: config.forgeChatPath,
      healthPath: config.forgeHealthPath,
      modelMap: modelMaps.forge,
    });
    mark('forge', 'configured', forgeApiKey(secrets) ? undefined : 'optional_auth', forgeAdapter);
  } else {
    mark('forge', 'unavailable', 'missing_endpoint');
  }

  let scheduler: RuntimeScheduler | null = null;
  const runpodConfigured = Boolean(secrets.get(SECRET_KEYS.runpod) && config.runpodPodId);
  if (runpodConfigured) {
    const store = options.runtimeStatePath
      ? new FileRuntimeStateStore(options.runtimeStatePath)
      : new MemoryRuntimeStateStore();
    scheduler = new RuntimeScheduler({
      client:
        options.runpodClient ??
        new HttpRunPodClient({
          transport,
          secrets,
          baseUrl: config.runpodApiBaseUrl,
          timeoutMs: config.timeoutMs,
        }),
      store,
      observer: runtimeObserver,
      podId: config.runpodPodId,
      maxActivePods: config.runpodMaxActivePods,
      idleShutdownSeconds: config.runpodIdleShutdownSeconds,
      warmTimeoutMs: config.runpodWarmTimeoutMs,
      inferencePort: config.runpodInferencePort,
      leaseTtlSeconds: config.runpodLeaseTtlSeconds,
    });
    const runpod = new RunPodAdapter({
      scheduler,
      secrets,
      transport,
      timeoutMs: config.timeoutMs,
      inferenceBaseUrl: config.runpodInferenceBaseUrl,
      modelMap: modelMaps.runpod,
    });
    mark('runpod', 'configured', undefined, runpod);
  } else {
    mark('runpod', 'unavailable', secrets.get(SECRET_KEYS.runpod) ? 'missing_pod_id' : 'missing_credentials');
  }

  return {
    broker,
    available,
    unavailable,
    health,
    config,
    ollama,
    scheduler,
    runtimeObserver,
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
    async refreshForgeHealth() {
      if (!config.forgeBaseUrl) {
        health.forge = 'unavailable';
        options.health?.onProviderHealth('forge', 'unavailable', 'missing_endpoint');
        return 'unavailable';
      }
      const probed = await probeForgeHealth({
        transport,
        timeoutMs: config.timeoutMs,
        baseUrl: config.forgeBaseUrl,
        healthPath: config.forgeHealthPath,
        protocol: config.forgeProtocol,
        secrets,
      });
      health.forge = probed.health;
      options.health?.onProviderHealth('forge', probed.health, probed.detail);
      return probed.health;
    },
    runtimeSnapshot() {
      return scheduler?.snapshot() ?? null;
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
