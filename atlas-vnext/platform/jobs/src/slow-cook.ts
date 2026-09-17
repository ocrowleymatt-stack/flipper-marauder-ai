import {
  SCHEDULE_CLASS_PRIORITY,
  slowCookJobSpecSchema,
  type DiminishingReturnsDecision,
  type JobRecord,
  type SlowCookJobSpec,
  type SlowCookPass,
} from '@atlas-vnext/contracts';
import type { DurableJobEngine, JobActor } from './types.ts';

export const SLOW_COOK_JOB_TYPE = 'slow-cook.job';
export const SLOW_COOK_UTILISATION_CEILING = 0.85;

export interface ComputeDemand {
  interactiveQueued: boolean;
  utilisation: number;
}

/**
 * Scheduler that exploits spare compute and yields to interactive work.
 * Wraps DurableJobEngine; does not fork it. Schedule class lives in the
 * checkpoint plus mapped priority — JobRecord schema is unchanged.
 *
 * Jobs enqueued here are synthetic/internal (extraction/index style) with
 * side-effect class none. This is not an unbounded autonomous agent.
 */
export class SlowCookScheduler {
  constructor(private readonly engine: DurableJobEngine) {}

  async enqueue(actor: JobActor, spec: SlowCookJobSpec & { type?: string }): Promise<JobRecord> {
    const parsed = slowCookJobSpecSchema.parse(spec);
    return this.engine.enqueue(actor, {
      dungeon: 'platform',
      type: spec.type ?? SLOW_COOK_JOB_TYPE,
      priority: SCHEDULE_CLASS_PRIORITY[parsed.resourcePolicy.class],
      checkpoint: asCheckpoint(parsed),
    });
  }

  async claimNext(
    actor: JobActor,
    workerId: string,
    leaseMs: number,
    demand: ComputeDemand,
  ): Promise<JobRecord | null> {
    const skipSlowCook = demand.interactiveQueued || demand.utilisation >= SLOW_COOK_UTILISATION_CEILING;
    return this.engine.claimNext(
      actor,
      workerId,
      leaseMs,
      skipSlowCook ? { minPriority: SCHEDULE_CLASS_PRIORITY.BACKGROUND } : undefined,
    );
  }

  async recordPass(
    actor: JobActor,
    jobId: string,
    pass: { metric: number; improved: boolean },
  ): Promise<JobRecord> {
    const job = await this.engine.get(actor, jobId);
    if (!job) {
      throw new Error(`Fail-closed: slow-cook job ${jobId} is not visible.`);
    }
    const spec = readSpec(job.checkpoint) ?? slowCookJobSpecSchema.parse(job.checkpoint);
    const passes = readPasses(spec);
    passes.push({ metric: pass.metric, improved: pass.improved });
    const next: SlowCookJobSpec = {
      ...spec,
      checkpoint: { ...spec.checkpoint, passes },
    };
    const progress = Math.min(1, passes.length / next.acceptance.maxPasses);
    return this.engine.checkpoint(actor, jobId, `pass:${passes.length}`, progress, asCheckpoint(next));
  }

  shouldStop(spec: SlowCookJobSpec, passes: SlowCookPass[]): DiminishingReturnsDecision {
    if (passes.length >= spec.acceptance.maxPasses) {
      return { decision: 'stop', reason: 'max_passes' };
    }
    const last = passes[passes.length - 1];
    if (last && last.improved === false) {
      return { decision: 'stop', reason: 'min_improvement' };
    }
    if (passes.length >= 2 && last) {
      const previous = passes[passes.length - 2]!;
      const improvement = Math.abs(last.metric - previous.metric);
      if (improvement < spec.acceptance.minImprovement) {
        return { decision: 'stop', reason: 'min_improvement' };
      }
    }
    return { decision: 'continue' };
  }
}

export function readSlowCookSpec(checkpoint: Record<string, unknown>): SlowCookJobSpec {
  return slowCookJobSpecSchema.parse(checkpoint);
}

function readSpec(checkpoint: Record<string, unknown>): SlowCookJobSpec | null {
  const parsed = slowCookJobSpecSchema.safeParse(checkpoint);
  return parsed.success ? parsed.data : null;
}

function readPasses(spec: SlowCookJobSpec): SlowCookPass[] {
  const raw = spec.checkpoint.passes;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as { metric?: unknown; improved?: unknown };
      if (typeof record.metric !== 'number' || typeof record.improved !== 'boolean') return null;
      return { metric: record.metric, improved: record.improved };
    })
    .filter((entry): entry is SlowCookPass => entry !== null);
}

function asCheckpoint(spec: SlowCookJobSpec): Record<string, unknown> {
  return JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
}
