import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HealthCheckState, OperationalLimits, ProviderHealth, SourceInspectPort } from '@atlas-vnext/contracts';
import { ConversationRuntime, type ToolOrchestrator } from '@atlas-vnext/conversation';
import {
  AuthService,
  LoginService,
  MemoryCredentialStore,
  MemoryDirectoryStore,
  MemorySessionStore,
  userPrincipal,
  type CredentialStore,
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
import { WritingService, WritingError, looksLikeWritingFollowup, looksLikeWritingRequest, isWritingRunConversation } from '@atlas-vnext/dungeon-writing';
import { OsintService, DungeonError, looksLikeOsintFollowup } from '@atlas-vnext/dungeon-osint';
import { InvestigationService } from '@atlas-vnext/dungeon-investigation';
import { ResearchError, ResearchService } from '@atlas-vnext/dungeon-research';
import { WebsiteError, WebsiteStudioService, looksLikeWebsiteFollowup, looksLikeWebsiteRequest } from '@atlas-vnext/dungeon-website';
import { MusicService } from '@atlas-vnext/dungeon-music';
import { PrivacyService } from '@atlas-vnext/dungeon-privacy';
import { EnvFlagStore, type KillSwitchState } from '@atlas-vnext/flags';
import { AuthorityEngine, EffectivePolicyEngine } from '@atlas-vnext/permissions';
import { logPlatform } from '@atlas-vnext/observability';
import { OperationsDoctor, RepairExecutor } from '@atlas-vnext/operations';
import type { DurableJobEngine } from '@atlas-vnext/jobs';
import { MODEL_CATALOGUE } from './catalogue.ts';
import { ShutdownController, readOperationalLimits, type HealthProbe } from './ops.ts';
import { PlatformRateLimiter, ResourceGuard } from './limits.ts';
import { readTimeoutContract, type TimeoutContract } from './production-config.ts';
import { raceStartup, raceStartupCloseable, throwIfStartupAborted } from './startup-deadline.ts';
import { NodePublicLookup, looksLikeOsintQuestion } from './collectors.ts';
import { NodeFederatedSearch, searchEnginesFromEnv } from './search.ts';
import { FixtureInspect, NodeSourceInspect } from './inspect.ts';
import { productionToolAdapters } from './web-tools.ts';
import { NodeSiteGenerate } from './site-generate.ts';

export interface Spine {
  runtime: ConversationRuntime;
  store: DurableConversationStore | null;
  persistence: PlatformPersistence | null;
  files: FilesService | null;
  projects: ProjectService | null;
  context: ContextService | null;
  writing: WritingService | null;
  osint: OsintService | null;
  investigation: InvestigationService | null;
  research: ResearchService | null;
  websiteStudio: WebsiteStudioService | null;
  music: MusicService | null;
  privacy: PrivacyService | null;
  cas: CasStore | null;
  doctor: OperationsDoctor;
  repairs: RepairExecutor;
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
  login: LoginService;
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
  limits: OperationalLimits;
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
  openPersistence?: (config: PersistenceConfig) => Promise<PlatformPersistence>;
  casRoot?: string;
  signal?: AbortSignal;
  /** Override search/inspect independently of the execution plane. Default follows `mode`. */
  searchMode?: 'live' | 'mock';
  /**
   * OSINT always uses Wave 1 source inspect, never the research FixtureInspect
   * (which would false-confirm every username). Tests may inject a port.
   */
  osintInspect?: SourceInspectPort;
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
  const signal = options.signal;
  const budgetMs = timeouts.startupMs;
  const closers: Array<() => Promise<void> | void> = [];
  const remember = (close: () => Promise<void> | void): void => {
    closers.push(close);
  };

  throwIfStartupAborted(signal, budgetMs);

  try {
  const registry = new NexusRegistry();
  for (const model of MODEL_CATALOGUE) {
    registry.register(model);
  }
  registry.setDisabledProviders(killSwitches.disabledProviders);
  for (const provider of killSwitches.disabledProviders) {
    logPlatform('flags.provider_killed', { provider }, 'warn');
  }

  const secrets = options.secrets ?? new EnvSecretStore(env);
  const providerHealthLive: Record<string, ProviderHealth> = {};
  const recordProviderHealth = (provider: string, health: ProviderHealth): void => {
    providerHealthLive[provider] = health;
  };
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
        // Observe probe results; Nexus `isRoutable` still honours the kill list.
        registry.setHealth(provider, health);
        recordProviderHealth(provider, health);
      },
    },
  });

  for (const [provider, health] of Object.entries(plane.health)) {
    registry.setHealth(provider, health);
    recordProviderHealth(provider, health);
  }

  if (mode === 'live') {
    throwIfStartupAborted(signal, budgetMs);
    await raceStartup(signal, plane.refreshOllamaHealth(), budgetMs);
    await raceStartup(signal, plane.refreshForgeHealth(), budgetMs);
    if (plane.scheduler) {
      remember(() => plane.scheduler?.stopIdleWatch());
      await raceStartup(signal, plane.scheduler.reconcile(), budgetMs);
    }
  }

  const router = new NexusRouter(registry);
  let store: DurableConversationStore | null = null;
  let persistence: PlatformPersistence | null = null;
  let files: FilesService | null = null;
  let projects: ProjectService | null = null;
  let context: ContextService | null = null;
  let writing: WritingService | null = null;
  let osint: OsintService | null = null;
  let investigation: InvestigationService | null = null;
  let research: ResearchService | null = null;
  let websiteStudio: WebsiteStudioService | null = null;
  let music: MusicService | null = null;
  let privacy: PrivacyService | null = null;
  let cas: CasStore | null = null;
  let jobEngine: DurableJobEngine | null = null;
  let runtime: ConversationRuntime;
  const tenantId = persistenceConfig.defaultTenantId ?? (persistenceConfig.production ? '' : 'tenant_local');
  const principalId = env.ATLAS_PRINCIPAL_ID?.trim() || (tenantId ? `principal_${tenantId}` : 'principal_local');

  const authority = new AuthorityEngine();
  const policy = new EffectivePolicyEngine(authority);
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
    'network.public',
    'privacy.view',
    'privacy.configure',
    'privacy.audit',
    'deployment.promote',
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
  let credentials: CredentialStore = new MemoryCredentialStore();
  await directory.putTenantMembership({
    principalId,
    tenantId: tenantId || 'tenant_local',
    role: 'owner',
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
    cookieName: env.ATLAS_SESSION_COOKIE?.trim() || 'atlas_session',
  };
  let auth = new AuthService({
    sessions,
    directory,
    ...authOptions,
  });

  const jailRoot = env.ATLAS_TOOL_JAIL?.trim() || join(tmpdir(), 'atlas-tool-jail', tenantId);
  let tools: ToolEngine;

  const makeOrchestrator = (engine: ToolEngine): ToolOrchestrator => ({
    async listCallable(input) {
      return engine.listCallable({
        tenantId: input.tenantId,
        principalId: input.principalId,
        workspaceId: input.workspaceId,
      });
    },
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
        { signal: input.signal },
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
    throwIfStartupAborted(signal, budgetMs);
    const opening = (options.openPersistence ?? openPlatformPersistence)(persistenceConfig);
    persistence = await raceStartupCloseable(signal, opening, budgetMs);
    remember(() => persistence?.close());
    if (!persistenceConfig.defaultTenantId) {
      await persistence.close();
      throw new PersistenceConfigError('PostgreSQL/memory host mode requires ATLAS_TENANT_ID.');
    }
    await persistence.ensureTenant({ id: tenantId, name: tenantId });
    await persistence.ensurePrincipal({ id: principalId, displayName: principalId });
    const bound = persistence.forActor({ tenantId, principalId });
    jobEngine = bound.jobs;
    await bound.directory.putTenantMembership({
      principalId,
      tenantId,
      role: 'owner',
      capabilities: [],
      createdAt: new Date().toISOString(),
    });
    auth = new AuthService({
      sessions: bound.sessions,
      directory: bound.directory,
      ...authOptions,
    });
    credentials = bound.credentials;
    privacy = new PrivacyService({ persistence, authority, policy, ownerPrincipalId: principalId });
    const searchMode = options.searchMode ?? (mode === 'live' ? 'live' : 'mock');
    const searchPort = new NodeFederatedSearch(searchEnginesFromEnv(env, searchMode));
    const inspectPort = searchMode === 'live' ? new NodeSourceInspect() : new FixtureInspect();
    tools = new ToolEngine({
      registry: toolRegistry,
      invocations: bound.toolInvocations,
      approvals: bound.toolApprovals,
      authority,
      policy,
      resolvePolicy: (actor) => privacy!.runtimeOverlay(actor),
      jobs: bound.jobs,
      events: bound.events,
      limits,
      jailRoot,
      env,
      pluginEnabled: (id) => plugins.enabled(id),
      adapters: productionToolAdapters({ search: searchPort, inspect: inspectPort }),
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
      maxGeneratedBytes: limits.maxGeneratedBytes,
      maxToolRounds: limits.maxToolRounds,
      executionDeadlineMs: limits.maxExecutionMs,
    });
    await raceStartup(signal, persistence.recoverOnStart(), budgetMs);
    await raceStartup(signal, tools.reconcile(), budgetMs);
    throwIfStartupAborted(signal, budgetMs);
    cas = await raceStartup(
      signal,
      openFilesystemCas(
        options.casRoot ?? env.ATLAS_CAS_ROOT?.trim() ?? join(dirname(options.dataPath), 'cas'),
      ),
      budgetMs,
    );
    files = new FilesService(persistence, cas);
    projects = new ProjectService(persistence);
    context = new ContextService(persistence);
    writing = new WritingService({ persistence, projects, files, context, runtime, authority, policy });
    osint = new OsintService({
      persistence,
      projects,
      files,
      runtime,
      authority,
      policy,
      collector: new NodePublicLookup({
        inspect: options.osintInspect ?? new NodeSourceInspect(),
        search: searchPort,
        spiderfootUrl: env.SPIDERFOOT_URL || env.ATLAS_SPIDERFOOT_URL,
      }),
    });
    websiteStudio = new WebsiteStudioService({
      persistence,
      projects,
      files,
      authority,
      policy,
      generate: new NodeSiteGenerate(router, plane.broker, resources),
    });
    investigation = new InvestigationService({ persistence, projects, files, runtime, authority, policy, context });
    research = new ResearchService({
      persistence,
      projects,
      files,
      context,
      runtime,
      authority,
      policy,
      search: searchPort,
      inspect: inspectPort,
    });
    runtime.setWorkHandler(async (input) => {
      const actorPrincipal = input.principalId?.trim();
      if (!actorPrincipal) return { handled: false };
      const actor = { tenantId: input.tenantId?.trim() || tenantId, principalId: actorPrincipal };
      const runTitle = (await runtime.getSnapshot(input.conversationId))?.conversation.title;
      if (isWritingRunConversation(runTitle)) return { handled: false };
      if (looksLikeOsintQuestion(input.content) || looksLikeOsintFollowup(input.content)) {
        try {
          const osintResult = await osint!.maybeRunFromConversation(actor, {
            conversationId: input.conversationId,
            projectId: input.projectId,
            question: input.content,
            signal: input.signal,
          });
          if (osintResult.handled) return osintResult;
        } catch (err) {
          if (err instanceof DungeonError && (err.code === 'insufficient_evidence' || err.code === 'permission_denied')) {
            return { handled: true, failed: true, text: err.message };
          }
          if (err instanceof DungeonError && err.code === 'not_found') {
            return { handled: false };
          }
          throw err;
        }
      }
      if (looksLikeWritingRequest(input.content) || looksLikeWritingFollowup(input.content)) {
        try {
          const writingResult = await writing!.maybeRunFromConversation(actor, {
            conversationId: input.conversationId,
            projectId: input.projectId,
            question: input.content,
            signal: input.signal,
          });
          if (writingResult.handled) return writingResult;
        } catch (err) {
          if (err instanceof WritingError && (err.code === 'permission_denied' || err.code === 'invalid_output')) {
            return { handled: true, failed: true, text: err.message };
          }
          if (err instanceof WritingError && err.code === 'not_found') {
            return { handled: false };
          }
          throw err;
        }
      }
      if (looksLikeWebsiteRequest(input.content) || looksLikeWebsiteFollowup(input.content)) {
        try {
          const websiteResult = await websiteStudio!.maybeRunFromConversation(actor, {
            conversationId: input.conversationId,
            projectId: input.projectId,
            question: input.content,
            signal: input.signal,
          });
          if (websiteResult.handled) return websiteResult;
        } catch (err) {
          if (err instanceof WebsiteError && (err.code === 'permission_denied' || err.code === 'not_found')) {
            return { handled: true, failed: true, text: err.message };
          }
          throw err;
        }
      }
      try {
        return await research!.maybeRunFromConversation(actor, {
          conversationId: input.conversationId,
          projectId: input.projectId,
          question: input.content,
          signal: input.signal,
        });
      } catch (err) {
        if (err instanceof ResearchError && err.code === 'insufficient_evidence') {
          return { handled: true, failed: true, text: err.message };
        }
        if (err instanceof ResearchError && err.code === 'permission_denied') {
          return { handled: true, failed: true, text: err.message };
        }
        if (err instanceof ResearchError && err.code === 'not_found') {
          return { handled: false };
        }
        throw err;
      }
    });
    music = new MusicService({ persistence, projects, files, runtime, authority, policy });
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
      maxGeneratedBytes: limits.maxGeneratedBytes,
      maxToolRounds: limits.maxToolRounds,
      executionDeadlineMs: limits.maxExecutionMs,
    });
    await raceStartup(signal, runtime.recoverInFlight(), budgetMs);
    await raceStartup(signal, tools.reconcile(), budgetMs);
  }

  const login = new LoginService({
    auth,
    credentials,
    preferredTenantId: tenantId || null,
  });

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

  const doctor = new OperationsDoctor({
    persistence,
    cas,
    jobs: jobEngine,
    authority,
    providerHealth: () =>
      Object.fromEntries(
        Object.entries(providerHealthLive).map(([provider, health]) => [
          provider,
          providerHealthToCheckState(health),
        ]),
      ),
  });
  const repairs = new RepairExecutor({ doctor, authority, jobs: jobEngine });

  return {
    runtime,
    store,
    persistence,
    files,
    projects,
    context,
    writing,
    osint,
    investigation,
    research,
    websiteStudio,
    music,
    privacy,
    cas,
    doctor,
    repairs,
    router,
    registry,
    broker: plane.broker,
    get health() {
      return Object.freeze({ ...providerHealthLive });
    },
    mode,
    availableRuntimes: plane.available,
    scheduler: plane.scheduler,
    runtimeSnapshot: () => plane.runtimeSnapshot(),
    tools,
    auth,
    login,
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
    limits,
    timeouts,
    close: async () => {
      shutdown.begin();
      tools.stopAccepting();
      plane.scheduler?.stopIdleWatch();
      await persistence?.close();
    },
  };
  } catch (err) {
    for (const close of closers.reverse()) {
      await Promise.resolve(close()).catch(() => undefined);
    }
    throw err;
  }
}

export function providerHealthToCheckState(health: ProviderHealth): HealthCheckState {
  switch (health) {
    case 'healthy':
    case 'configured':
      return 'ok';
    case 'unhealthy':
    case 'authentication_failure':
      return 'error';
    case 'unavailable':
      return 'not_configured';
    default: {
      const _exhaustive: never = health;
      return _exhaustive;
    }
  }
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
    'deployment.promote',
    'privacy.view',
    'privacy.configure',
    'privacy.audit',
  ] as const) {
    authority.grantTo({ principalId, tenantId, capability: cap });
  }
}

export { userPrincipal };
