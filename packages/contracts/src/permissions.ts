import { z } from 'zod';

/**
 * Closed list of platform permission scopes.
 * Evaluation belongs only in platform/permissions.
 */
export const permissionScopeSchema = z.enum([
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
]);
export type PermissionScope = z.infer<typeof permissionScopeSchema>;

export const PERMISSION_SCOPES = permissionScopeSchema.options;

export const permissionDecisionSchema = z.enum(['allow', 'ask', 'deny']);
export type PermissionDecision = z.infer<typeof permissionDecisionSchema>;

export const permissionGrantExtentSchema = z.enum(['global', 'project', 'session']);
export type PermissionGrantExtent = z.infer<typeof permissionGrantExtentSchema>;

export const permissionGrantSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  subjectId: z.string().min(1),
  scope: permissionScopeSchema,
  decision: z.enum(['allow', 'deny']),
  extent: permissionGrantExtentSchema,
  projectId: z.string().optional(),
  sessionId: z.string().optional(),
  createdAt: z.string().datetime(),
});
export type PermissionGrant = z.infer<typeof permissionGrantSchema>;

/** Unknown scopes fail safe to ask. */
export const unknownScopeDecision: PermissionDecision = 'ask';

export const defaultPermissionPolicy: Record<PermissionScope, PermissionDecision> = {
  'filesystem.read': 'allow',
  'filesystem.write': 'ask',
  'network.public': 'ask',
  'network.private': 'deny',
  'browser.control': 'ask',
  'shell.execute': 'ask',
  'repo.read': 'allow',
  'repo.write': 'ask',
  'deployment.promote': 'ask',
  'secrets.use': 'ask',
  'device.control': 'ask',
};
