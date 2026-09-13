import type { z } from 'zod';
import { CapabilityToken } from './capability.js';
import { CommandAcceptance, CommandEnvelope } from './command.js';
import { EventEnvelope } from './event.js';
import { JobClaimRequest, JobEnvelope } from './job.js';
import { ModuleManifest } from './module-manifest.js';
import { BlobRef } from './primitives.js';
import { ProjectAggregate } from './project.js';
import { ProvenanceRecord } from './provenance.js';

/**
 * The published contract surface, keyed by the name used for the emitted JSON
 * Schema file. Anything in here is a compatibility commitment; anything not in
 * here is an implementation detail that may change freely.
 *
 * Key insertion order is the emission order, which keeps `schema/index.json`
 * stable and its diffs readable.
 */
export const CONTRACT_CATALOG = {
  BlobRef,
  CapabilityToken,
  Command: CommandEnvelope,
  CommandAcceptance,
  Event: EventEnvelope,
  Job: JobEnvelope,
  JobClaimRequest,
  ModuleManifest,
  Project: ProjectAggregate,
  ProvenanceRecord,
} as const satisfies Record<string, z.ZodType>;

export type ContractName = keyof typeof CONTRACT_CATALOG;

export const CONTRACT_NAMES = Object.keys(CONTRACT_CATALOG) as ContractName[];
