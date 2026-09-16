import { randomUUID } from 'node:crypto';
import type { DungeonId } from '@atlas-vnext/contracts';
import { assertActor, sameWorkspace, type PersistenceActor } from '../actor.ts';
import { ConflictError, OwnershipError } from '../errors.ts';
import type {
  DungeonRecordRow,
  DungeonRecordStore,
  PrivacyAuditRow,
  PrivacyPolicyRow,
  PrivacyProposalRow,
  PrivacyStore,
} from '../dungeon-types.ts';

export function createMemoryDungeonStores(clock: () => string): {
  dungeonRecords: DungeonRecordStore;
  privacy: PrivacyStore;
} {
  const records = new Map<string, DungeonRecordRow>();
  const policies = new Map<string, PrivacyPolicyRow>();
  const audit: PrivacyAuditRow[] = [];
  const proposals = new Map<string, PrivacyProposalRow>();

  const dungeonRecords: DungeonRecordStore = {
    async create(actor, input) {
      const scoped = assertActor(actor, 'create dungeon record');
      if (input.workspaceId && !sameWorkspace(scoped, input.workspaceId)) {
        throw new OwnershipError('Fail-closed: workspace is not visible.');
      }
      const now = clock();
      const id = input.id ?? `drec_${randomUUID()}`;
      const row: DungeonRecordRow = {
        id,
        urn: `urn:atlas:${input.dungeon}:${id}`,
        tenantId: scoped.tenantId,
        workspaceId: input.workspaceId ?? null,
        dungeon: input.dungeon,
        kind: input.kind,
        title: input.title,
        status: input.status ?? 'idle',
        payload: input.payload ?? {},
        artefactId: input.artefactId ?? null,
        contentHash: input.contentHash ?? null,
        jobId: input.jobId ?? null,
        conversationId: input.conversationId ?? null,
        parentId: input.parentId ?? null,
        revision: 1,
        failure: null,
        createdBy: scoped.principalId ?? null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      records.set(id, row);
      return row;
    },
    async get(actor, id) {
      const scoped = assertActor(actor, 'read dungeon record');
      const row = records.get(id);
      if (!row || row.tenantId !== scoped.tenantId || row.deletedAt) return null;
      if (row.workspaceId && !sameWorkspace(scoped, row.workspaceId)) return null;
      return row;
    },
    async list(actor, input) {
      const scoped = assertActor(actor, 'list dungeon records');
      if (input.workspaceId && !sameWorkspace(scoped, input.workspaceId)) return [];
      return [...records.values()]
        .filter((item) => {
          if (item.tenantId !== scoped.tenantId || item.deletedAt) return false;
          if (item.dungeon !== input.dungeon) return false;
          if (input.kind && item.kind !== input.kind) return false;
          if (input.workspaceId !== undefined && item.workspaceId !== (input.workspaceId ?? null)) return false;
          if (input.parentId !== undefined && item.parentId !== (input.parentId ?? null)) return false;
          return true;
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async update(actor, id, patch) {
      const current = await requireRecord(actor, id, patch.expectedRevision);
      const now = clock();
      const next: DungeonRecordRow = {
        ...current,
        title: patch.title ?? current.title,
        status: patch.status ?? current.status,
        payload: patch.payload ?? current.payload,
        artefactId: patch.artefactId === undefined ? current.artefactId : patch.artefactId,
        contentHash: patch.contentHash === undefined ? current.contentHash : patch.contentHash,
        jobId: patch.jobId === undefined ? current.jobId : patch.jobId,
        conversationId: patch.conversationId === undefined ? current.conversationId : patch.conversationId,
        failure: patch.failure === undefined ? current.failure : patch.failure,
        revision: current.revision + 1,
        updatedAt: now,
      };
      records.set(id, next);
      return next;
    },
    async logicalDelete(actor, id, expectedRevision) {
      const current = await requireRecord(actor, id, expectedRevision);
      const now = clock();
      const next: DungeonRecordRow = {
        ...current,
        deletedAt: now,
        revision: current.revision + 1,
        updatedAt: now,
      };
      records.set(id, next);
      return next;
    },
  };

  async function requireRecord(actor: PersistenceActor, id: string, expectedRevision?: number): Promise<DungeonRecordRow> {
    const scoped = assertActor(actor, 'mutate dungeon record');
    const row = records.get(id);
    if (!row || row.tenantId !== scoped.tenantId || row.deletedAt) {
      throw new OwnershipError(`Fail-closed: record ${id} is not visible to tenant ${scoped.tenantId}.`);
    }
    if (row.workspaceId && !sameWorkspace(scoped, row.workspaceId)) {
      throw new OwnershipError(`Fail-closed: record ${id} is not visible.`);
    }
    if (expectedRevision != null && row.revision !== expectedRevision) {
      throw new ConflictError(`Record ${id} revision ${expectedRevision} does not match ${row.revision}.`);
    }
    return row;
  }

  const privacy: PrivacyStore = {
    async getPolicy(actor, dungeonId) {
      const scoped = assertActor(actor, 'read privacy policy');
      return policies.get(policyKey(scoped.tenantId, dungeonId)) ?? null;
    },
    async listPolicies(actor) {
      const scoped = assertActor(actor, 'list privacy policies');
      return [...policies.values()].filter((item) => item.tenantId === scoped.tenantId);
    },
    async upsertPolicy(actor, input) {
      const scoped = assertActor(actor, 'write privacy policy');
      const key = policyKey(scoped.tenantId, input.dungeonId);
      const current = policies.get(key);
      if (current && input.expectedRevision != null && current.revision !== input.expectedRevision) {
        throw new ConflictError(`Policy revision ${input.expectedRevision} does not match ${current.revision}.`);
      }
      const now = clock();
      const row: PrivacyPolicyRow = {
        id: current?.id ?? `pol_${randomUUID()}`,
        tenantId: scoped.tenantId,
        dungeonId: input.dungeonId,
        payload: input.payload,
        revision: (current?.revision ?? 0) + 1,
        updatedBy: input.updatedBy,
        updatedAt: now,
      };
      policies.set(key, row);
      return row;
    },
    async appendAudit(actor, row) {
      const scoped = assertActor(actor, 'append privacy audit');
      const entry: PrivacyAuditRow = {
        id: row.id ?? `aud_${randomUUID()}`,
        tenantId: scoped.tenantId,
        actorId: row.actorId,
        action: row.action,
        capability: row.capability,
        resource: row.resource,
        decision: row.decision,
        reasonCode: row.reasonCode,
        before: row.before,
        after: row.after,
        stepUp: row.stepUp,
        at: row.at ?? clock(),
      };
      audit.push(entry);
      return entry;
    },
    async listAudit(actor, limit = 100) {
      const scoped = assertActor(actor, 'list privacy audit');
      return audit.filter((item) => item.tenantId === scoped.tenantId).slice(-limit).reverse();
    },
    async createProposal(actor, input) {
      const scoped = assertActor(actor, 'create privacy proposal');
      const now = clock();
      const row: PrivacyProposalRow = {
        id: `prop_${randomUUID()}`,
        tenantId: scoped.tenantId,
        proposedBy: input.proposedBy,
        dungeonId: input.dungeonId,
        patch: input.patch,
        status: 'proposed',
        decidedBy: null,
        decidedAt: null,
        createdAt: now,
      };
      proposals.set(row.id, row);
      return row;
    },
    async listProposals(actor) {
      const scoped = assertActor(actor, 'list privacy proposals');
      return [...proposals.values()]
        .filter((item) => item.tenantId === scoped.tenantId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async decideProposal(actor, id, input) {
      const scoped = assertActor(actor, 'decide privacy proposal');
      const current = proposals.get(id);
      if (!current || current.tenantId !== scoped.tenantId) {
        throw new OwnershipError(`Fail-closed: proposal ${id} is not visible.`);
      }
      if (current.status !== 'proposed') {
        throw new ConflictError(`Proposal ${id} is already ${current.status}.`);
      }
      const next: PrivacyProposalRow = {
        ...current,
        status: input.status,
        decidedBy: input.decidedBy,
        decidedAt: clock(),
      };
      proposals.set(id, next);
      return next;
    },
  };

  return { dungeonRecords, privacy };
}

function policyKey(tenantId: string, dungeonId: DungeonId | null): string {
  return `${tenantId}::${dungeonId ?? '*'}`;
}
