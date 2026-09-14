import { dirname, join } from 'node:path';
import type { ProviderHealth } from '@atlas-vnext/contracts';
import { ConversationRuntime } from '@atlas-vnext/conversation';
import {
  createExecutionPlane,
  EnvSecretStore,
  type ExecutionMode,
  type HttpTransport,
  type RunPodClient,
  type RuntimeScheduler,
  type RuntimeSnapshot,
  type SecretStore,
} from '@atlas-vnext/execution';
import { NexusRegistry, NexusRouter } from '@atlas-vnext/nexus';
import {
  openDurableStore,
  openPlatformPersistence,
  readPersistenceConfig,
  PersistenceConfigError,
  type DurableConversationStore,
  type PersistenceConfig,
  type PlatformPersistence,
} from '@atlas-vnext/persistence';
import { FilesService } from '@atlas-vnext/files';
import { ContextService } from '@atlas-vnext/context';
import { ProjectService } from '@atlas-vnext/projects';
import { openFilesystemCas, type CasStore } from '@atlas-vnext/storage';
import { MODEL_CATALOGUE } from './catalogue.ts';

export interface Spine {
  runtime: ConversationRuntime;
  store: DurableConversationStore | null;
  persistence: PlatformPersistence | null;
  files: FilesService | null;
  projects: ProjectService | null;
  context: ContextService | null;
  cas: CasStore | null;
  router: NexusRouter;
  registry: NexusRegistry;
  broker: ReturnType<typeof createExecutionPlane>['broker'];
  health: Record<string, ProviderHealth>;
  mode: ExecutionMode;
  availableRuntimes: string[];
  scheduler: RuntimeScheduler | null;
  runtimeSnapshot: () => RuntimeSnapshot | null;
  close: () => Promise<void>;
}

export interface ComposeOptions {
  dataPath: string;
  streamDelayMs?: number;
  mode?: ExecutionMode;
  secrets?: SecretStore;
  env?: Record<string, string | undefined>;
  transport?: HttpTransport;
  runtimeStatePath?: string | null;
  runpodClient?: RunPodClient;
  persistence?: PersistenceConfig;
  casRoot?: string;
}

/**
 * Composition root. Apps/UI never import adapters; this host wires
 * Nexus (WHERE) to Execution (HOW) and the conversation domain (WHAT).
 */
export async function composeSpine(options: ComposeOptions): Promise<Spine> {
  const mode: ExecutionMode = options.mode ?? 'live';
  const env = options.env ?? (mode === 'live' ? process.env : {});
  const persistenceConfig = options.persistence ?? readPersistenceConfig(env);

  const registry = new NexusRegistry();
  for (const model of MODEL_CATALOGUE) {
    registry.register(model);
  }

  const secrets = options.secrets ?? new EnvSecretStore(env);
  const plane = createExecutionPlane({
    mode,
    secrets,
    env,
    transport: options.transport,
    streamDelayMs: options.streamDelayMs,
    catalogue: MODEL_CATALOGUE,
    runpodClient: options.runpodClient,
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
  let store: DurableConversationStore | null = null;
  let persistence: PlatformPersistence | null = null;
  let files: FilesService | null = null;
  let projects: ProjectService | null = null;
  let context: ContextService | null = null;
  let cas: CasStore | null = null;
  let runtime: ConversationRuntime;

  if (persistenceConfig.mode === 'postgres' || persistenceConfig.mode === 'memory') {
    persistence = await openPlatformPersistence(persistenceConfig);
    const tenantId = persistenceConfig.defaultTenantId;
    if (!tenantId) {
      await persistence.close();
      throw new PersistenceConfigError('PostgreSQL/memory host mode requires ATLAS_TENANT_ID.');
    }
    await persistence.ensureTenant({ id: tenantId, name: tenantId });
    const bound = persistence.forActor({ tenantId });
    runtime = new ConversationRuntime({
      conversations: bound.conversations,
      messages: bound.messages,
      executions: bound.executions,
      provenance: bound.provenance,
      events: bound.events,
      router,
      executor: plane.broker,
      availableRuntimes: plane.available,
      unitOfWork: persistence,
    });
    await persistence.recoverOnStart();
    cas = await openFilesystemCas(options.casRoot ?? join(dirname(options.dataPath), 'cas'));
    files = new FilesService(persistence, cas);
    projects = new ProjectService(persistence);
    context = new ContextService(persistence);
  } else {
    store = openDurableStore(options.dataPath);
    runtime = new ConversationRuntime({
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
  }

  return {
    runtime,
    store,
    persistence,
    files,
    projects,
    context,
    cas,
    router,
    registry,
    broker: plane.broker,
    health: { ...plane.health },
    mode,
    availableRuntimes: plane.available,
    scheduler: plane.scheduler,
    runtimeSnapshot: () => plane.runtimeSnapshot(),
    close: async () => {
      plane.scheduler?.stopIdleWatch();
      await persistence?.close();
    },
  };
}
