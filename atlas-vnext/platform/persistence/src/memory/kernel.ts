import { randomUUID } from 'node:crypto';
import {
  DEFAULT_BEHAVIOUR_MODE,
  behaviourModeSchema,
  type BehaviourMode,
  type Conversation,
  type ExecutionRecord,
  type Message,
  type ProvenanceRecord,
  type TenantBehaviourRecord,
} from '@atlas-vnext/contracts';
import { UuidIdFactory, type ConversationRepository, type ExecutionRepository, type MessageRepository, type ProvenanceWriter } from '@atlas-vnext/conversation';
import { MemoryEventBus, type EventBus } from '@atlas-vnext/events';
import { createJobEngine, MemoryJobStore, type DurableJobEngine } from '@atlas-vnext/jobs';
import { TenantIsolationError } from '@atlas-vnext/permissions';
import { logPlatform } from '@atlas-vnext/observability';
import { assertActor, sameWorkspace, type PersistenceActor } from '../actor.ts';
import { OwnershipError, PersistenceClosedError } from '../errors.ts';
import type {
  ActorBoundPersistence,
  ArtefactMetadata,
  ArtefactMetadataStore,
  DurableBehaviourStore,
  PlatformPersistence,
  PrincipalRecord,
  RestartRecoveryResult,
  RuntimeLeaseRecord,
  RuntimeLeaseStore,
  TenantRecord,
  WorkspaceRecord,
  WorkspaceStore,
} from '../kernel.ts';

const ids = new UuidIdFactory();

