import { describe, expect, it, vi } from 'vitest';
import type { RouteDecision, StreamChunk } from '@atlas-vnext/contracts';
import {
  AUTHORITY_SCOPES_UNCHANGED_BY_BEHAVIOUR,
  DEFAULT_BEHAVIOUR_MODE,
  DEFAULT_RETENTION_BOUNDS,
  MAX_ATTEMPTS_PER_CANDIDATE,
  capabilityAliasSchema,
} from '@atlas-vnext/contracts';
import { ConversationRuntime, memoryStores } from '@atlas-vnext/conversation';
import { MemoryEventBus } from '@atlas-vnext/events';
import {
  CircuitBreaker,
  ExecutionBroker,
  MAX_RUNTIME_EVENTS,
  ProviderHttpError,
  RuntimeObserver,
  classifyProviderFailure,
  httpFailure,
  type ProviderAdapter,
} from '@atlas-vnext/execution';
import { ALIAS_POLICIES, RouteResolutionError } from '@atlas-vnext/nexus';
import { MemoryRouteLog, routeTraceFromDecision } from '@atlas-vnext/observability';
import {
  DefaultDenyGate,
  TenantBehaviourStore,
  TenantIsolationError,
  authorityBoundary,
  composeBehaviourPrompt,
} from '@atlas-vnext/permissions';
import { BoundedWorkspaceIndex, RetentionGuard } from '@atlas-vnext/storage';
import { routingHarness } from './harness.ts';

function decision(chain: string[], extra: Partial<RouteDecision> = {}): RouteDecision {
  const [primary] = chain;
  const [provider, model] = (primary ?? 'openai/gpt').split('/');
  return {
    target: 'nexus/fast',
    resolvedRouteId: primary ?? 'openai/gpt',
    provider: provider ?? 'openai',
    model: model ?? 'gpt',
    candidateChain: chain,
    localOnly: false,
    locality: 'public_cloud',
    runtimeClass: 'always_available',
    decisionReason: 'test',
    traceId: 'trc_compat',
    evaluatedAt: new Date().toISOString(),
    rejectedCandidates: [],
    ...extra,
  };
}

async function collect(
  broker: ExecutionBroker,
  route: RouteDecision,
  observer?: Parameters<ExecutionBroker['execute']>[2],
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of broker.execute(route, { prompt: 'hi' }, observer)) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('mountain-compat 1: failover-before-output / never-after-output (historical Mountain failover-provider.ts @ 5cc7a96; inspected vNext broker)', () => {
  it('retries/fails over before visible assistant output', async () => {
    const broker = new ExecutionBroker(1);
    broker.register({
      providerId: 'openai',
      async *stream() {
        throw new Error('timeout before tokens');
      },
    });
    broker.register({
      providerId: 'ollama',
      async *stream() {
        yield { type: 'text', text: 'recovered' };
      },
    });
    expect(await collect(broker, decision(['openai/gpt-4o', 'ollama/llama3.2']))).toEqual([
      { type: 'text', text: 'recovered' },
    ]);
  });

  it('does not silently switch providers after visible text; persists partial + failure', async () => {
    const broker = new ExecutionBroker(1);
    broker.register({
      providerId: 'openai',
      async *stream() {
        yield { type: 'text', text: 'partial' };
        throw new Error('cut');
      },
    });
    broker.register({
      providerId: 'ollama',
      async *stream() {
        yield { type: 'text', text: 'contradiction' };
      },
    });
    const chunks: StreamChunk[] = [];
    await expect(async () => {
      for await (const chunk of broker.execute(decision(['openai/gpt-4o', 'ollama/llama3.2']), { prompt: 'hi' })) {
        chunks.push(chunk);
      }
    }).rejects.toThrow('cut');
    expect(chunks).toEqual([{ type: 'text', text: 'partial' }]);

    const stores = memoryStores();
    const runtime = new ConversationRuntime({
      ...stores,
      events: new MemoryEventBus(),
      router: { resolve: () => decision(['openai/gpt-4o', 'ollama/llama3.2']) },
      executor: {
        async *execute(_routed, _ctx, observer) {
          observer?.onAttempt({
            index: 1,
            provider: 'openai',
            model: 'gpt-4o',
            outcome: 'started',
            error: null,
            emittedVisibleOutput: false,
          });
          yield { type: 'text', text: 'partial answer' };
          observer?.onAttempt({
            index: 1,
            provider: 'openai',
            model: 'gpt-4o',
            outcome: 'failed',
            error: { code: 'cut', message: 'cut after tokens', retryable: false, at: '2026-09-14T00:00:00.000Z' },
            emittedVisibleOutput: true,
          });
          throw new Error('cut after tokens');
        },
      },
    });
    const conversation = await runtime.createConversation();
    const events = [];
    for await (const event of runtime.sendMessage(conversation.id, { content: 'write' })) events.push(event);
    const snapshot = await runtime.getSnapshot(conversation.id);
    expect(snapshot?.executions[0]?.status).toBe('failed');
    expect(snapshot?.executions[0]?.failureReason?.code).toBe('partial_stream_failure');
    expect(snapshot?.messages.at(-1)?.content).toBe('partial answer');
    expect(events.some((event) => event.type === 'error')).toBe(true);
  });

  it('treats reasoning as visible output (no second provider)', async () => {
    const broker = new ExecutionBroker(1);
    broker.register({
      providerId: 'openai',
      async *stream() {
        yield { type: 'reasoning', text: 'thinking' };
        throw new Error('cut');
      },
    });
    broker.register({
      providerId: 'ollama',
      async *stream() {
        yield { type: 'text', text: 'contradiction' };
      },
    });
    const chunks: StreamChunk[] = [];
    await expect(async () => {
      for await (const chunk of broker.execute(decision(['openai/gpt-4o', 'ollama/llama3.2']), { prompt: 'hi' })) {
        chunks.push(chunk);
      }
    }).rejects.toThrow('cut');
    expect(chunks).toEqual([{ type: 'reasoning', text: 'thinking' }]);
  });
});

