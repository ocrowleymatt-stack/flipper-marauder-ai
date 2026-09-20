import { describe, expect, it } from 'vitest';
import type { ProviderHealth, RegisteredModel, StreamChunk } from '@atlas-vnext/contracts';
import { ExecutionBroker, ProviderHttpError, httpFailure } from '@atlas-vnext/execution';
import { NexusRegistry, NexusRouter } from '@atlas-vnext/nexus';

function model(
  partial: Partial<RegisteredModel> & Pick<RegisteredModel, 'provider' | 'model' | 'label'>,
): RegisteredModel {
  return {
    contextWindow: 32_768,
    costClass: 'medium',
    latencyClass: 'fast',
    locality: 'public_cloud',
    health: 'healthy',
    privacyEligibility: 'any',
    runtimeRequirements: [],
    runtimeClass: 'always_available',
    ...partial,
    capabilities: {
      text: true,
      reasoning: false,
      tools: true,
      vision: false,
      code: false,
      ...partial.capabilities,
    },
  };
}

async function drain(execute: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of execute) chunks.push(chunk);
  return chunks;
}

/**
 * Production replica: compose copies broker health into NexusRegistry.setHealth,
 * except Execution circuit-open which is HOW not WHERE.
 */
function productionHealthWiring(registry: NexusRegistry) {
  const observed: Array<{ provider: string; health: ProviderHealth; detail?: string }> = [];
  return {
    observed,
    onProviderHealth(provider: string, health: ProviderHealth, detail?: string) {
      observed.push({ provider, health, detail });
      if (detail === 'circuit_open') return;
      registry.setHealth(provider, health);
    },
  };
}

