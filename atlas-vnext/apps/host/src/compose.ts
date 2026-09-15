import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProviderHealth } from '@atlas-vnext/contracts';
import { ConversationRuntime, type ToolOrchestrator } from '@atlas-vnext/conversation';
import {
  AuthService,
  MemoryDirectoryStore,
  MemorySessionStore,
  userPrincipal,
} from '@atlas-vnext/auth';
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
import { AuthorityEngine } from '@atlas-vnext/permissions';
import { FilesService } from '@atlas-vnext/files';
import { ContextService } from '@atlas-vnext/context';
import { ProjectService } from '@atlas-vnext/projects';
import { PluginRegistry, registerMockEchoPlugin } from '@atlas-vnext/plugins';
import { openFilesystemCas, type CasStore } from '@atlas-vnext/storage';
import {
  MemoryToolApprovalStore,
  MemoryToolInvocationStore,
  PLATFORM_TOOL_CATALOGUE,
  ToolEngine,
  ToolRegistry,
} from '@atlas-vnext/tools';
import { WritingService } from '@atlas-vnext/dungeon-writing';
import { EnvFlagStore, type KillSwitchState } from '@atlas-vnext/flags';
import { logPlatform } from '@atlas-vnext/observability';
import { MODEL_CATALOGUE } from './catalogue.ts';
import { ShutdownController, readOperationalLimits, type HealthProbe } from './ops.ts';
import { PlatformRateLimiter, ResourceGuard } from './limits.ts';
import { readTimeoutContract, type TimeoutContract } from './production-config.ts';