describe('mountain-compat 2: transactional tool-call buffering (historical Mountain failover-provider.ts @ 5cc7a96; inspected assembler + broker)', () => {
  it('does not emit tool calls from a failed attempt (no duplicate side effects)', async () => {
    const broker = new ExecutionBroker(1);
    let sideEffects = 0;
    broker.register({
      providerId: 'openai',
      async *stream() {
        yield { type: 'tool_call', call: { id: 'c1', toolId: 'search', arguments: { q: 'atlas' } } };
        throw new Error('timeout before complete');
      },
    });
    broker.register({
      providerId: 'ollama',
      async *stream() {
        yield { type: 'text', text: 'done locally' };
      },
    });
    const chunks = await collect(broker, decision(['openai/gpt-4o', 'ollama/llama3.2']));
    for (const chunk of chunks) {
      if (chunk.type === 'tool_call') sideEffects += 1;
    }
    expect(sideEffects).toBe(0);
    expect(chunks.some((chunk) => chunk.type === 'tool_call')).toBe(false);
    expect(chunks.filter((chunk) => chunk.type === 'text')).toEqual([{ type: 'text', text: 'done locally' }]);
  });

  it('emits buffered tool calls only after the attempt succeeds', async () => {
    const broker = new ExecutionBroker(1);
    broker.register({
      providerId: 'openai',
      async *stream() {
        yield { type: 'tool_call', call: { id: 'c1', toolId: 'search', arguments: { q: 'atlas' } } };
        yield { type: 'text', text: 'thinking' };
      },
    });
    const chunks = await collect(broker, decision(['openai/gpt-4o']));
    expect(chunks).toEqual([
      { type: 'text', text: 'thinking' },
      { type: 'tool_call', call: { id: 'c1', toolId: 'search', arguments: { q: 'atlas' } } },
    ]);
  });

  it('does not execute incomplete argument fragments as calls', async () => {
    const { OpenAIToolCallAssembler } = await import('@atlas-vnext/execution');
    const assembler = new OpenAIToolCallAssembler();
    assembler.ingest([{ index: 0, id: 'call_bad', function: { name: 'lookup', arguments: '{"q":' } }]);
    const chunks = assembler.finish('openai');
    expect(chunks.some((chunk) => chunk.type === 'tool_call')).toBe(false);
    expect(chunks[0]).toMatchObject({ type: 'warning', provider: 'openai' });
  });
});

