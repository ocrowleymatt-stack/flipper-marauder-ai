import { z } from 'zod';
import {
  ActorRef,
  Identifier,
  IsoTimestamp,
  Metadata,
  NonEmptyString,
  Uuid,
} from './primitives.js';
import { ContractVersion } from './version.js';

/**
 * Actions are coarse and closed on purpose: a capability system whose action
 * vocabulary grows per feature cannot be reasoned about. `*` is only ever
 * legitimate on a root token and must be attenuated before it leaves the mint.
 */
export const CAPABILITY_ACTIONS = ['read', 'write', 'execute', 'admin', '*'] as const;

export const CapabilityAction = z.enum(CAPABILITY_ACTIONS);

export const CapabilityScope = z
  .strictObject({
    resource: z
      .string()
      .min(1)
      .max(256)
      .describe('Resource selector, e.g. `project`, `job`, `module:device.transport`, or `*`.'),
    actions: z.array(CapabilityAction).min(1),
    constraints: Metadata.optional().describe(
      'Additional narrowing predicates, e.g. `{ projectId: "..." }`. Attenuation may add but never remove constraints.',
    ),
  })
  .describe('One grant: what may be done to what, under which constraints.');

export const CAPABILITY_PROOF_ALGS = ['hs256', 'ed25519'] as const;

export const CapabilityProofAlg = z.enum(CAPABILITY_PROOF_ALGS);

export const CapabilityProof = z
  .strictObject({
    alg: CapabilityProofAlg,
    keyId: Identifier.describe('Identifies the key so tokens survive key rotation.'),
    value: NonEmptyString.describe('base64url signature over the canonical token body.'),
  })
  .describe('Cryptographic proof that the token body was minted by a trusted authority.');

export const CapabilityToken = z
  .strictObject({
    id: Uuid,
    contractVersion: ContractVersion,
    subject: ActorRef.describe('The bearer this token was minted for.'),
    audience: Identifier.describe('The component permitted to accept this token.'),
    scopes: z.array(CapabilityScope).min(1),
    issuedAt: IsoTimestamp,
    notBefore: IsoTimestamp.optional(),
    expiresAt: IsoTimestamp,
    parentId: Uuid.optional().describe('Set when this token was produced by attenuating another.'),
    proof: CapabilityProof,
  })
  .describe('A bearer capability. Possession is authority; there is no ambient permission table.');

export const CapabilityTokenRef = z
  .strictObject({
    tokenId: Uuid,
    fingerprint: NonEmptyString.describe(
      'sha256 of the canonical token body, so a reference cannot be silently swapped.',
    ),
  })
  .describe('A pointer to a capability token, carried by commands instead of the token itself.');

/** A single requirement that a token must satisfy. */
export const CapabilityRequirement = z.strictObject({
  resource: NonEmptyString.max(256),
  action: CapabilityAction.exclude(['*']),
});

export type CapabilityAction = z.infer<typeof CapabilityAction>;
export type CapabilityScope = z.infer<typeof CapabilityScope>;
export type CapabilityProofAlg = z.infer<typeof CapabilityProofAlg>;
export type CapabilityProof = z.infer<typeof CapabilityProof>;
export type CapabilityToken = z.infer<typeof CapabilityToken>;
export type CapabilityTokenRef = z.infer<typeof CapabilityTokenRef>;
export type CapabilityRequirement = z.infer<typeof CapabilityRequirement>;
