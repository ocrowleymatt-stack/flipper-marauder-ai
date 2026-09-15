import { z } from 'zod';

/**
 * Authority / permission scopes. Additive: historical Mountain-compat scopes
 * remain, and the production namespace (conversation/project/file/artifact/tool/…)
 * is listed alongside them. Behaviour never grants any of these.
 */
export const CAPABILITY_SCOPES = [
  'conversation.read',
  'conversation.write',
  'project.read',
  'project.write',
  'file.read',
  'file.write',
  'artifact.read',
  'artifact.write',
  'tool.invoke',
  'tool.invoke.readonly',
  'tool.invoke.external_write',
  'filesystem.read',
  'filesystem.write',
  'network.public',
  'network.private',
  'browser.read',
  'browser.submit',
  'browser.control',
  'shell.execute',
  'code.execute',
  'repo.read',
  'repo.write',
  'deployment.promote',
  'publish.external',
  'secrets.use',
  'device.control',
  'compute.allocate',
  'runtime.use_paid',
  'admin.configure',
] as const;

export const capabilityScopeSchema = z.enum(CAPABILITY_SCOPES);
export type CapabilityScope = z.infer<typeof capabilityScopeSchema>;

export const authorityCapabilitySchema = capabilityScopeSchema;
export type AuthorityCapability = CapabilityScope;

export const DANGEROUS_CAPABILITY_SCOPES: readonly CapabilityScope[] = [
  'conversation.write',
  'project.write',
  'file.write',
  'artifact.write',
  'tool.invoke',
  'tool.invoke.external_write',
  'filesystem.write',
  'network.private',
  'browser.submit',
  'browser.control',
  'shell.execute',
  'code.execute',
  'repo.write',
  'deployment.promote',
  'publish.external',
  'secrets.use',
  'device.control',
  'compute.allocate',
  'runtime.use_paid',
  'admin.configure',
];

export const READONLY_TOOL_CAPABILITIES: readonly CapabilityScope[] = [
  'tool.invoke.readonly',
  'conversation.read',
  'project.read',
  'file.read',
  'artifact.read',
  'filesystem.read',
  'browser.read',
  'repo.read',
];