describe('mountain-compat 3: transient retry classification (historical Mountain provider-error.ts @ 5cc7a96; 429/5xx is vNext/Caspa-adjacent mapping)', () => {
  it('classifies timeout/reset/429/5xx as transient and 400/401/unsupported/permission/context overflow as terminal', () => {
    expect(classifyProviderFailure(new Error('timeout before tokens')).retryable).toBe(true);
    expect(classifyProviderFailure(new Error('ECONNRESET')).retryable).toBe(true);
    expect(classifyProviderFailure(new ProviderHttpError(httpFailure('openai', 429, 'rate'))).retryable).toBe(true);
    expect(classifyProviderFailure(new ProviderHttpError(httpFailure('openai', 503, 'down'))).retryable).toBe(true);
    expect(classifyProviderFailure(new ProviderHttpError(httpFailure('openai', 400, 'bad request'))).retryable).toBe(
      false,
    );
    expect(classifyProviderFailure(new ProviderHttpError(httpFailure('openai', 401, 'nope'))).retryable).toBe(false);
    expect(classifyProviderFailure(new Error('unsupported model')).retryable).toBe(false);
    expect(classifyProviderFailure(new Error('permission denied')).retryable).toBe(false);
    expect(classifyProviderFailure(new Error('exceeds context window')).retryable).toBe(false);
    expect(httpFailure('openai', 400, 'maximum context length exceeded').code).toBe('context_overflow');
  });

  it('retries 429 on the same candidate a bounded number of times, then failovers', async () => {
    const broker = new ExecutionBroker(2);
    let openaiCalls = 0;
    broker.register({
      providerId: 'openai',
      async *stream() {
        openaiCalls += 1;
        throw new ProviderHttpError(httpFailure('openai', 429, 'slow down'));
      },
    });
    broker.register({
      providerId: 'ollama',
      async *stream() {
        yield { type: 'text', text: 'local' };
      },
    });
    const chunks = await collect(broker, decision(['openai/gpt-4o', 'ollama/llama3.2']));
    expect(openaiCalls).toBe(2);
    expect(chunks).toEqual([{ type: 'text', text: 'local' }]);
  });

  it('does not retry 400/401 indefinitely; one attempt then next candidate', async () => {
    const broker = new ExecutionBroker(5);
    let openaiCalls = 0;
    broker.register({
      providerId: 'openai',
      async *stream() {
        openaiCalls += 1;
        throw new ProviderHttpError(httpFailure('openai', 400, 'bad request'));
      },
    });
    broker.register({
      providerId: 'ollama',
      async *stream() {
        yield { type: 'text', text: 'local' };
      },
    });
    expect(await collect(broker, decision(['openai/gpt-4o', 'ollama/llama3.2']))).toEqual([
      { type: 'text', text: 'local' },
    ]);
    expect(openaiCalls).toBe(1);
  });

  it('caps attempts per candidate so retries cannot run unbounded', () => {
    const broker = new ExecutionBroker(99);
    expect(MAX_ATTEMPTS_PER_CANDIDATE).toBe(5);
    expect((broker as unknown as { attemptsPerCandidate: number }).attemptsPerCandidate).toBe(5);
  });

  it('opens a provider cooldown window via the execution circuit breaker', () => {
    vi.useFakeTimers();
    try {
      const breaker = new CircuitBreaker(2, 1_000);
      breaker.failure();
      breaker.failure();
      expect(breaker.isOpen()).toBe(true);
      vi.advanceTimersByTime(1_001);
      expect(breaker.isOpen()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('mountain-compat 4: local-only Private routing (historical Mountain nexus/private @ 5cc7a96; inspected Nexus privacy)', () => {
  it('never selects public-cloud under local_only privacy', () => {
    const { router } = routingHarness();
    const routed = router.resolve('nexus/fast', { privacy: 'local_only' });
    expect(routed.localOnly).toBe(true);
    expect(routed.locality).toBe('local');
    expect(routed.resolvedRouteId).toBe('ollama/llama3.2');
    expect(routed.candidateChain.every((id) => id.startsWith('ollama/'))).toBe(true);
    expect(routed.rejectedCandidates?.some((row) => row.reason === 'privacy_local_only' && row.provider === 'openai')).toBe(
      true,
    );
    expect(() => router.resolve('openai/gpt-4o', { privacy: 'local_only' })).toThrow(/local-only privacy/);
  });

  it('fails closed when local is missing instead of leaking to cloud', async () => {
    const { registry, router } = routingHarness();
    registry.setHealth('ollama', 'unavailable');
    expect(() => router.resolve('nexus/fast', { privacy: 'local_only' })).toThrow(RouteResolutionError);
    expect(() => router.resolve('nexus/fast', { privacy: 'local_only' })).toThrow(/No healthy candidates/);

    const runtime = new ConversationRuntime({
      ...memoryStores(),
      events: new MemoryEventBus(),
      router,
      privacy: 'local_only',
      executor: {
        async *execute() {
          yield { type: 'text', text: 'leaked to cloud' };
        },
      },
    });
    const conversation = await runtime.createConversation();
    const events = [];
    for await (const event of runtime.sendMessage(conversation.id, { content: 'secret', privacy: 'local_only' })) {
      events.push(event);
    }
    const snapshot = await runtime.getSnapshot(conversation.id);
    expect(snapshot?.executions[0]?.status).toBe('failed');
    expect(snapshot?.executions[0]?.failureReason?.code).toBe('routing_failed');
    expect(snapshot?.executions[0]?.selectedProvider).not.toBe('openai');
    expect(snapshot?.messages.some((message) => message.content === 'leaked to cloud')).toBe(false);
  });
});

describe('mountain-compat 5: Behaviour ≠ Authority (historical Mountain behaviour/ vs permissions/ @ 5cc7a96; #172/#221 unread)', () => {
  it('Open posture grants no extra filesystem, shell, network, publishing, compute, or admin capability', () => {
    const gate = new DefaultDenyGate();
    const open = authorityBoundary('open', gate);
    const standard = authorityBoundary('standard', gate);
    expect(open.grantedScopes).toEqual([]);
    expect(standard.grantedScopes).toEqual([]);
    expect(open.deniedScopes).toEqual([...AUTHORITY_SCOPES_UNCHANGED_BY_BEHAVIOUR]);
    expect(open.deniedScopes).toEqual(standard.deniedScopes);
    for (const scope of [
      'filesystem.write',
      'shell.execute',
      'network.public',
      'network.private',
      'deployment.promote',
      'compute.allocate',
      'admin.configure',
    ] as const) {
      expect(gate.evaluate(scope)).toBe('DENY');
      expect(open.deniedScopes).toContain(scope);
    }
  });

  it('invalid Behaviour modes fail closed at the authority boundary', () => {
    const gate = new DefaultDenyGate();
    expect(() => authorityBoundary('unrestricted' as never, gate)).toThrow();
  });

  it('explicit grants stay independent of Behaviour mode', () => {
    const gate = new DefaultDenyGate();
    gate.grant('filesystem.read', 'proj_1');
    expect(authorityBoundary('open', gate, 'proj_1').grantedScopes).toEqual(['filesystem.read']);
    expect(authorityBoundary('standard', gate, 'proj_1').grantedScopes).toEqual(['filesystem.read']);
    expect(authorityBoundary('open', gate, 'proj_2').grantedScopes).toEqual([]);
  });
});

describe('mountain-compat 6: tenant-isolated Behaviour persistence (historical tenancy/database-router + posture-store @ 5cc7a96; stub)', () => {
  it('resolves per tenant, isolates A from B, and fail-closes to Standard', () => {
    const store = new TenantBehaviourStore();
    expect(store.resolve('tenant-a')).toBe(DEFAULT_BEHAVIOUR_MODE);
    expect(store.resolve('tenant-a')).toBe('standard');
    store.write('tenant-a', 'tenant-a', 'open');
    expect(store.resolve('tenant-a')).toBe('open');
    expect(store.resolve('tenant-b')).toBe('standard');
    expect(() => store.read('tenant-a', 'tenant-b')).toThrow(TenantIsolationError);
    expect(() => store.write('tenant-a', 'tenant-b', 'open')).toThrow(TenantIsolationError);
    expect(() => store.resolve('')).toThrow(/Fail-closed/);
    expect(store.read('tenant-b', 'tenant-b')).toBeNull();
  });

  it('invalid Behaviour modes fail closed and do not persist', () => {
    const store = new TenantBehaviourStore();
    expect(() => store.write('tenant-a', 'tenant-a', 'unrestricted' as never)).toThrow();
    expect(store.resolve('tenant-a')).toBe('standard');
    expect(() =>
      composeBehaviourPrompt({
        behaviour: 'jailbreak' as never,
        capabilityPolicy: 'DENY shell.execute',
        runtimePolicy: 'local-only',
      }),
    ).toThrow();
  });
});

describe('mountain-compat 7: Behaviour prompt composed with capability/runtime policy (historical posture + mode-policy @ 5cc7a96; vNext fail-closed compose)', () => {
  it('composes posture with policy and refuses to replace capability or runtime layers', () => {
    const open = composeBehaviourPrompt({
      behaviour: 'open',
      capabilityPolicy: 'DENY shell.execute filesystem.write network.private deployment.promote compute.allocate admin.configure',
      runtimePolicy: 'Private=local-only; do not wake expensive_burst if local/private can satisfy',
    });
    expect(open.text).toContain('DENY shell.execute');
    expect(open.text).toContain('do not wake expensive_burst');
    expect(open.text).toContain('Behaviour: Open');
    expect(open.layers.capabilityPolicy).toContain('DENY');
    expect(open.layers.runtimePolicy.length).toBeGreaterThan(0);
    expect(open.text.toLowerCase()).not.toMatch(/you may execute shell|granting admin|enable filesystem write/);
    expect(() =>
      composeBehaviourPrompt({ behaviour: 'open', capabilityPolicy: '  ', runtimePolicy: 'runtime' }),
    ).toThrow(/cannot replace capability or runtime policy/);
    const standard = composeBehaviourPrompt({
      behaviour: 'standard',
      capabilityPolicy: 'DENY shell.execute',
      runtimePolicy: 'local-only',
    });
    expect(standard.text).toContain('DENY shell.execute');
    expect(standard.text).toContain('Behaviour: Standard');
  });
});

describe('mountain-compat 8: Auto/Power-Pod specialist/fallback (historical hybrid-auto-policy @ 5cc7a96; inspected Forge-before-RunPod ranking)', () => {
  it('is not a dumb alias lookup and is not in ALIAS_POLICIES', () => {
    expect(capabilityAliasSchema.safeParse('auto').success).toBe(false);
    expect(capabilityAliasSchema.safeParse('power-pod').success).toBe(false);
    expect(Object.keys(ALIAS_POLICIES)).not.toContain('auto');
    expect(Object.keys(ALIAS_POLICIES)).not.toContain('power_pod');
    const { registry, router } = routingHarness();
    registry.register({
      provider: 'toy',
      model: 'auto',
      label: 'Not Auto',
      capabilities: { text: true, reasoning: false, tools: false, vision: false, code: false },
      contextWindow: 1000,
      costClass: 'free',
      latencyClass: 'fast',
      locality: 'public_cloud',
      runtimeClass: 'always_available',
      health: 'healthy',
      privacyEligibility: 'any',
      runtimeRequirements: [],
    });
    const routed = router.resolve('auto', { availableRuntimes: ['ollama', 'forge', 'runpod', 'openai'] });
    expect(routed.delegation).toBe('auto');
    expect(routed.resolvedRouteId).not.toBe('toy/auto');
    expect(routed.decisionReason).toMatch(/specialist\/fallback|fallback/);
  });

  it('does not wake burst GPU when local or private-hosted Forge can satisfy', () => {
    const { registry, router } = routingHarness();
    const auto = router.resolve('auto', {
      availableRuntimes: ['ollama', 'forge', 'runpod', 'openai', 'anthropic', 'gemini'],
    });
    expect(auto.resolvedRouteId).toBe('ollama/llama3.2');
    expect(auto.candidateChain.indexOf('forge/qwen3')).toBeLessThan(auto.candidateChain.indexOf('runpod/llm'));

    const power = router.resolve('power-pod', { availableRuntimes: ['ollama', 'forge', 'runpod'] });
    expect(power.delegation).toBe('power_pod');
    expect(power.resolvedRouteId).not.toBe('runpod/llm');
    expect(power.candidateChain.at(-1)).toBe('runpod/llm');

    registry.setHealth('ollama', 'unavailable');
    registry.setHealth('openai', 'unavailable');
    registry.setHealth('gemini', 'unavailable');
    registry.setHealth('anthropic', 'unavailable');
    const privateFirst = router.resolve('auto', {
      requireVision: true,
      availableRuntimes: ['forge', 'runpod'],
    });
    expect(privateFirst.resolvedRouteId).toBe('forge/qwen3');
    expect(privateFirst.candidateChain[0]).not.toBe('runpod/llm');
    expect(privateFirst.decisionReason).toMatch(/specialist/);
  });

  it('vNext ranking (not a Mountain alias): fastest healthy reasoner wins nexus/reason; Auto still prefers local', () => {
    // Historical Mountain 5cc7a96 capability table: nexus/reason primary was anthropic.
    // vNext ranks registered reasoners by runtime then latency. Fixture grok-build is fast.
    const { router } = routingHarness();
    const reason = router.resolve('nexus/reason', {
      availableRuntimes: ['xai', 'anthropic', 'ollama', 'forge', 'runpod'],
    });
    expect(reason.resolvedRouteId).toBe('xai/grok-build');
    expect(reason.candidateChain.indexOf('xai/grok-build')).toBeLessThan(
      reason.candidateChain.indexOf('anthropic/claude-sonnet'),
    );
    expect(reason.candidateChain).not.toContain('runpod/llm');

    const auto = router.resolve('auto', {
      availableRuntimes: ['xai', 'ollama', 'forge', 'runpod'],
    });
    expect(auto.resolvedRouteId).toBe('ollama/llama3.2');
    expect(auto.candidateChain.indexOf('forge/qwen3')).toBeLessThan(auto.candidateChain.indexOf('runpod/llm'));
    expect(auto.candidateChain).toContain('xai/grok-build');
  });

  it('local_only never selects public grok-build for nexus/reason merely because it is a strong reasoner', () => {
    const { router } = routingHarness();
    expect(() => router.resolve('nexus/reason', { privacy: 'local_only' })).toThrow(/No healthy candidates/);
    try {
      router.resolve('nexus/reason', { privacy: 'local_only' });
    } catch (error) {
      expect(error).toBeInstanceOf(RouteResolutionError);
      const rejected = error instanceof RouteResolutionError ? error.rejectedCandidates : [];
      expect(rejected.some((row) => row.provider === 'xai' && row.reason === 'privacy_local_only')).toBe(true);
      expect(rejected.some((row) => row.model === 'grok-build')).toBe(true);
    }

    const autoLocal = router.resolve('auto', {
      privacy: 'local_only',
      availableRuntimes: ['xai', 'ollama', 'forge', 'runpod'],
    });
    expect(autoLocal.resolvedRouteId).toBe('ollama/llama3.2');
    expect(autoLocal.candidateChain).not.toContain('xai/grok-build');
    expect(autoLocal.candidateChain.every((id) => id.startsWith('ollama/'))).toBe(true);
  });
});

describe('mountain-compat 9: route observability records attempts and rejects (historical performance/trace @ 5cc7a96; inspected vNext attempts)', () => {
  it('records actual attempted providers including failures, skips, and ranking rejects — not only the winner', async () => {
    const { router } = routingHarness();
    const routed = router.resolve('nexus/fast', { privacy: 'local_only' });
    const log = new MemoryRouteLog();
    const broker = new ExecutionBroker(1);
    broker.register({
      providerId: 'openai',
      async *stream() {
        throw new Error('should not run');
      },
    });
    broker.register({
      providerId: 'ollama',
      async *stream() {
        yield { type: 'text', text: 'local' };
      },
    });
    const attempts: Array<{ provider: string; outcome: string }> = [];
    await collect(broker, decision(['missing/x', 'ollama/llama3.2']), {
      onAttempt: (attempt) => attempts.push({ provider: attempt.provider, outcome: attempt.outcome }),
    });
    log.recordRoute(
      routeTraceFromDecision(routed, attempts.map((attempt) => ({ ...attempt, model: 'x', outcome: attempt.outcome as 'skipped' }))),
    );
    const failing = new ExecutionBroker(1);
    failing.register({
      providerId: 'openai',
      async *stream() {
        throw new Error('timeout');
      },
    });
    failing.register({
      providerId: 'ollama',
      async *stream() {
        yield { type: 'text', text: 'ok' };
      },
    });
    const observed: Array<{ provider: string; outcome: string }> = [];
    await collect(failing, decision(['openai/gpt-4o', 'ollama/llama3.2']), {
      onAttempt: (attempt) => observed.push({ provider: attempt.provider, outcome: attempt.outcome }),
    });
    expect(observed).toEqual(
      expect.arrayContaining([
        { provider: 'openai', outcome: 'started' },
        { provider: 'openai', outcome: 'failed' },
        { provider: 'ollama', outcome: 'started' },
        { provider: 'ollama', outcome: 'succeeded' },
      ]),
    );
    expect(routed.rejectedCandidates?.some((row) => row.provider === 'openai' && row.reason === 'privacy_local_only')).toBe(
      true,
    );
    expect(routed.rejectedCandidates?.some((row) => row.provider === 'runpod')).toBe(true);
    expect(attempts.some((attempt) => attempt.outcome === 'skipped' && attempt.provider === 'missing')).toBe(true);
    expect(log.last()?.rejectedCandidates.length).toBeGreaterThan(0);
  });
});

describe('mountain-compat 10: deployment/resource hygiene — bounded retention (historical storage-pressure @ 5cc7a96; inspected RuntimeObserver cap)', () => {
  it('prunes artefacts, workspaces, releases, and events instead of growing unbounded', () => {
    const guard = new RetentionGuard({
      maxArtefacts: 3,
      maxWorkspaces: 2,
      maxReleases: 2,
      maxEventLogEntries: 4,
      maxWorkspaceBytes: 100,
    });
    expect(guard.prune('artefacts', [1, 2, 3, 4, 5])).toEqual([3, 4, 5]);
    expect(guard.prune('releases', ['a', 'b', 'c'])).toEqual(['b', 'c']);
    expect(() =>
      guard.assertWithinBounds({ artefacts: 4, workspaces: 1, releases: 1, events: 1, workspaceBytes: 1 }),
    ).toThrow(/Artefact retention exceeded/);
    expect(DEFAULT_RETENTION_BOUNDS.maxEventLogEntries).toBeGreaterThan(0);
    expect(DEFAULT_RETENTION_BOUNDS.maxReleases).toBe(32);

    const workspaces = new BoundedWorkspaceIndex(new RetentionGuard({
      ...DEFAULT_RETENTION_BOUNDS,
      maxWorkspaces: 2,
      maxWorkspaceBytes: 50,
    }));
    workspaces.add('w1', 20);
    workspaces.add('w2', 20);
    workspaces.add('w3', 20);
    expect(workspaces.list().map((row) => row.id)).toEqual(['w2', 'w3']);
    workspaces.add('w4', 40);
    expect(workspaces.totalBytes()).toBeLessThanOrEqual(50);
  });

  it('bounds in-memory event logs and runtime observer streams', async () => {
    const events = new MemoryEventBus(() => '2026-09-14T00:00:00.000Z', 3);
    await events.publish({ channel: 'c', type: 'a', payload: { n: 1 } });
    await events.publish({ channel: 'c', type: 'b', payload: { n: 2 } });
    await events.publish({ channel: 'c', type: 'c', payload: { n: 3 } });
    await events.publish({ channel: 'c', type: 'd', payload: { n: 4 } });
    const history = await events.history('c');
    expect(history).toHaveLength(3);
    expect(history.map((item) => item.type)).toEqual(['b', 'c', 'd']);

    const observer = new RuntimeObserver();
    for (let i = 0; i < MAX_RUNTIME_EVENTS + 25; i += 1) {
      observer.record({
        type: 'tick',
        at: `t${i}`,
        state: 'idle',
        podId: null,
        profile: null,
        jobId: `job-${i}`,
        detail: String(i),
        queuedJobs: 0,
      });
    }
    expect(observer.list().length).toBe(MAX_RUNTIME_EVENTS);
  });
});