class AsyncMutex {
  private chain: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export class MemoryPersistence implements PlatformPersistence {
  readonly mode = 'memory' as const;
  readonly runtimeLeases: RuntimeLeaseStore;
  readonly artefacts: ArtefactMetadataStore;
  private closed = false;
  private readonly mutex = new AsyncMutex();
  private readonly tenants = new Map<string, TenantRecord>();
  private readonly principals = new Map<string, PrincipalRecord>();
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly conversations = new Map<string, Conversation>();
  private readonly messages = new Map<string, Message[]>();
  private readonly executions = new Map<string, ExecutionRecord>();
  private readonly provenance: ProvenanceRecord[] = [];
  private readonly behaviour = new Map<string, TenantBehaviourRecord>();
  private readonly leases = new Map<string, RuntimeLeaseRecord>();
  private readonly artefactRows = new Map<string, ArtefactMetadata>();
  private readonly events = new MemoryEventBus();
  private readonly jobStore = new MemoryJobStore();
  private readonly jobs: DurableJobEngine;

  constructor(private readonly clock: () => string = () => new Date().toISOString()) {
    this.jobs = createJobEngine({
      store: this.jobStore,
      clock: this.clock,
      unitOfWork: this,
      log: (event, fields) => logPlatform(event, fields),
      events: {
        publish: async (input) => {
          await this.events.publish(input);
        },
      },
    });
    this.runtimeLeases = this.createLeaseStore();
    this.artefacts = this.createArtefactStore();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.assertOpen();
    return this.mutex.run(fn);
  }

  forActor(actor: PersistenceActor): ActorBoundPersistence {
    const scoped = assertActor(actor, 'bind persistence');
    this.assertOpen();
    return {
      actor: scoped,
      conversations: this.conversationRepo(scoped),
      messages: this.messageRepo(scoped),
      executions: this.executionRepo(scoped),
      provenance: this.provenanceWriter(scoped),
      events: this.boundEvents(scoped),
      jobs: this.jobs,
      behaviour: this.behaviourStore(),
      workspaces: this.workspaceStore(),
    };
  }

  async ensureTenant(input: { id: string; name: string }): Promise<TenantRecord> {
    this.assertOpen();
    const existing = this.tenants.get(input.id);
    if (existing) return existing;
    const now = this.clock();
    const record: TenantRecord = {
      id: input.id,
      urn: `urn:atlas:tenant:${input.id}`,
      name: input.name,
      createdAt: now,
      updatedAt: now,
    };
    this.tenants.set(input.id, record);
    return record;
  }

  async ensurePrincipal(input: { id: string; displayName?: string | null }): Promise<PrincipalRecord> {
    this.assertOpen();
    const existing = this.principals.get(input.id);
    if (existing) return existing;
    const now = this.clock();
    const record: PrincipalRecord = {
      id: input.id,
      urn: `urn:atlas:principal:${input.id}`,
      displayName: input.displayName ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.principals.set(input.id, record);
    return record;
  }

  async ensureWorkspace(
    actor: PersistenceActor,
    input: { id?: string; name: string; dungeon?: string },
  ): Promise<WorkspaceRecord> {
    return this.workspaceStore().create(actor, input);
  }

  async recoverOnStart(reason = 'Process restarted before the execution finished.'): Promise<RestartRecoveryResult> {
    this.assertOpen();
    logPlatform('restart.reconcile', { mode: this.mode });
    const executions: ExecutionRecord[] = [];
    const now = this.clock();
    for (const execution of this.executions.values()) {
      if (execution.status !== 'queued' && execution.status !== 'running') continue;
      const failed: ExecutionRecord = {
        ...execution,
        status: 'failed',
        failureReason: { code: 'interrupted', message: reason, retryable: true, at: now },
        updatedAt: now,
        completedAt: now,
      };
      this.executions.set(failed.id, failed);
      await this.events.publish({
        channel: `conversation:${failed.conversationId}`,
        type: 'execution.failed',
        payload: { executionId: failed.id, code: 'interrupted' },
        tenantId: failed.tenantId,
        conversationId: failed.conversationId,
      });
      executions.push(failed);
    }
    const jobs = await this.jobs.recoverExpiredLeases(now);
    return { executions, jobs };
  }

  async applyEventRetention(maxEntries?: number): Promise<number> {
    this.assertOpen();
    return this.events.applyRetention(maxEntries);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new PersistenceClosedError();
  }

  private conversationRepo(actor: PersistenceActor): ConversationRepository {
    return {
      create: async (input) => {
        await this.ensureTenant({ id: actor.tenantId, name: actor.tenantId });
        const workspaceId = input.projectId ?? actor.workspaceId ?? null;
        if (workspaceId && !this.ownedWorkspace(actor, workspaceId)) {
          throw new OwnershipError(`Fail-closed: workspace ${workspaceId} is not visible to tenant ${actor.tenantId}.`);
        }
        const id = ids.id('conversation');
        const timestamp = this.clock();
        const conversation: Conversation = {
          id,
          urn: ids.urn('conversation', id),
          title: input.title,
          projectId: workspaceId,
          tenantId: actor.tenantId,
          workspaceId,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        this.conversations.set(id, conversation);
        this.messages.set(id, []);
        return conversation;
      },
      get: async (id) => {
        this.assertOpen();
        const conversation = this.conversations.get(id);
        if (!conversation || conversation.tenantId !== actor.tenantId) return null;
        if (!sameWorkspace(actor, conversation.workspaceId)) return null;
        return conversation;
      },
      list: async () => {
        this.assertOpen();
        return [...this.conversations.values()]
          .filter((item) => item.tenantId === actor.tenantId)
          .filter((item) => sameWorkspace(actor, item.workspaceId))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      },
      save: async (conversation) => {
        const existing = this.conversations.get(conversation.id);
        if (!existing || existing.tenantId !== actor.tenantId || !sameWorkspace(actor, existing.workspaceId)) {
          logPlatform('ownership.rejected', { action: 'save conversation', tenantId: actor.tenantId, conversationId: conversation.id });
          throw new OwnershipError(`Fail-closed: conversation ${conversation.id} is not visible to this tenant.`);
        }
        this.conversations.set(conversation.id, { ...conversation, tenantId: actor.tenantId });
        return this.conversations.get(conversation.id)!;
      },
    };
  }

  private messageRepo(actor: PersistenceActor): MessageRepository {
    const conversations = this.conversationRepo(actor);
    return {
      append: async (input) => {
        const conversation = await conversations.get(input.conversationId);
        if (!conversation) throw new OwnershipError(`Fail-closed: conversation ${input.conversationId} is not visible to this tenant.`);
        const existing = this.messages.get(input.conversationId) ?? [];
        const sequence = existing.length === 0 ? 0 : Math.max(...existing.map((item) => item.sequence)) + 1;
        const id = ids.id('message');
        const timestamp = this.clock();
        const message: Message = {
          id,
          urn: ids.urn('message', id),
          conversationId: input.conversationId,
          role: input.role,
          content: input.content,
          sequence,
          executionId: input.executionId,
          tenantId: actor.tenantId,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        existing.push(message);
        this.messages.set(input.conversationId, existing);
        return message;
      },
      list: async (conversationId) => {
        const conversation = await conversations.get(conversationId);
        if (!conversation) return [];
        return [...(this.messages.get(conversationId) ?? [])].sort((a, b) => a.sequence - b.sequence);
      },
      save: async (message) => {
        const conversation = await conversations.get(message.conversationId);
        if (!conversation) throw new OwnershipError(`Fail-closed: conversation ${message.conversationId} is not visible to this tenant.`);
        const existing = this.messages.get(message.conversationId) ?? [];
        const index = existing.findIndex((item) => item.id === message.id);
        if (index === -1) existing.push(message);
        else existing[index] = message;
        this.messages.set(message.conversationId, existing);
        return message;
      },
    };
  }

  private executionRepo(actor: PersistenceActor): ExecutionRepository {
    const conversations = this.conversationRepo(actor);
    return {
      create: async (record) => {
        const conversation = await conversations.get(record.conversationId);
        if (!conversation) throw new OwnershipError(`Fail-closed: conversation ${record.conversationId} is not visible to this tenant.`);
        const stored = { ...record, tenantId: actor.tenantId };
        this.executions.set(stored.id, stored);
        return stored;
      },
      get: async (id) => {
        const record = this.executions.get(id);
        if (!record || record.tenantId !== actor.tenantId) return null;
        const conversation = await conversations.get(record.conversationId);
        return conversation ? record : null;
      },
      listByConversation: async (conversationId) => {
        const conversation = await conversations.get(conversationId);
        if (!conversation) return [];
        return [...this.executions.values()]
          .filter((item) => item.conversationId === conversationId && item.tenantId === actor.tenantId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      },
      save: async (record) => {
        const conversation = await conversations.get(record.conversationId);
        if (!conversation) throw new OwnershipError(`Fail-closed: conversation ${record.conversationId} is not visible to this tenant.`);
        const stored = { ...record, tenantId: actor.tenantId };
        this.executions.set(stored.id, stored);
        return stored;
      },
      listInFlight: async () =>
        [...this.executions.values()].filter((item) => {
          if (item.tenantId !== actor.tenantId) return false;
          if (item.status !== 'queued' && item.status !== 'running') return false;
          const conversation = this.conversations.get(item.conversationId);
          return Boolean(conversation && sameWorkspace(actor, conversation.workspaceId));
        }),
    };
  }

  private provenanceWriter(actor: PersistenceActor): ProvenanceWriter {
    return {
      record: async (entry) => {
        this.provenance.push({ ...entry });
      },
      forJob: async (jobId) => this.provenance.filter((entry) => entry.jobId === jobId),
    };
  }

  private boundEvents(actor: PersistenceActor): EventBus {
    const inner = this.events;
    return {
      publish: (event) => inner.publish({ ...event, tenantId: event.tenantId ?? actor.tenantId, workspaceId: event.workspaceId ?? actor.workspaceId }),
      subscribe: (channel, listener) => inner.subscribe(channel, listener),
      history: (channel) => inner.replay(channel),
      replay: async (channel, after) => {
        const records = await inner.replay(channel, after);
        return records.filter((event) => !event.tenantId || event.tenantId === actor.tenantId);
      },
    };
  }

  private behaviourStore(): DurableBehaviourStore {
    return {
      resolve: async (actorTenantId, subjectTenantId = actorTenantId) => {
        this.assertBehaviour(actorTenantId, subjectTenantId, 'resolve');
        return this.behaviour.get(subjectTenantId)?.behaviour ?? DEFAULT_BEHAVIOUR_MODE;
      },
      read: async (actorTenantId, subjectTenantId) => {
        this.assertBehaviour(actorTenantId, subjectTenantId, 'read');
        return this.behaviour.get(subjectTenantId) ?? null;
      },
      write: async (actorTenantId, subjectTenantId, behaviour: BehaviourMode) => {
        this.assertBehaviour(actorTenantId, subjectTenantId, 'write');
        const record: TenantBehaviourRecord = {
          tenantId: subjectTenantId,
          behaviour: behaviourModeSchema.parse(behaviour),
          updatedAt: this.clock(),
          updatedByTenantId: actorTenantId,
        };
        this.behaviour.set(subjectTenantId, record);
        return record;
      },
    };
  }

  private workspaceStore(): WorkspaceStore {
    return {
      create: async (actor, input) => {
        const scoped = assertActor(actor, 'create workspace');
        await this.ensureTenant({ id: scoped.tenantId, name: scoped.tenantId });
        const now = this.clock();
        const id = input.id ?? `wks_${randomUUID()}`;
        const record: WorkspaceRecord = {
          id,
          urn: `urn:atlas:workspace:${id}`,
          tenantId: scoped.tenantId,
          name: input.name,
          dungeon: input.dungeon ?? null,
          rootManifestHash: null,
          archived: false,
          createdAt: now,
          updatedAt: now,
        };
        this.workspaces.set(id, record);
        return record;
      },
      get: async (actor, id) => {
        const scoped = assertActor(actor, 'read workspace');
        const record = this.workspaces.get(id);
        if (!record || record.tenantId !== scoped.tenantId) return null;
        if (scoped.workspaceId && scoped.workspaceId !== id) return null;
        return record;
      },
      list: async (actor) => {
        const scoped = assertActor(actor, 'list workspaces');
        return [...this.workspaces.values()]
          .filter((item) => item.tenantId === scoped.tenantId)
          .filter((item) => !scoped.workspaceId || item.id === scoped.workspaceId);
      },
      bindManifest: async (actor, id, manifestHash) => {
        const scoped = assertActor(actor, 'bind workspace manifest');
        const record = this.workspaces.get(id);
        if (!record || record.tenantId !== scoped.tenantId) {
          throw new OwnershipError(`Fail-closed: workspace ${id} is not visible to tenant ${scoped.tenantId}.`);
        }
        const next = { ...record, rootManifestHash: manifestHash, updatedAt: this.clock() };
        this.workspaces.set(id, next);
        return next;
      },
    };
  }

  private createLeaseStore(): RuntimeLeaseStore {
    return {
      upsert: async (actor, input) => {
        const scoped = assertActor(actor, 'upsert runtime lease');
        const key = `${scoped.tenantId}::${input.resourceKey}`;
        const now = this.clock();
        const existing = this.leases.get(key);
        const record: RuntimeLeaseRecord = {
          id: input.id ?? existing?.id ?? `rle_${randomUUID()}`,
          tenantId: scoped.tenantId,
          resourceKey: input.resourceKey,
          owner: input.owner,
          leaseUntil: input.leaseUntil,
          status: input.status,
          metadata: input.metadata ?? {},
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        this.leases.set(key, record);
        return record;
      },
      get: async (actor, resourceKey) => {
        const scoped = assertActor(actor, 'read runtime lease');
        return this.leases.get(`${scoped.tenantId}::${resourceKey}`) ?? null;
      },
      expire: async (nowStamp) => {
        const now = nowStamp ?? this.clock();
        const expired: RuntimeLeaseRecord[] = [];
        for (const [key, lease] of this.leases) {
          if (lease.leaseUntil && lease.leaseUntil <= now && lease.status !== 'expired') {
            const next = { ...lease, status: 'expired', owner: null, updatedAt: now };
            this.leases.set(key, next);
            expired.push(next);
          }
        }
        return expired;
      },
    };
  }

  private createArtefactStore(): ArtefactMetadataStore {
    return {
      record: async (actor, input) => {
        const scoped = assertActor(actor, 'record artefact metadata');
        const record: ArtefactMetadata = {
          id: input.id,
          tenantId: scoped.tenantId,
          workspaceId: input.workspaceId ?? scoped.workspaceId ?? null,
          contentHash: input.contentHash,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          createdAt: input.createdAt ?? this.clock(),
        };
        this.artefactRows.set(record.id, record);
        return record;
      },
      get: async (actor, id) => {
        const scoped = assertActor(actor, 'read artefact metadata');
        const record = this.artefactRows.get(id);
        if (!record || record.tenantId !== scoped.tenantId) return null;
        return record;
      },
    };
  }

  private ownedWorkspace(actor: PersistenceActor, workspaceId: string): boolean {
    const workspace = this.workspaces.get(workspaceId);
    return Boolean(workspace && workspace.tenantId === actor.tenantId);
  }

  private assertBehaviour(actorTenantId: string, subjectTenantId: string, action: string): void {
    if (!actorTenantId.trim()) {
      throw new TenantIsolationError(`Fail-closed: cannot ${action} Behaviour without a tenant id.`);
    }
    if (!subjectTenantId.trim() || actorTenantId !== subjectTenantId) {
      logPlatform('ownership.rejected', { action: `behaviour.${action}`, actorTenantId, subjectTenantId });
      throw new TenantIsolationError(
        `Fail-closed: tenant ${actorTenantId} cannot ${action} Behaviour for tenant ${subjectTenantId}.`,
      );
    }
  }
}

export function openMemoryPersistence(clock?: () => string): MemoryPersistence {
  return new MemoryPersistence(clock);
}
