import { z } from 'zod';
import { IsoTimestamp, NonEmptyString, SchemaVersion } from './common.js';

export const CAPABILITY_SCOPES = [
  'filesystem.read',
  'filesystem.write',
  'network.public',
  'network.private',
  'browser.control',
  'shell.execute',
  'repo.read',
  'repo.write',
  'deployment.promote',
  'secrets.use',
  'device.control',
] as const;

export const CapabilityScope = z.enum(CAPABILITY_SCOPES);
export type CapabilityScope = z.infer<typeof CapabilityScope>;

/**
 * Narrows one scope to a set of resource patterns. The pattern syntax is owned by
 * `@atlas/platform-permissions` (paths, hosts, repo slugs, secret names, device ids);
 * contracts only guarantee non-empty strings.
 */
export const ResourceConstraint = z.object({
  scope: CapabilityScope,
  resources: z.array(NonEmptyString).min(1),
});
export type ResourceConstraint = z.infer<typeof ResourceConstraint>;

export const GrantSubject = z.object({
  kind: z.enum(['user', 'session', 'job', 'dungeon', 'service']),
  id: NonEmptyString,
});
export type GrantSubject = z.infer<typeof GrantSubject>;

export const Grant = z
  .object({
    schemaVersion: SchemaVersion,
    subject: GrantSubject,
    scopes: z.array(CapabilityScope).min(1),
    constraints: z.array(ResourceConstraint).optional(),
    issuedAt: IsoTimestamp,
    expiresAt: IsoTimestamp.optional(),
    reason: z.string().optional(),
  })
  .superRefine((grant, ctx) => {
    const granted = new Set<CapabilityScope>(grant.scopes);
    for (const [index, constraint] of (grant.constraints ?? []).entries()) {
      if (!granted.has(constraint.scope)) {
        ctx.addIssue({
          code: 'custom',
          path: ['constraints', index, 'scope'],
          message: `constraint targets scope "${constraint.scope}" which is not granted`,
        });
      }
    }
    if (grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= Date.parse(grant.issuedAt)) {
      ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'expiresAt must be after issuedAt' });
    }
  });
export type Grant = z.infer<typeof Grant>;
