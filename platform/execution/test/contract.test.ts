import { describe, expect, it, vi } from 'vitest';

import { NexusRouter } from '@atlas/nexus';
import { contractRegistry } from '@atlas/testing';

import { ExecutionBroker } from '../src/broker.js';
import { FakeAdapter, FailingAdapter, PartialThenFailAdapter, TransientThenOkAdapter } from '../src/fakes.js';

describe('Execution contract: failover without a second answer', () => {
  it('falls through to the next Nexus candidate when the primary fails before output', async () => {
    const router = new NexusRouter(contractRegistry());
    const decision = router.resolve({ schemaVersion: 1, alias: 'nexus/fast' });
    const primary = decision.candidates[0]!;
    const fallback = decision.candidates[1]!;
    expect(fallback).toBeTruthy();

    const broker = new ExecutionBroker(
      [
        new FailingAdapter(primary.providerId, primary.modelId, 'unavailable'),
        new FakeAdapter(fallback.providerId, fallback.modelId, [{ type: 'text', text: 'fallback-ok' }]),
      ],
      { baseDelayMs: 0, sleep: async () => undefined },
    );

    const events = [];
    for await (const event of broker.execute({ decision, prompt: 'hello' })) events.push(event);

    const texts = events.filter((event) => event.type === 'text');
    expect(texts).toEqual([
      { type: 'text', text: 'fallback-ok', providerId: fallback.providerId, modelId: fallback.modelId },
    ]);
    expect(events.some((event) => event.type === 'fallback')).toBe(true);
    expect(events.filter((event) => event.type === 'completed')).toHaveLength(1);
  });

  it('never starts a second model after a partial visible stream', async () => {
    const router = new NexusRouter(contractRegistry());
    const decision = router.resolve({ schemaVersion: 1, alias: 'nexus/fast' });
    const primary = decision.candidates[0]!;
    const fallback = decision.candidates[1]!;
    const second = vi.fn(async function* () {
      yield { type: 'text' as const, text: 'second-answer' };
    });

    const broker = new ExecutionBroker(
      [
        new PartialThenFailAdapter(primary.providerId, primary.modelId, 'first-tokens'),
        { providerId: fallback.providerId, modelId: fallback.modelId, stream: second },
      ],
      { baseDelayMs: 0 },
    );

    const events = [];
    await expect(async () => {
      for await (const event of broker.execute({ decision, prompt: 'hello' })) events.push(event);
    }).rejects.toMatchObject({ classifiedAs: 'abrupt_end' });

    expect(events.filter((event) => event.type === 'text').map((event) => event.type === 'text' && event.text)).toEqual([
      'first-tokens',
    ]);
    expect(second).not.toHaveBeenCalled();
  });

  it('retries a transient pre-output failure on the same provider before falling through', async () => {
    const router = new NexusRouter(contractRegistry());
    const decision = router.resolve({ schemaVersion: 1, alias: 'nexus/fast' });
    const primary = decision.candidates[0]!;
    const fallback = vi.fn(async function* () {
      yield { type: 'text' as const, text: 'should-not-run' };
    });

    const broker = new ExecutionBroker(
      [
        new TransientThenOkAdapter(primary.providerId, primary.modelId, 2),
        { providerId: decision.candidates[1]!.providerId, modelId: decision.candidates[1]!.modelId, stream: fallback },
      ],
      { baseDelayMs: 0, sleep: async () => undefined },
    );

    const events = [];
    for await (const event of broker.execute({ decision, prompt: 'hello' })) events.push(event);

    expect(events.some((event) => event.type === 'retry')).toBe(true);
    expect(events.some((event) => event.type === 'text' && event.text === `recovered:${primary.providerId}`)).toBe(true);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('does not invent fallbacks for an explicit unhealthy-at-runtime target after output-less failure when allowFallback is false', async () => {
    const router = new NexusRouter(contractRegistry());
    const decision = router.resolve({
      schemaVersion: 1,
      explicit: { providerId: 'openai', modelId: 'gpt-code' },
    });
    const broker = new ExecutionBroker(
      [
        new FailingAdapter('openai', 'gpt-code', 'auth_failure'),
        new FakeAdapter('anthropic', 'claude-reason'),
      ],
      { baseDelayMs: 0 },
    );

    await expect(async () => {
      for await (const _ of broker.execute({ decision, prompt: 'hello', allowFallback: false })) {
        /* drain */
      }
    }).rejects.toMatchObject({ classifiedAs: 'auth_failure' });
  });

  it('commits buffered tool calls only after the provider stream succeeds', async () => {
    const router = new NexusRouter(contractRegistry());
    const decision = router.resolve({
      schemaVersion: 1,
      explicit: { providerId: 'openai', modelId: 'gpt-code' },
    });
    const call = { id: 'c1', toolId: 'filesystem.write', arguments: { path: 'a.txt' } };
    const broker = new ExecutionBroker([
      new FakeAdapter('openai', 'gpt-code', [{ type: 'tool_call', call }]),
    ]);
    const events = [];
    for await (const event of broker.execute({ decision, prompt: 'write' })) events.push(event);
    expect(events.filter((event) => event.type === 'tool_call')).toEqual([
      { type: 'tool_call', call, providerId: 'openai', modelId: 'gpt-code' },
    ]);
  });
});
