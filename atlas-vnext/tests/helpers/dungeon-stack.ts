import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversationRuntime } from '@atlas-vnext/conversation';
import { openMemoryPersistence, type PlatformPersistence } from '@atlas-vnext/persistence';
import { ProjectService } from '@atlas-vnext/projects';
import { FilesService } from '@atlas-vnext/files';
import { ContextService } from '@atlas-vnext/context';
import { openFilesystemCas } from '@atlas-vnext/storage';
import { AuthorityEngine, EffectivePolicyEngine } from '@atlas-vnext/permissions';

export function stubRuntime(text = 'Atlas dungeon output.'): ConversationRuntime {
  return {
    async createConversation(input: { title?: string; projectId?: string | null } = {}) {
      return {
        id: `con_${Math.random().toString(16).slice(2)}`,
        urn: 'urn:atlas:conversation:stub',
        title: input.title ?? 'stub',
        projectId: input.projectId ?? null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    },
    async *sendMessage() {
      yield { type: 'execution', execution: { id: 'exe_stub' } };
      yield { type: 'assistant.delta', text };
      yield { type: 'assistant.completed', text };
    },
    async cancel() {
      return undefined;
    },
  } as unknown as ConversationRuntime;
}

export async function openDungeonStack(text?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-dungeon-'));
  const persistence = await openMemoryPersistence();
  await persistence.ensureTenant({ id: 'tenant_a', name: 'A' });
  await persistence.ensurePrincipal({ id: 'principal_a', displayName: 'A' });
  const actor = { tenantId: 'tenant_a', principalId: 'principal_a' };
  const cas = await openFilesystemCas(join(dir, 'cas'));
  const files = new FilesService(persistence, cas);
  const projects = new ProjectService(persistence);
  const context = new ContextService(persistence);
  const authority = new AuthorityEngine();
  authority.grantMembership(actor.principalId, actor.tenantId);
  for (const cap of [
    'artifact.read',
    'artifact.write',
    'project.read',
    'project.write',
    'file.read',
    'file.write',
    'conversation.write',
    'network.public',
    'deployment.promote',
    'privacy.view',
    'privacy.configure',
    'privacy.audit',
  ] as const) {
    authority.grantTo({ principalId: actor.principalId, tenantId: actor.tenantId, capability: cap });
  }
  const policy = new EffectivePolicyEngine(authority);
  const runtime = stubRuntime(text);
  const project = await projects.create(actor, { name: 'Lab' });
  return {
    dir,
    persistence,
    files,
    projects,
    context,
    authority,
    policy,
    runtime,
    actor,
    project,
  };
}

export async function storeTenantPolicy(
  stack: Awaited<ReturnType<typeof openDungeonStack>>,
  patch: Record<string, unknown>,
): Promise<void> {
  await stack.persistence.forActor(stack.actor).privacy.upsertPolicy(stack.actor, {
    dungeonId: null,
    payload: stack.policy.parse(stack.actor.tenantId, null, patch),
    updatedBy: stack.actor.principalId,
  });
}

export async function closePersistence(persistence: PlatformPersistence): Promise<void> {
  await persistence.close();
}
