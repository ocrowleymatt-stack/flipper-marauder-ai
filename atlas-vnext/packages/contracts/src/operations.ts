import { z } from 'zod';
import { authorityCapabilitySchema } from './capabilities.ts';

/**
 * Shared operational substrate for Help, System Doctor, Maintenance, and Self-Repair.
 * Deterministic software performs checks and repair plans. AI may only appear as a typed
 * diagnose note — never as the actor that applies repairs.
 */

export const OPERATIONAL_STATES = [
  'HEALTHY',
  'DEGRADED',
  'REPAIRING',
  'VERIFICATION',
  'ATTENTION_REQUIRED',
  'CRITICAL',
] as const;

export const operationalStateSchema = z.enum(OPERATIONAL_STATES);
export type OperationalState = z.infer<typeof operationalStateSchema>;

export const CHECK_IDS = [
  'postgres',
  'migrations',
  'cas',
  'jobs',
  'stuck_jobs',
  'disk',
  'retrieval',
  'backup',
  'providers',
  'architecture',
] as const;

export const checkIdSchema = z.enum(CHECK_IDS);
export type CheckId = z.infer<typeof checkIdSchema>;

export const healthCheckStateSchema = z.enum(['ok', 'warn', 'error', 'not_configured']);
export type HealthCheckState = z.infer<typeof healthCheckStateSchema>;

export const healthCheckResultSchema = z.object({
  id: checkIdSchema,
  state: healthCheckStateSchema,
  summary: z.string().min(1),
  evidence: z.record(z.string(), z.unknown()),
});
export type HealthCheckResult = z.infer<typeof healthCheckResultSchema>;

export const diagnoseNoteKindSchema = z.enum(['deterministic', 'ai']);
export type DiagnoseNoteKind = z.infer<typeof diagnoseNoteKindSchema>;

/** AI may only be represented here. It never performs checks or repairs. */
export const diagnoseNoteSchema = z.object({
  kind: diagnoseNoteKindSchema,
  summary: z.string().min(1),
  checkId: checkIdSchema.optional(),
});
export type DiagnoseNote = z.infer<typeof diagnoseNoteSchema>;

export const repairClassSchema = z.enum(['harmless_reversible', 'consequential']);
export type RepairClass = z.infer<typeof repairClassSchema>;

export const repairProposalSchema = z.object({
  id: z.string().min(1),
  checkId: checkIdSchema,
  repairClass: repairClassSchema,
  title: z.string().min(1),
  /** Human descriptions of the plan. Never shell commands. */
  steps: z.array(z.string().min(1)).min(1),
  requiresCapability: authorityCapabilitySchema,
  rollback: z.string().min(1).nullable(),
});
export type RepairProposal = z.infer<typeof repairProposalSchema>;

export const doctorReportSchema = z.object({
  state: operationalStateSchema,
  checks: z.array(healthCheckResultSchema),
  proposals: z.array(repairProposalSchema),
  notes: z.array(diagnoseNoteSchema).default([]),
});
export type DoctorReport = z.infer<typeof doctorReportSchema>;

export const repairExecutionStatusSchema = z.enum([
  'proposed',
  'denied',
  'applied',
  'verified',
  'rolled_back',
]);
export type RepairExecutionStatus = z.infer<typeof repairExecutionStatusSchema>;

export const repairAuthorityDecisionSchema = z.enum(['ALLOW', 'DENY']);
export type RepairAuthorityDecision = z.infer<typeof repairAuthorityDecisionSchema>;

export const repairExecutionSchema = z.object({
  proposalId: z.string().min(1),
  status: repairExecutionStatusSchema,
  authorityDecision: repairAuthorityDecisionSchema,
});
export type RepairExecution = z.infer<typeof repairExecutionSchema>;