export interface Spine {
  runtime: ConversationRuntime;
  store: DurableConversationStore | null;
  persistence: PlatformPersistence | null;
  files: FilesService | null;
  projects: ProjectService | null;
  context: ContextService | null;
  writing: WritingService | null;
  cas: CasStore | null;
  router: NexusRouter;
  registry: NexusRegistry;
  broker: ReturnType<typeof createExecutionPlane>['broker'];
  health: Record<string, ProviderHealth>;
  mode: ExecutionMode;
  availableRuntimes: string[];
  scheduler: RuntimeScheduler | null;
  runtimeSnapshot: () => RuntimeSnapshot | null;
  tools: ToolEngine;
  auth: AuthService;
  authority: AuthorityEngine;
  plugins: PluginRegistry;
  shutdown: ShutdownController;
  healthProbe: HealthProbe;
  tenantId: string;
  principalId: string;
  flags: EnvFlagStore;
  killSwitches: KillSwitchState;
  rateLimiter: PlatformRateLimiter;
  resources: ResourceGuard;
  timeouts: TimeoutContract;
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
 * Tool execution does not own RunPod lifecycle.
 */
export async function composeSpine(options: ComposeOptions): Promise<Spine> {
  const mode: ExecutionMode = options.mode ?? 'live';
  const env = options.env ?? (mode === 'live' ? process.env : {});
  const persistenceConfig = options.persistence ?? readPersistenceConfig(env);
  const limits = readOperationalLimits(env);
  const shutdown = new ShutdownController();
  const flags = new EnvFlagStore(env);
  const killSwitches = flags.snapshot();
  const rateLimiter = new PlatformRateLimiter();
  const resources = new ResourceGuard(limits);
  const timeouts = readTimeoutContract(env);

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
  for (const provider of killSwitches.disabledProviders) {
    registry.setHealth(provider, 'unavailable');
    logPlatform('flags.provider_killed', { provider }, 'warn');
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
  let writing: WritingService | null = null;
  let cas: CasStore | null = null;
  let runtime: ConversationRuntime;
  const tenantId = persistenceConfig.defaultTenantId ?? (persistenceConfig.production ? '' : 'tenant_local');
  const principalId = env.ATLAS_PRINCIPAL_ID?.trim() || (tenantId ? `principal_${tenantId}` : 'principal_local');

  const authority = new AuthorityEngine();
  authority.grantMembership(principalId, tenantId);
  for (const cap of [
    'conversation.read',
    'conversation.write',
    'project.read',
    'file.read',
    'artifact.read',
    'artifact.write',
    'project.write',
    'tool.invoke.readonly',
    'tool.invoke',
  ] as const) {
    authority.grantTo({ principalId, tenantId, capability: cap });
  }

  const toolRegistry = new ToolRegistry();
  const plugins = new PluginRegistry();
  for (const definition of PLATFORM_TOOL_CATALOGUE) {
    if (definition.pluginId) continue;
    toolRegistry.register(definition);
  }
  registerMockEchoPlugin(plugins, toolRegistry);

  const toolInvocations = new MemoryToolInvocationStore();
  const toolApprovals = new MemoryToolApprovalStore();
  const directory = new MemoryDirectoryStore();
  const sessions = new MemorySessionStore();
  await directory.putTenantMembership({
    principalId,
    tenantId: tenantId || 'tenant_local',
    role: 'member',
    capabilities: [],
    createdAt: new Date().toISOString(),
  });
  const authOptions = {
    production: persistenceConfig.production,
    secret: env.ATLAS_SESSION_SECRET,
    allowedOrigins: (env.ATLAS_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    sessionTtlMs: limits.sessionTtlMs,
  };
  let auth = new AuthService({
    sessions,
    directory,
    ...authOptions,
  });

  const jailRoot = env.ATLAS_TOOL_JAIL?.trim() || join(tmpdir(), 'atlas-tool-jail', tenantId);
  let tools: ToolEngine;

  const makeOrchestrator = (engine: ToolEngine): ToolOrchestrator => ({
    async handleCall(input) {
      const result = await engine.invoke(
        { tenantId: input.tenantId, principalId: input.principalId, workspaceId: input.workspaceId },
        {
          toolId: input.call.toolId,
          arguments: input.call.arguments,
          callId: input.call.id,
          conversationId: input.conversationId,
          executionId: input.executionId,
          provider: input.provider,
          model: input.model,
        },
      );
      return {
        invocationId: result.invocation.id,
        toolId: result.invocation.toolId,
        status: result.invocation.status,
        reason: result.invocation.failureReason?.message,
        resultRef: result.invocation.resultRef ?? null,
        output: result.output,
      };
    },
  });

  if (persistenceConfig.mode === 'postgres' || persistenceConfig.mode === 'memory') {
    persistence = await openPlatformPersistence(persistenceConfig);
    if (!persistenceConfig.defaultTenantId) {
      await persistence.close();
      throw new PersistenceConfigError('PostgreSQL/memory host mode requires ATLAS_TENANT_ID.');
    }
    await persistence.ensureTenant({ id: tenantId, name: tenantId });
    await persistence.ensurePrincipal({ id: principalId, displayName: principalId });
    const bound = persistence.forActor({ tenantId, principalId });
    await bound.directory.putTenantMembership({
      principalId,
      tenantId,
      role: 'member',
      capabilities: [],
      createdAt: new Date().toISOString(),
    });
    auth = new AuthService({
      sessions: bound.sessions,
      directory: bound.directory,
      ...authOptions,
    });
    tools = new ToolEngine({
      registry: toolRegistry,
      invocations: bound.toolInvocations,
      approvals: bound.toolApprovals,
      authority,
      jobs: bound.jobs,
      events: bound.events,
      limits,
      jailRoot,
      env,
      pluginEnabled: (id) => plugins.enabled(id),
    });
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
      toolOrchestrator: killSwitches.tools ? makeOrchestrator(tools) : undefined,
      principalId,
      maxConcurrentExecutions: limits.maxConcurrentRuns,
    });
    await persistence.recoverOnStart();
    await tools.reconcile();
    cas = await openFilesystemCas(
      options.casRoot ?? env.ATLAS_CAS_ROOT?.trim() ?? join(dirname(options.dataPath), 'cas'),
    );
    files = new FilesService(persistence, cas);
    projects = new ProjectService(persistence);
    context = new ContextService(persistence);
    writing = new WritingService({ persistence, projects, files, context, runtime, authority });
  } else {
    store = openDurableStore(options.dataPath);
    tools = new ToolEngine({
      registry: toolRegistry,
      invocations: toolInvocations,
      approvals: toolApprovals,
      authority,
      limits,
      jailRoot,
      env,
      pluginEnabled: (id) => plugins.enabled(id),
    });
    runtime = new ConversationRuntime({
      conversations: store.conversations,
      messages: store.messages,
      executions: store.executions,
      provenance: store.provenance,
      events: store.events,
      router,
      executor: plane.broker,
      availableRuntimes: plane.available,
      toolOrchestrator: killSwitches.tools ? makeOrchestrator(tools) : undefined,
      principalId,
      maxConcurrentExecutions: limits.maxConcurrentRuns,
    });
    await runtime.recoverInFlight();
    await tools.reconcile();
  }

  const healthProbe: HealthProbe = {
    live: () => true,
    async dependencies() {
      let postgres: 'ok' | 'error' | 'not_configured' = 'not_configured';
      if (persistence?.mode === 'postgres') {
        try {
          await persistence.run(async () => undefined);
          postgres = 'ok';
        } catch {
          postgres = 'error';
        }
      } else if (persistence?.mode === 'memory') {
        postgres = 'not_configured';
      }
      let casHealth: 'ok' | 'error' | 'not_configured' = cas ? 'ok' : 'not_configured';
      if (cas) {
        try {
          await cas.physicalBytes();
        } catch {
          casHealth = 'error';
        }
      }
      return {
        postgres,
        cas: casHealth,
        jobs: persistence ? 'ok' : 'not_configured',
        runtimeScheduler: plane.scheduler ? 'ok' : 'not_configured',
      };
    },
  };

  return {
    runtime,
    store,
    persistence,
    files,
    projects,
    context,
    writing,
    cas,
    router,
    registry,
    broker: plane.broker,
    health: { ...plane.health },
    mode,
    availableRuntimes: plane.available,
    scheduler: plane.scheduler,
    runtimeSnapshot: () => plane.runtimeSnapshot(),
    tools,
    auth,
    authority,
    plugins,
    shutdown,
    healthProbe,
    tenantId,
    principalId,
    flags,
    killSwitches,
    rateLimiter,
    resources,
    timeouts,
    close: async () => {
      shutdown.begin();
      tools.stopAccepting();
      plane.scheduler?.stopIdleWatch();
      await persistence?.close();
    },
  };
}

export function grantSideEffects(authority: AuthorityEngine, principalId: string, tenantId: string): void {
  for (const cap of [
    'filesystem.read',
    'filesystem.write',
    'file.write',
    'tool.invoke.external_write',
    'browser.read',
    'browser.submit',
    'network.public',
    'shell.execute',
    'code.execute',
    'publish.external',
    'admin.configure',
    'project.write',
    'artifact.write',
  ] as const) {
    authority.grantTo({ principalId, tenantId, capability: cap });
  }
}

export { userPrincipal };
