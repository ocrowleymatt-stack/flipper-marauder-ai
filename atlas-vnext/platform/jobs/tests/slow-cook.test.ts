import { describe, expect, it } from 'vitest';
import {
  SCHEDULE_CLASS_PRIORITY,
  type SlowCookJobSpec,
} from '@atlas-vnext/contracts';
import {
  createJobEngine,
  MemoryJobStore,
  SlowCookScheduler,
  SLOW_COOK_JOB_TYPE,
  readSlowCookSpec,
} from '../src/index.ts';

const actor = { tenantId: 'tenant_a' };

function spec(scheduleClass: SlowCookJobSpec['resourcePolicy']['class'], extra?: Partial<SlowCookJobSpec>): SlowCookJobSpec {
  return {
    objective: 'Extract leftover quay notes',
    boundedInputs: { projectId: 'proj_1', fileIds: ['file_a'] },
    checkpoint: { cursor: 0 },
    acceptance: { metric: 'coverage', minImprovement: 0.1, maxPasses: 3 },
    resourcePolicy: {
      class: scheduleClass,
      deadlineAt: null,
      maxTokens: 2_000,
      maxCostClass: 'low',
    },
    resultRef: null,
    ...extra,
  };
}

describe('SlowCookScheduler', () => {
  it('claims an interactive job before a slow-cook job', async () => {
    const engine = createJobEngine({ store: new MemoryJobStore() });
    const scheduler = new SlowCookScheduler(engine);
    const slow = await scheduler.enqueue(actor, spec('SLOW_COOK'));
    const interactive = await scheduler.enqueue(actor, spec('INTERACTIVE'));
    expect(slow.priority).toBe(SCHEDULE_CLASS_PRIORITY.SLOW_COOK);
    expect(interactive.priority).toBe(SCHEDULE_CLASS_PRIORITY.INTERACTIVE);
    expect(slow.type).toBe(SLOW_COOK_JOB_TYPE);
    expect(slow.dungeon).toBe('platform');

    const first = await scheduler.claimNext(actor, 'worker-1', 5_000, {
      interactiveQueued: false,
      utilisation: 0.2,
    });
    expect(first?.id).toBe(interactive.id);
    const second = await scheduler.claimNext(actor, 'worker-1', 5_000, {
      interactiveQueued: false,
      utilisation: 0.2,
    });
    expect(second?.id).toBe(slow.id);
  });

  it('does not claim slow-cook work when interactive jobs are queued', async () => {
    const engine = createJobEngine({ store: new MemoryJobStore() });
    const scheduler = new SlowCookScheduler(engine);
    const slow = await scheduler.enqueue(actor, spec('SLOW_COOK'));
    const claimed = await scheduler.claimNext(actor, 'worker-1', 5_000, {
      interactiveQueued: true,
      utilisation: 0.1,
    });
    expect(claimed).toBeNull();
    const still = await engine.get(actor, slow.id);
    expect(still?.status).toBe('queued');
    expect(still?.leaseOwner).toBeNull();
  });

  it('does not claim slow-cook work when utilisation is at the ceiling', async () => {
    const engine = createJobEngine({ store: new MemoryJobStore() });
    const scheduler = new SlowCookScheduler(engine);
    const background = await scheduler.enqueue(actor, spec('BACKGROUND'));
    const slow = await scheduler.enqueue(actor, spec('SLOW_COOK'));
    const claimed = await scheduler.claimNext(actor, 'worker-1', 5_000, {
      interactiveQueued: false,
      utilisation: 0.85,
    });
    expect(claimed?.id).toBe(background.id);
    const leftover = await scheduler.claimNext(actor, 'worker-2', 5_000, {
      interactiveQueued: false,
      utilisation: 0.85,
    });
    expect(leftover).toBeNull();
    expect((await engine.get(actor, slow.id))?.status).toBe('queued');
  });

  it('stops iteration on diminishing returns and max passes', () => {
    const engine = createJobEngine({ store: new MemoryJobStore() });
    const scheduler = new SlowCookScheduler(engine);
    const jobSpec = spec('SLOW_COOK');
    expect(scheduler.shouldStop(jobSpec, [])).toEqual({ decision: 'continue' });
    expect(scheduler.shouldStop(jobSpec, [{ metric: 0.2, improved: true }])).toEqual({
      decision: 'continue',
    });
    expect(scheduler.shouldStop(jobSpec, [{ metric: 0.2, improved: false }])).toEqual({
      decision: 'stop',
      reason: 'min_improvement',
    });
    expect(
      scheduler.shouldStop(jobSpec, [
        { metric: 0.5, improved: true },
        { metric: 0.52, improved: true },
      ]),
    ).toEqual({ decision: 'stop', reason: 'min_improvement' });
    expect(
      scheduler.shouldStop(jobSpec, [
        { metric: 0.2, improved: true },
        { metric: 0.4, improved: true },
        { metric: 0.6, improved: true },
      ]),
    ).toEqual({ decision: 'stop', reason: 'max_passes' });
    expect(
      scheduler.shouldStop(
        spec('SLOW_COOK', { acceptance: { metric: 'loss', minImprovement: 0.1, maxPasses: 4 } }),
        [
          { metric: 0.5, improved: true },
          { metric: 0.2, improved: true },
        ],
      ),
    ).toEqual({ decision: 'continue' });
  });

  it('claims persisted interactive work after a scheduler restart at the utilisation ceiling', async () => {
    const engine = createJobEngine({ store: new MemoryJobStore() });
    const original = new SlowCookScheduler(engine);
    const interactive = await original.enqueue(actor, spec('INTERACTIVE'));
    const slow = await original.enqueue(actor, spec('SLOW_COOK'));
    const restarted = new SlowCookScheduler(engine);
    const claimed = await restarted.claimNext(actor, 'worker-1', 5_000, {
      interactiveQueued: false,
      utilisation: 0.9,
    });
    expect(claimed?.id).toBe(interactive.id);
    const leftover = await restarted.claimNext(actor, 'worker-2', 5_000, {
      interactiveQueued: false,
      utilisation: 0.9,
    });
    expect(leftover).toBeNull();
    expect((await engine.get(actor, slow.id))?.status).toBe('queued');
  });

  it('persists the job spec through checkpointed passes', async () => {
    const engine = createJobEngine({ store: new MemoryJobStore() });
    const scheduler = new SlowCookScheduler(engine);
    const jobSpec = spec('SLOW_COOK', { boundedInputs: { projectId: 'proj_9', shard: 3 } });
    const enqueued = await scheduler.enqueue(actor, { ...jobSpec, type: 'slow-cook.extract' });
    expect(enqueued.type).toBe('slow-cook.extract');
    const persisted = readSlowCookSpec(enqueued.checkpoint);
    expect(persisted.objective).toBe(jobSpec.objective);
    expect(persisted.boundedInputs).toEqual({ projectId: 'proj_9', shard: 3 });
    expect(persisted.resourcePolicy.class).toBe('SLOW_COOK');

    const claimed = await scheduler.claimNext(actor, 'worker-1', 5_000, {
      interactiveQueued: false,
      utilisation: 0.4,
    });
    expect(claimed?.id).toBe(enqueued.id);
    const afterPass = await scheduler.recordPass(actor, enqueued.id, { metric: 0.4, improved: true });
    const checkpointed = readSlowCookSpec(afterPass.checkpoint);
    expect(checkpointed.objective).toBe(jobSpec.objective);
    expect(checkpointed.boundedInputs).toEqual({ projectId: 'proj_9', shard: 3 });
    expect(checkpointed.acceptance).toEqual(jobSpec.acceptance);
    expect(checkpointed.checkpoint.cursor).toBe(0);
    expect(checkpointed.checkpoint.passes).toEqual([{ metric: 0.4, improved: true }]);
    expect(afterPass.currentStage).toBe('pass:1');
  });
});
