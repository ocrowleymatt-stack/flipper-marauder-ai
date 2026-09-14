import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RouteDecision, StreamChunk } from '@atlas-vnext/contracts';
import {
  CREATE_POD_REFUSED_REASON,
  ExecutionBroker,
  FileRuntimeStateStore,
  MapSecretStore,
  MemoryRunPodClient,
  MemoryRuntimeStateStore,
  RunPodAdapter,
  RuntimeObserver,
  RuntimeScheduler,
  createExecutionPlane,
  emptyRuntime,
  readExecutionConfig,
  responseFromText,
  waitingCopy,
  MAX_KEEP_WARM_SECONDS,
  MAX_RUNTIME_EVENTS,
  type ProviderAdapter,
  type RuntimeClock,
} from '@atlas-vnext/execution';

class ManualClock implements RuntimeClock {
  current = 1_700_000_000_000;

  now(): number {
    return this.current;
  }

  iso(at = this.current): string {
    return new Date(at).toISOString();
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('Execution aborted.');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.current += ms;
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, 1);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('Execution aborted.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function harness(
  overrides: {
    idleShutdownSeconds?: number;
    client?: MemoryRunPodClient;
    store?: MemoryRuntimeStateStore | FileRuntimeStateStore;
    leaseTtlSeconds?: number;
  } = {},
) {
  const client = overrides.client ?? new MemoryRunPodClient();
  if (!client.pods.has('pod-shared')) {
    client.seed({ id: 'pod-shared', desiredStatus: 'EXITED' });
  }
  const clock = new ManualClock();
  const observer = new RuntimeObserver();
  const store = overrides.store ?? new MemoryRuntimeStateStore();
  const scheduler = new RuntimeScheduler({
    client,
    store,
    clock,
    observer,
    podId: 'pod-shared',
    maxActivePods: 99,
    idleShutdownSeconds: overrides.idleShutdownSeconds ?? 30,
    warmTimeoutMs: 5_000,
    pollIntervalMs: 10,
    leaseTtlSeconds: overrides.leaseTtlSeconds ?? 900,
  });
  return { client, clock, observer, store, scheduler };
}

function route(chain: string[]): RouteDecision {
  const [primary] = chain;
  const [provider, model] = (primary ?? 'runpod/llm').split('/');
  return {
    target: primary ?? 'runpod/llm',
    resolvedRouteId: primary ?? 'runpod/llm',
    provider: provider ?? 'runpod',
    model: model ?? 'llm',
    candidateChain: chain,
    localOnly: false,
    locality: 'private_cloud',
    runtimeClass: 'expensive_burst',
    decisionReason: 'test',
    traceId: 'trc_test',
    evaluatedAt: new Date().toISOString(),
  };
}

describe('RunPod shared runtime scheduler', () => {
  it('starts a stopped pod, leases, executes, then idles and auto-stops', async () => {
    const { client, clock, observer, scheduler } = harness({ idleShutdownSeconds: 5 });
    const lease = await scheduler.acquire({ id: 'job-1', profile: 'llm', traceId: 'trc-1', requestedModel: 'llm' });
    expect(client.startCalls).toEqual(['pod-shared']);
    expect(client.createCalls).toBe(0);
    expect(scheduler.snapshot().runtime.state).toBe('busy');
    expect(scheduler.snapshot().runtime.lease?.jobId).toBe('job-1');
    expect(lease.exclusive).toBe(true);
    expect(lease.traceId).toBe('trc-1');
    expect(lease.heartbeatAt).toBeTruthy();
    expect(lease.expiresAt).toBeTruthy();
    expect(lease.state).toBe('acquired');
    expect(lease.workloadType).toBe('inference');
    expect(lease.requestedModel).toBe('llm');
    await scheduler.release(lease.id);
    expect(scheduler.snapshot().runtime.state).toBe('idle');
    expect(scheduler.snapshot().runtime.idleSince).toBeTruthy();
    clock.advance(6_000);
    await scheduler.tick();
    expect(client.stopCalls).toEqual(['pod-shared']);
    expect(scheduler.snapshot().runtime.state).toBe('stopped');
    expect(scheduler.snapshot().runtime.stopReason).toMatch(/idle_timeout/);
    expect(observer.list().some((event) => event.type === 'stopped')).toBe(true);
    expect(observer.list().every((event) => !JSON.stringify(event).includes('RUNPOD_API_KEY'))).toBe(true);
    expect(scheduler.snapshot().maxActivePods).toBe(1);
    expect(scheduler.snapshot().scaleOutDisabled).toBe(true);
  });

  it('starting pod causes a second job to wait without launching another pod', async () => {
    const client = new MemoryRunPodClient();
    client.promoteOnStart = false;
    client.seed({ id: 'pod-shared', desiredStatus: 'EXITED' });
    const { scheduler } = harness({ client });
    const firstPromise = scheduler.acquire({ id: 'job-1', profile: 'llm' });
    await waitUntil(() => {
      const state = scheduler.snapshot().runtime.state;
      return state === 'starting' || state === 'warming';
    });
    const secondPromise = scheduler.acquire({ id: 'job-2', profile: 'image' });
    await waitUntil(() => scheduler.snapshot().runtime.queue.some((job) => job.id === 'job-2'));
    expect(client.startCalls).toEqual(['pod-shared']);
    expect(scheduler.snapshot().runtime.lease).toBeNull();
    expect(scheduler.snapshot().runtime.queue.find((job) => job.id === 'job-2')?.status).toBe('waiting_runtime');
    expect(scheduler.waitingMessage('job-2')).toBe('GPU runtime starting');
    client.promote('pod-shared');
    const first = await firstPromise;
    expect(first.jobId).toBe('job-1');
    expect(scheduler.snapshot().runtime.queue.some((job) => job.id === 'job-2')).toBe(true);
    await scheduler.release(first.id);
    const second = await secondPromise;
    expect(second.jobId).toBe('job-2');
    expect(client.startCalls).toHaveLength(1);
    await scheduler.release(second.id);
  });

  it('ready pod grants a lease without starting again', async () => {
    const client = new MemoryRunPodClient();
    client.seed({ id: 'pod-shared', desiredStatus: 'RUNNING', costPerHr: 1.5 });
    const { scheduler } = harness({ client });
    const lease = await scheduler.acquire({ id: 'job-ready', profile: 'llm' });
    expect(client.startCalls).toEqual([]);
    expect(lease.jobId).toBe('job-ready');
    expect(scheduler.snapshot().runtime.state).toBe('busy');
    await scheduler.release(lease.id);
  });

  it('queues a second incompatible job instead of starting another pod while busy', async () => {
    const { client, scheduler } = harness();
    const first = await scheduler.acquire({ id: 'job-a', profile: 'llm' });
    const pending = scheduler.acquire({ id: 'job-b', profile: 'image' });
    await waitUntil(() => scheduler.snapshot().runtime.queue.some((job) => job.id === 'job-b'));
    expect(client.startCalls).toEqual(['pod-shared']);
    expect(scheduler.snapshot().runtime.queue.some((job) => job.id === 'job-b' && job.status === 'waiting_runtime')).toBe(
      true,
    );
    expect(scheduler.snapshot().runtime.lease?.exclusive).toBe(true);
    expect(scheduler.snapshot().runtime.lease?.jobId).toBe('job-a');
    await scheduler.release(first.id);
    const second = await pending;
    expect(second.jobId).toBe('job-b');
    expect(second.profile).toBe('image');
    expect(client.startCalls).toHaveLength(1);
    await scheduler.release(second.id);
  });

  it('does not assume concurrency: a second compatible job still queues behind an exclusive lease', async () => {
    const { scheduler } = harness();
    const first = await scheduler.acquire({ id: 'job-a', profile: 'llm' });
    const pending = scheduler.acquire({ id: 'job-b', profile: 'llm' });
    await waitUntil(() => scheduler.snapshot().runtime.queue.some((job) => job.id === 'job-b'));
    expect(scheduler.snapshot().runtime.lease?.jobId).toBe('job-a');
    expect(scheduler.snapshot().runtime.queue).toHaveLength(1);
    await scheduler.release(first.id);
    const second = await pending;
    expect(second.jobId).toBe('job-b');
    await scheduler.release(second.id);
  });

  it('batches a compatible queued job ahead of an incompatible one after release', async () => {
    const { scheduler } = harness();
    const first = await scheduler.acquire({ id: 'job-llm-1', profile: 'llm' });
    const imagePromise = scheduler.acquire({ id: 'job-image', profile: 'image' });
    const llmPromise = scheduler.acquire({ id: 'job-llm-2', profile: 'llm' });
    await waitUntil(() => scheduler.snapshot().runtime.queue.length === 2);
    await scheduler.release(first.id);
    const second = await llmPromise;
    expect(second.jobId).toBe('job-llm-2');
    expect(scheduler.snapshot().runtime.queue[0]?.id).toBe('job-image');
    await scheduler.release(second.id);
    const image = await imagePromise;
    expect(image.jobId).toBe('job-image');
    await scheduler.release(image.id);
  });

  it('cancels idle shutdown when new work arrives during grace', async () => {
    const { client, scheduler } = harness({ idleShutdownSeconds: 60 });
    const first = await scheduler.acquire({ id: 'job-1', profile: 'llm' });
    await scheduler.release(first.id);
    expect(scheduler.snapshot().runtime.state).toBe('idle');
    const second = await scheduler.acquire({ id: 'job-2', profile: 'llm' });
    expect(client.stopCalls).toEqual([]);
    expect(client.startCalls).toEqual(['pod-shared']);
    expect(scheduler.snapshot().runtime.state).toBe('busy');
    expect(scheduler.snapshot().runtime.idleSince).toBeNull();
    await scheduler.release(second.id);
  });

  it('rechecks the queue immediately before stop and cancels a raced job', async () => {
    const { client, clock, scheduler } = harness({ idleShutdownSeconds: 5 });
    const first = await scheduler.acquire({ id: 'job-1', profile: 'llm' });
    await scheduler.release(first.id);
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    scheduler.deferStop(gate);
    clock.advance(6_000);
    const tickPromise = scheduler.tick();
    await waitUntil(() => scheduler.snapshot().runtime.state === 'stopping');
    const raced = scheduler.acquire({ id: 'job-race', profile: 'llm' });
    await waitUntil(() => scheduler.snapshot().runtime.queue.some((job) => job.id === 'job-race') || scheduler.snapshot().runtime.lease?.jobId === 'job-race');
    releaseGate();
    await tickPromise;
    expect(client.stopCalls).toEqual([]);
    const lease = await raced;
    expect(lease.jobId).toBe('job-race');
    expect(scheduler.snapshot().runtime.state).toBe('busy');
    await scheduler.release(lease.id);
  });

  it('does not stop while a model download or checkpoint is active', async () => {
    const { client, clock, scheduler } = harness({ idleShutdownSeconds: 5 });
    const lease = await scheduler.acquire({ id: 'job-1', profile: 'llm' });
    await scheduler.release(lease.id);
    await scheduler.setActivity('model_download');
    clock.advance(10_000);
    await scheduler.tick();
    expect(client.stopCalls).toEqual([]);
    await scheduler.setActivity('none');
    clock.advance(10_000);
    await scheduler.tick();
    expect(client.stopCalls).toEqual(['pod-shared']);
  });

  it('keep-warm is an explicit time-bounded override, not an always-on default', async () => {
    const { client, clock, scheduler } = harness({ idleShutdownSeconds: 5 });
    expect(scheduler.snapshot().keepWarmUntil).toBeNull();
    const lease = await scheduler.acquire({ id: 'job-1', profile: 'llm' });
    await scheduler.release(lease.id);
    await scheduler.requestKeepWarm(60);
    expect(scheduler.snapshot().keepWarmUntil).toBeTruthy();
    clock.advance(10_000);
    await scheduler.tick();
    expect(client.stopCalls).toEqual([]);
    await scheduler.requestKeepWarm(0);
    clock.advance(10_000);
    await scheduler.tick();
    expect(client.stopCalls).toEqual(['pod-shared']);
  });

  it('clamps keep-warm so it cannot silently become 24/7', async () => {
    const { client, clock, scheduler } = harness({ idleShutdownSeconds: 5 });
    const lease = await scheduler.acquire({ id: 'job-1', profile: 'llm' });
    await scheduler.release(lease.id);
    await scheduler.requestKeepWarm(86_400);
    const until = Date.parse(scheduler.snapshot().keepWarmUntil ?? '');
    expect(until - clock.now()).toBeLessThanOrEqual(MAX_KEEP_WARM_SECONDS * 1000);
    clock.advance(MAX_KEEP_WARM_SECONDS * 1000 + 10_000);
    await scheduler.tick();
    expect(client.stopCalls).toEqual(['pod-shared']);
  });

  it('enforces max active pods = 1 and never creates a second pod', async () => {
    const client = new MemoryRunPodClient();
    client.seed({ id: 'pod-shared', desiredStatus: 'RUNNING' });
    client.seed({ id: 'pod-extra', desiredStatus: 'RUNNING' });
    const { scheduler } = harness({ client });
    await scheduler.reconcile();
    expect(client.stopCalls).toContain('pod-extra');
    expect(client.createCalls).toBe(0);
    const lease = await scheduler.acquire({ id: 'job-1', profile: 'llm' });
    expect(new Set(client.startCalls)).toEqual(new Set());
    await expect(scheduler.refuseCreatePod()).rejects.toThrow(CREATE_POD_REFUSED_REASON);
    await expect(client.createPod()).rejects.toThrow(CREATE_POD_REFUSED_REASON);
    expect(client.createCalls).toBe(1);
    await scheduler.release(lease.id);
  });

  it('clamps RUNPOD_MAX_ACTIVE_PODS to 1 and honours idle shutdown config', () => {
    const config = readExecutionConfig({
      RUNPOD_MAX_ACTIVE_PODS: '9',
      RUNPOD_IDLE_SHUTDOWN_SECONDS: '45',
    });
    expect(config.runpodMaxActivePods).toBe(1);
    expect(config.runpodIdleShutdownSeconds).toBe(45);
  });

  it('recovers after crash: rediscovers the running pod, drops orphaned lease, does not double-start', async () => {
    const client = new MemoryRunPodClient();
    client.seed({ id: 'pod-shared', desiredStatus: 'RUNNING' });
    const persisted = emptyRuntime('2026-09-14T00:00:00.000Z', 'pod-shared');
    persisted.state = 'busy';
    persisted.lease = {
      id: 'lease_old',
      jobId: 'job-crashed',
      workloadType: 'inference',
      profile: 'llm',
      requestedModel: 'llm',
      acquiredAt: '2026-09-14T00:00:00.000Z',
      expiresAt: '2026-09-14T00:15:00.000Z',
      heartbeatAt: '2026-09-14T00:00:00.000Z',
      state: 'acquired',
      traceId: 'job-crashed',
      exclusive: true,
      releasedAt: null,
    };
    persisted.queue = [
      {
        id: 'job-queued',
        profile: 'llm',
        workloadType: 'inference',
        requestedModel: 'llm',
        traceId: 'job-queued',
        enqueuedAt: '2026-09-14T00:00:01.000Z',
        status: 'waiting_runtime',
        waitingReason: 'pod_busy',
      },
    ];
    const store = new MemoryRuntimeStateStore(persisted);
    const { scheduler } = harness({ client, store, idleShutdownSeconds: 60 });
    const recovered = await scheduler.reconcile();
    expect(recovered.state).toBe('ready');
    expect(recovered.lease).toBeNull();
    expect(recovered.queue.some((job) => job.id === 'job-queued')).toBe(true);
    expect(client.startCalls).toEqual([]);
    const lease = await scheduler.acquire({ id: 'job-queued', profile: 'llm' });
    expect(lease.jobId).toBe('job-queued');
    expect(client.startCalls).toEqual([]);
    await scheduler.release(lease.id);
  });

  it('shuts down orphaned paid capacity that is genuinely idle after restart', async () => {
    const client = new MemoryRunPodClient();
    client.seed({ id: 'pod-shared', desiredStatus: 'RUNNING' });
    const persisted = emptyRuntime('2026-09-14T00:00:00.000Z', 'pod-shared');
    persisted.state = 'idle';
    persisted.idleSince = '2000-01-01T00:00:00.000Z';
    persisted.startedAt = '2000-01-01T00:00:00.000Z';
    const store = new MemoryRuntimeStateStore(persisted);
    const { scheduler } = harness({ client, store, idleShutdownSeconds: 1 });
    const recovered = await scheduler.reconcile();
    expect(recovered.state).toBe('stopped');
    expect(client.stopCalls).toContain('pod-shared');
    expect(client.startCalls).toEqual([]);
  });

  it('does not start RunPod during composition/reconcile when stopped', async () => {
    const { client, scheduler } = harness();
    await scheduler.reconcile();
    expect(client.startCalls).toEqual([]);
    expect(scheduler.snapshot().runtime.state).toBe('stopped');
  });

  it('persists scheduler state durably, not only in memory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-runtime-'));
    const store = new FileRuntimeStateStore(join(dir, 'runtime.json'));
    const { scheduler } = harness({ store });
    const lease = await scheduler.acquire({ id: 'job-1', profile: 'llm', traceId: 'trc-persist' });
    const raw = JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8')) as { lease: { traceId: string; exclusive: boolean } };
    expect(raw.lease.traceId).toBe('trc-persist');
    expect(raw.lease.exclusive).toBe(true);
    await scheduler.release(lease.id);
  });

  it('exposes GPU waiting copy for the UI', () => {
    expect(waitingCopy('pod_starting', 'starting')).toBe('GPU runtime starting');
    expect(waitingCopy('pod_busy', 'busy')).toBe('Waiting for the shared GPU');
  });
});

