import { z } from 'zod';

/**
 * Slow Cook schedule contracts.
 *
 * Spare-compute work yields to interactive jobs. Jobs are synthetic/internal
 * (extraction/index style) with no uncertain side effects. This is a bounded
 * scheduler, not an autonomous agent.
 */

export const jobScheduleClassSchema = z.enum(['INTERACTIVE', 'BACKGROUND', 'SLOW_COOK']);
export type JobScheduleClass = z.infer<typeof jobScheduleClassSchema>;

export const SCHEDULE_CLASS_PRIORITY: Record<JobScheduleClass, number> = {
  INTERACTIVE: 100,
  BACKGROUND: 50,
  SLOW_COOK: 10,
};

export const slowCookAcceptanceSchema = z.object({
  metric: z.string().min(1),
  minImprovement: z.number(),
  maxPasses: z.number().int().positive(),
});
export type SlowCookAcceptance = z.infer<typeof slowCookAcceptanceSchema>;

export const slowCookResourcePolicySchema = z.object({
  class: jobScheduleClassSchema,
  deadlineAt: z.string().nullable(),
  maxTokens: z.number().int().positive().nullable(),
  maxCostClass: z.enum(['free', 'low', 'medium', 'high']).nullable(),
});
export type SlowCookResourcePolicy = z.infer<typeof slowCookResourcePolicySchema>;

export const slowCookJobSpecSchema = z.object({
  objective: z.string().min(1),
  boundedInputs: z.record(z.string(), z.unknown()),
  checkpoint: z.record(z.string(), z.unknown()),
  acceptance: slowCookAcceptanceSchema,
  resourcePolicy: slowCookResourcePolicySchema,
  resultRef: z.string().nullable(),
});
export type SlowCookJobSpec = z.infer<typeof slowCookJobSpecSchema>;

export const slowCookPassSchema = z.object({
  metric: z.number(),
  improved: z.boolean(),
});
export type SlowCookPass = z.infer<typeof slowCookPassSchema>;

export const diminishingReturnsDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('continue') }),
  z.object({ decision: z.literal('stop'), reason: z.string().min(1) }),
]);
export type DiminishingReturnsDecision = z.infer<typeof diminishingReturnsDecisionSchema>;
