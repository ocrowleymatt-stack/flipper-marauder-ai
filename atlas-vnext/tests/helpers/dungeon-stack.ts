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
  const conversations = new Map<
    string,
    {
      conversation: {
        id: string;
        urn: string;
        title: string;
        projectId: string | null;
        createdAt: string;
        updatedAt: string;
      };
      messages: Array<{
        id: string;
        urn: string;
        conversationId: string;
        role: 'user' | 'assistant' | 'system';
        content: string;
        sequence: number;
        executionId: string | null;
        createdAt: string;
        updatedAt: string;
      }>;
    }
  >();
  return {
    async createConversation(input: { title?: string; projectId?: string | null } = {}) {
      const id = `con_${Math.random().toString(16).slice(2)}`;
      const now = new Date().toISOString();
      const conversation = {
        id,
        urn: `urn:atlas:conversation:${id}`,
        title: input.title ?? 'stub',
        projectId: input.projectId ?? null,
        createdAt: now,
        updatedAt: now,
      };
      conversations.set(id, { conversation, messages: [] });
      return conversation;
    },
    async getSnapshot(conversationId: string) {
      const row = conversations.get(conversationId);
      if (!row) return null;
      return { conversation: row.conversation, messages: row.messages, executions: [] };
    },
    async postNotice(conversationId: string, content: string, scope?: { tenantId?: string; workspaceId?: string | null }) {
      const row = conversations.get(conversationId);
      if (!row) return null;
      if (scope?.workspaceId && row.conversation.projectId !== scope.workspaceId) return null;
      const now = new Date().toISOString();
      const message = {
        id: `msg_${Math.random().toString(16).slice(2)}`,
        urn: 'urn:atlas:message:stub',
        conversationId: row.conversation.id,
        role: 'assistant' as const,
        content,
        sequence: row.messages.length + 1,
        executionId: null,
        createdAt: now,
        updatedAt: now,
      };
      row.messages.push(message);
      return message;
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