describe('Execution circuit vs Nexus routing eligibility', () => {
  it('A/C/D/E/I: Music-style timeouts open the Execution circuit without making nexus/fast unroutable', async () => {
    let clock = 1_000_000;
    const registry = new NexusRegistry();
    registry.register(
      model({
        provider: 'xai',
        model: 'grok-4.20-fast',
        label: 'Grok Fast',
        latencyClass: 'fast',
        capabilities: { text: true, reasoning: false, tools: true, vision: true, code: true },
      }),
    );
    registry.register(
      model({
        provider: 'xai',
        model: 'grok-4.20-reason',
        label: 'Grok Reason',
        latencyClass: 'medium',
        costClass: 'high',
        capabilities: { text: true, reasoning: true, tools: true, vision: true, code: true },
      }),
    );
    const health = productionHealthWiring(registry);
    const broker = new ExecutionBroker(1, { health, now: () => clock });
    let streamCalls = 0;
    let fail = false;
    broker.register({
      providerId: 'xai',
      async *stream() {
        streamCalls += 1;
        if (fail) throw new Error('Request timed out after 60000ms.');
        yield { type: 'text', text: 'pong' };
      },
    });
    const router = new NexusRouter(registry);

    // A. successful nexus/fast remains healthy
    const fast = router.resolve('nexus/fast');
    expect(fast.resolvedRouteId).toBe('xai/grok-4.20-fast');
    expect(await drain(broker.execute(fast, { prompt: 'PONG' }))).toEqual([{ type: 'text', text: 'pong' }]);
    expect(registry.get('xai', 'grok-4.20-fast')?.health).toBe('healthy');
    expect(registry.isRoutable(registry.get('xai', 'grok-4.20-fast')!)).toBe(true);

    // C. repeated Music-style timeouts (nexus/reason, same provider) exercise the threshold
    fail = true;
    const reason = router.resolve('nexus/reason');
    expect(reason.resolvedRouteId).toBe('xai/grok-4.20-reason');
    const callsBeforeTimeouts = streamCalls;
    for (let i = 0; i < 3; i += 1) {
      await expect(drain(broker.execute(reason, { prompt: 'compose a score' }))).rejects.toThrow(/timed out/);
    }
    expect(streamCalls - callsBeforeTimeouts).toBe(3);
    expect(broker.breaker('xai').isOpen()).toBe(true);
    expect(health.observed.some((entry) => entry.health === 'unhealthy')).toBe(false);
    expect(health.observed.some((entry) => entry.detail === 'circuit_open')).toBe(false);

    // D. Nexus still admits nexus/fast while the Execution circuit is open
    expect(registry.get('xai', 'grok-4.20-fast')?.health).toBe('healthy');
    expect(registry.get('xai', 'grok-4.20-reason')?.health).toBe('healthy');
    const stillFast = router.resolve('nexus/fast');
    expect(stillFast.resolvedRouteId).toBe('xai/grok-4.20-fast');

    // I. recovery cannot create an uncontrolled retry loop: open circuit skips without stream()
    const callsBeforeSkip = streamCalls;
    await expect(drain(broker.execute(stillFast, { prompt: 'PONG' }))).rejects.toThrow(/Circuit open for xai/);
    expect(streamCalls).toBe(callsBeforeSkip);
    expect(broker.breaker('xai').isOpen()).toBe(true);

    // D/E. after cooldown, the same broker/process serves nexus/fast without restart
    clock += 61_000;
    expect(broker.breaker('xai').isOpen()).toBe(false);
    fail = false;
    expect(await drain(broker.execute(router.resolve('nexus/fast'), { prompt: 'PONG' }))).toEqual([
      { type: 'text', text: 'pong' },
    ]);
    expect(registry.get('xai', 'grok-4.20-fast')?.health).toBe('healthy');
  });

  it('G: does not start a second provider after visible output', async () => {
    const registry = new NexusRegistry();
    registry.register(model({ provider: 'xai', model: 'grok-4.20-fast', label: 'Fast' }));
    registry.register(
      model({
        provider: 'ollama',
        model: 'llama3.2',
        label: 'Local',
        locality: 'local',
        privacyEligibility: 'local_only',
      }),
    );
    const health = productionHealthWiring(registry);
    const broker = new ExecutionBroker(1, { health });
    broker.register({
      providerId: 'xai',
      async *stream() {
        yield { type: 'text', text: 'partial' };
        throw new Error('Request timed out after 60000ms.');
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
      for await (const chunk of broker.execute(
        {
          target: 'nexus/fast',
          resolvedRouteId: 'xai/grok-4.20-fast',
          provider: 'xai',
          model: 'grok-4.20-fast',
          candidateChain: ['xai/grok-4.20-fast', 'ollama/llama3.2'],
          localOnly: false,
          locality: 'public_cloud',
          runtimeClass: 'always_available',
          decisionReason: 'test',
          traceId: 'trc_visible',
          evaluatedAt: new Date().toISOString(),
        },
        { prompt: 'hi' },
      )) {
        chunks.push(chunk);
      }
    }).rejects.toThrow(/timed out/);
    expect(chunks).toEqual([{ type: 'text', text: 'partial' }]);
  });

  it('H: genuine unavailability is still excluded from Nexus admission', () => {
    const registry = new NexusRegistry();
    registry.register(model({ provider: 'xai', model: 'grok-4.20-fast', label: 'Fast' }));
    const router = new NexusRouter(registry);
    expect(router.resolve('nexus/fast').resolvedRouteId).toBe('xai/grok-4.20-fast');
    registry.setHealth('xai', 'unavailable');
    expect(registry.isRoutable(registry.get('xai', 'grok-4.20-fast')!)).toBe(false);
    expect(() => router.resolve('nexus/fast')).toThrow(/No healthy candidates/);
  });

  it('H: authentication_failure still copies into Nexus and remains unroutable', async () => {
    const registry = new NexusRegistry();
    registry.register(model({ provider: 'xai', model: 'grok-4.20-fast', label: 'Fast' }));
    const health = productionHealthWiring(registry);
    const broker = new ExecutionBroker(1, { health });
    broker.register({
      providerId: 'xai',
      async *stream() {
        throw new ProviderHttpError(httpFailure('xai', 401, 'Incorrect API key provided.'));
      },
    });
    await expect(
      drain(
        broker.execute(
          {
            target: 'nexus/fast',
            resolvedRouteId: 'xai/grok-4.20-fast',
            provider: 'xai',
            model: 'grok-4.20-fast',
            candidateChain: ['xai/grok-4.20-fast'],
            localOnly: false,
            locality: 'public_cloud',
            runtimeClass: 'always_available',
            decisionReason: 'test',
            traceId: 'trc_auth',
            evaluatedAt: new Date().toISOString(),
          },
          { prompt: 'hi' },
        ),
      ),
    ).rejects.toThrow(/Incorrect API key|Execution failed/);
    expect(health.observed.some((entry) => entry.health === 'authentication_failure')).toBe(true);
    expect(registry.get('xai', 'grok-4.20-fast')?.health).toBe('authentication_failure');
    expect(registry.isRoutable(registry.get('xai', 'grok-4.20-fast')!)).toBe(false);
    expect(() => new NexusRouter(registry).resolve('nexus/fast')).toThrow(/No healthy candidates/);
  });
});
