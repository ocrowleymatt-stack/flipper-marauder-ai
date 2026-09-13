import { z } from 'zod';
import {
  ActorRef,
  BlobRef,
  Identifier,
  IsoTimestamp,
  Metadata,
  NonEmptyString,
  Uuid,
} from './primitives.js';
import { Semver, ContractVersion } from './version.js';

export const ATTESTATION_ALGS = ['sha256', 'hs256', 'ed25519'] as const;

export const Attestation = z
  .strictObject({
    alg: z.enum(ATTESTATION_ALGS),
    keyId: Identifier,
    signer: ActorRef,
    signedAt: IsoTimestamp,
    value: NonEmptyString.describe('base64url digest or signature over the canonical record.'),
  })
  .describe('Makes a provenance record independently checkable after the fact.');

export const ProvenanceActivity = z
  .strictObject({
    id: Uuid,
    type: Identifier.describe('What kind of work this was, e.g. `module.step`.'),
    jobId: Uuid,
    stepId: Uuid.optional(),
    moduleId: Identifier,
    moduleVersion: Semver,
    startedAt: IsoTimestamp,
    endedAt: IsoTimestamp,
    parameters: Metadata.optional().describe(
      'The declared, non-secret inputs that are not themselves blobs.',
    ),
  })
  .describe('The activity node of the inputs -> activity -> outputs triple.');

export const ProvenanceRecord = z
  .strictObject({
    id: Uuid,
    contractVersion: ContractVersion,
    projectId: Uuid,
    activity: ProvenanceActivity,
    agent: ActorRef.describe('The actor on whose authority the activity ran.'),
    inputs: z.array(BlobRef),
    outputs: z.array(BlobRef),
    recordedAt: IsoTimestamp,
    attestation: Attestation.nullable(),
  })
  .describe(
    'One edge-set in the provenance graph. Every byte Atlas produces is reachable from one of these.',
  );

export type Attestation = z.infer<typeof Attestation>;
export type ProvenanceActivity = z.infer<typeof ProvenanceActivity>;
export type ProvenanceRecord = z.infer<typeof ProvenanceRecord>;