describe('RunPod failover and unrelated providers', () => {
  it('keeps unrelated cloud providers running when RunPod is unavailable', async () => {
    const plane = createExecutionPlane({
      mode: 'live',
      env: { OPENAI_API_KEY: 'sk-test' },
      secrets: new MapSecretStore({ OPENAI_API_KEY: 'sk-test' }),
      transport: {
        async send() {
          return responseFromText(
            200,
            'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
            { 'content-type': 'text/event-stream' },
          );
        },
      },
    });
    expect(plane.available).toContain('openai');
    expect(plane.unavailable).toContain('runpod');
    expect(plane.scheduler).toBeNull();
    const chunks: StreamChunk[] = [];
    for await (const chunk of plane.broker.execute(route(['openai/gpt-4o']), { prompt: 'hi' })) {
      chunks.push(chunk);
    }
    expect(chunks.filter((chunk) => chunk.type === 'text')).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('does not treat a stopped RunPod as a process failure', async () => {
    const client = new MemoryRunPodClient();
    client.seed({ id: 'pod-shared', desiredStatus: 'EXITED' });
    const plane = createExecutionPlane({
      mode: 'live',
      env: { OPENAI_API_KEY: 'sk-test', RUNPOD_API_KEY: 'rp-test', RUNPOD_POD_ID: 'pod-shared' },
      secrets: new MapSecretStore({ OPENAI_API_KEY: 'sk-test', RUNPOD_API_KEY: 'rp-test' }),
      runpodClient: client,
      transport: {
        async send() {
          return responseFromText(
            200,
            'data: {"choices":[{"delta":{"content":"cloud"}}]}\n\ndata: [DONE]\n\n',
            { 'content-type': 'text/event-stream' },
          );
        },
      },
    });
    await plane.scheduler?.reconcile();
    expect(plane.available).toEqual(expect.arrayContaining(['openai', 'runpod', 'ollama']));
    expect(plane.health.runpod).toBe('configured');
    expect(plane.runtimeSnapshot()?.runtime.state).toBe('stopped');
    expect(client.startCalls).toEqual([]);
    const chunks: StreamChunk[] = [];
    for await (const chunk of plane.broker.execute(route(['openai/gpt-4o']), { prompt: 'hi' })) {
      chunks.push(chunk);
    }
    expect(chunks.some((chunk) => chunk.type === 'text' && chunk.text === 'cloud')).toBe(true);
  });

  it('may fallback before visible RunPod output and must not second-respond after it', async () => {
    const broker = new ExecutionBroker(1);
    const failing: ProviderAdapter = {
      providerId: 'runpod',
      async *stream() {
        throw new Error('runpod unavailable before tokens');
      },
    };
    const ok: ProviderAdapter = {
      providerId: 'openai',
      async *stream() {
        yield { type: 'text', text: 'fallback' };
      },
    };
    broker.register(failing);
    broker.register(ok);
    const recovered: StreamChunk[] = [];
    for await (const chunk of broker.execute(route(['runpod/llm', 'openai/gpt-4o']), { prompt: 'hi' })) {
      recovered.push(chunk);
    }
    expect(recovered).toEqual([{ type: 'text', text: 'fallback' }]);

    const partial = new ExecutionBroker(1);
    partial.register({
      providerId: 'runpod',
      async *stream() {
        yield { type: 'text', text: 'visible' };
        throw new Error('cut after output');
      },
    });
    partial.register({
      providerId: 'openai',
      async *stream() {
        yield { type: 'text', text: 'contradiction' };
      },
    });
    const seen: StreamChunk[] = [];
    await expect(async () => {
      for await (const chunk of partial.execute(route(['runpod/llm', 'openai/gpt-4o']), { prompt: 'hi' })) {
        seen.push(chunk);
      }
    }).rejects.toThrow('cut after output');
    expect(seen).toEqual([{ type: 'text', text: 'visible' }]);
  });

  it('RunPod adapter emits a GPU waiting warning then leases the shared pod', async () => {
    const { scheduler, client } = harness();
    const adapter = new RunPodAdapter({
      scheduler,
      secrets: new MapSecretStore({ RUNPOD_API_KEY: 'rp' }),
      timeoutMs: 5_000,
      inferenceBaseUrl: 'http://127.0.0.1:9',
      transport: {
        async send() {
          throw new Error('inference not used');
        },
      },
      createInference: () => ({
        providerId: 'runpod',
        async *stream() {
          yield { type: 'text', text: 'from-gpu' };
        },
      }),
    });
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream('llm', { prompt: 'hi', traceId: 'job-ui' })) {
      chunks.push(chunk);
    }
    expect(chunks[0]).toEqual({ type: 'warning', message: 'GPU runtime starting', provider: 'runpod' });
    expect(chunks.some((chunk) => chunk.type === 'text' && chunk.text === 'from-gpu')).toBe(true);
    expect(client.startCalls).toEqual(['pod-shared']);
    expect(scheduler.snapshot().runtime.lease).toBeNull();
  });

  it('startup failure is structured, finite, and does not create a second pod', async () => {
    class BoomStart extends MemoryRunPodClient {
      async startPod(id: string) {
        this.startCalls.push(id);
        throw new Error('start refused');
      }
    }
    const client = new BoomStart();
    client.seed({ id: 'pod-shared', desiredStatus: 'EXITED' });
    const { scheduler } = harness({ client });
    await expect(scheduler.acquire({ id: 'job-1', profile: 'llm' })).rejects.toThrow(/start refused/);
    expect(client.startCalls).toEqual(['pod-shared']);
    expect(client.createCalls).toBe(0);
    expect(scheduler.snapshot().runtime.state).toBe('failed');
    expect(scheduler.snapshot().runtime.startupFailure).toMatch(/start refused/);
  });

  it('keeps Atlas alive when the RunPod API is unavailable', async () => {
    class DownApi extends MemoryRunPodClient {
      async listPods() {
        throw new Error('RunPod API unavailable');
      }
    }
    const client = new DownApi();
    client.seed({ id: 'pod-shared', desiredStatus: 'EXITED' });
    const plane = createExecutionPlane({
      mode: 'live',
      env: { OPENAI_API_KEY: 'sk-test', RUNPOD_API_KEY: 'rp-test', RUNPOD_POD_ID: 'pod-shared' },
      secrets: new MapSecretStore({ OPENAI_API_KEY: 'sk-test', RUNPOD_API_KEY: 'rp-test' }),
      runpodClient: client,
      transport: {
        async send() {
          return responseFromText(
            200,
            'data: {"choices":[{"delta":{"content":"cloud"}}]}\n\ndata: [DONE]\n\n',
            { 'content-type': 'text/event-stream' },
          );
        },
      },
    });
    const recovered = await plane.scheduler?.reconcile();
    expect(recovered?.healthFailure).toMatch(/RunPod API unavailable/);
    expect(client.startCalls).toEqual([]);
    expect(client.createCalls).toBe(0);
    const chunks: StreamChunk[] = [];
    for await (const chunk of plane.broker.execute(route(['openai/gpt-4o']), { prompt: 'hi' })) {
      chunks.push(chunk);
    }
    expect(chunks.some((chunk) => chunk.type === 'text' && chunk.text === 'cloud')).toBe(true);
  });

  it('waiting/idle loops do not allocate unbounded events or state writes', async () => {
    class CountingStore extends MemoryRuntimeStateStore {
      saves = 0;
      async save(runtime: Parameters<MemoryRuntimeStateStore['save']>[0]): Promise<void> {
        this.saves += 1;
        await super.save(runtime);
      }
    }
    const client = new MemoryRunPodClient();
    client.promoteOnStart = false;
    client.seed({ id: 'pod-shared', desiredStatus: 'EXITED' });
    const store = new CountingStore();
    const { scheduler, observer } = harness({ client, store });
    const firstPromise = scheduler.acquire({ id: 'job-1', profile: 'llm' });
    await waitUntil(() => {
      const state = scheduler.snapshot().runtime.state;
      return state === 'starting' || state === 'warming';
    });
    const secondPromise = scheduler.acquire({ id: 'job-2', profile: 'llm' });
    await waitUntil(() => scheduler.snapshot().runtime.queue.some((job) => job.id === 'job-2'));
    const savesAfterQueue = store.saves;
    const eventsAfterQueue = observer.list().length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(store.saves - savesAfterQueue).toBeLessThan(3);
    expect(observer.list().length - eventsAfterQueue).toBeLessThan(3);
    expect(observer.list().length).toBeLessThan(MAX_RUNTIME_EVENTS);
    client.promote('pod-shared');
    const first = await firstPromise;
    await scheduler.release(first.id);
    const second = await secondPromise;
    await scheduler.release(second.id);
  });

  it('compacts duplicate observer events and caps the log', () => {
    const observer = new RuntimeObserver();
    for (let i = 0; i < 40; i += 1) {
      observer.record({
        at: `t${i}`,
        type: 'warming',
        podId: 'pod-shared',
        state: 'warming',
        profile: 'llm',
        jobId: 'job-2',
        detail: 'Waiting for RunPod to become ready.',
      });
    }
    expect(observer.list()).toHaveLength(1);
    for (let i = 0; i < MAX_RUNTIME_EVENTS + 25; i += 1) {
      observer.record({
        at: `u${i}`,
        type: `unique-${i}`,
        podId: 'pod-shared',
        state: 'idle',
        profile: null,
      });
    }
    expect(observer.list()).toHaveLength(MAX_RUNTIME_EVENTS);
  });
});
