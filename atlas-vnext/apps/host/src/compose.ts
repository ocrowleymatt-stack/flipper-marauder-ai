import { dirname, join } from 'node:path';
import type { ProviderHealth } from '@atlas-vnext/contracts';
import { ConversationRuntime } from '@atlas-vnext/conversation';
import {
  createExecutionPlane,
  EnvSecretStore,
  type ExecutionMode,
  type HttpTransport,
  type RuntimeSnapshot,
  type SecretStore,
} from '@atlas-vnext/execution';
import { NexusRegistry, NexusRouter } from '@atlas-vnext/nexus';
import { openDurableStore, type DurableConversationStore } from '@atlas-vnext/persistence';
import { MODEL_CATALOGUE } from './catalogue.ts';

export interface Spine {
  runtime: ConversationRuntime;
  store: DurableConversationStore;
  router: NexusRouter;
  registry: NexusRegistry;
  broker: ReturnType<typeof createExecutionPlane>['broker'];
  health: Record<string, ProviderHealth>;
  mode: ExecutionMode;
  availableRuntimes: string[];
  runtimeSnapshot: RuntimeSnapshot | null;
}

export interface ComposeOptions {
  dataPath: string;
  streamDelayMs?: number;
  mode?: ExecutionMode;
  secrets?: SecretStore;
  env?: Record<string, string | undefined>;
  transport?: HttpTransport;
  runtimeStatePath?: string | null;
}

/**
 * Composition root. Apps/UI never import adapters; this host wires
 * Nexus (WHERE) to Execution (HOW) and the conversation domain (WHAT).
 */
export async function composeSpine(options: ComposeOptions): Promise<Spine> {
  const mode: ExecutionMode = options.mode ?? 'live';
  const store = openDurableStore(options.dataPath);
  const registry = new NexusRegistry();
  for (const model of MODEL_CATALOGUE) {
    registry.register(model);
  }

  const env = options.env ?? (mode === 'live' ? process.env : {});
  const secrets = options.secrets ?? new EnvSecretStore(env);
  const plane = createExecutionPlane({
    mode,
    secrets,
    env,
    transport: options.transport,
    streamDelayMs: options.streamDelayMs,
    catalogue: MODEL_CATALOGUE,
    runtimeStatePath:
      options.runtimeStatePath ?? (mode === 'live' ? join(dirname(options.dataPath), 'runtime.json') : null),
    health: {
      onProviderHealth(provider, health) {
        registry.setHealth(provider, health);
      },
    },
  });

  for (const [provider, health] of Object.entries(plane.health)) {
    registry.setHealth(provider, health);
  }

  if (mode === 'live') {
    await plane.refreshOllamaHealth();
    await plane.refreshForgeHealth();
    if (plane.scheduler) {
      await plane.scheduler.reconcile();
    }
  }

  const router = new NexusRouter(registry);
  const runtime = new ConversationRuntime({
    conversations: store.conversations,
    messages: store.messages,
    executions: store.executions,
    provenance: store.provenance,
    events: store.events,
    router,
    executor: plane.broker,
    availableRuntimes: plane.available,
  });
  await runtime.recoverInFlight();
  return {
    runtime,
    store,
    router,
    registry,
    broker: plane.broker,
    health: { ...plane.health },
    mode,
    availableRuntimes: plane.available,
    runtimeSnapshot: plane.runtimeSnapshot(),
  };
}
