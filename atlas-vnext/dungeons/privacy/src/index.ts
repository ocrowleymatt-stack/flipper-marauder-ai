import {
  CONSEQUENTIAL_POLICY_FIELDS,
  defaultEffectivePolicy,
  type DungeonId,
  type DungeonRegistration,
  type EffectivePolicy,
  type ModelPolicyContext,
  type PolicyExplanation,
} from '@atlas-vnext/contracts';
import type { PersistenceActor, PlatformPersistence, PrivacyPolicyRow } from '@atlas-vnext/persistence';
import { AuthorityEngine, EffectivePolicyEngine } from '@atlas-vnext/permissions';

export const dungeonId: DungeonId = 'privacy';

export const privacyDungeon = {
  id: dungeonId,
  title: 'Privacy & Safety',
  description: 'Owner-only effective policy control room. Authority enforces the boundary.',
} as const;

export const PRIVACY_DUNGEON: DungeonRegistration = {
  id: 'privacy',
  slug: 'privacy',
  title: 'Privacy & Safety',
  navLabel: 'Privacy',
  description: 'Owner-only visibility into effective policy, egress, and approval ceilings.',
  surface: 'privacy-safety',
  routes: {
    effective: '/api/privacy/effective',
    explain: '/api/privacy/explain',
    update: '/api/privacy/policy',
    audit: '/api/privacy/audit',
    proposals: '/api/privacy/proposals',
  },
  capabilities: ['privacy.view', 'privacy.configure', 'privacy.audit'],
  permissions: { read: 'privacy.view', write: 'privacy.configure' },
  featureAvailable: true,
  ownerOnly: true,
};

export const GENERIC_DENY = 'Permission denied.';

export class PrivacyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
    this.name = 'PrivacyError';
  }
}

export interface PrivacyActor extends PersistenceActor {
  principalId: string;
  tenantId: string;
  kind?: 'user' | 'guest' | 'system';
}

export class PrivacyService {
  constructor(
    private readonly deps: {
      persistence: PlatformPersistence;
      authority: AuthorityEngine;
      policy: EffectivePolicyEngine;
      ownerPrincipalId: string;
    },
  ) {}

  async effective(actor: PrivacyActor, dungeonId: DungeonId | null = null): Promise<{
    policy: EffectivePolicy;
    modelContext: ModelPolicyContext;
  }> {
    this.assertOwner(actor, 'privacy.view');
    const policy = await this.loadOverlay(actor, dungeonId);
    return { policy, modelContext: this.deps.policy.modelContext(policy) };
  }

  async explain(
    actor: PrivacyActor,
    input: { action: string; capability: string; dungeonId?: DungeonId | null },
  ): Promise<PolicyExplanation> {
    this.assertOwner(actor, 'privacy.view');
    const policy = await this.loadOverlay(actor, input.dungeonId ?? null);
    const decision = this.deps.policy.authorize({
      principal: { principalId: actor.principalId, kind: actor.kind ?? 'user', tenantId: actor.tenantId },
      capability: input.capability,
      dungeonId: input.dungeonId ?? null,
      policy,
      resource: { type: 'policy', tenantId: actor.tenantId },
    });
    return this.deps.policy.explain({
      dungeonId: input.dungeonId ?? null,
      policy,
      action: input.action,
      decision,
    });
  }

  async update(
    actor: PrivacyActor,
    input: {
      dungeonId?: DungeonId | null;
      patch: Record<string, unknown>;
      expectedRevision?: number;
      confirm?: string;
      proposedByModel?: boolean;
    },
  ): Promise<EffectivePolicy> {
    if (input.proposedByModel) {
      throw new PrivacyError('permission_denied', GENERIC_DENY, 404);
    }
    this.assertOwner(actor, 'privacy.configure');
    if (actor.kind === 'system' && actor.principalId !== this.deps.ownerPrincipalId) {
      throw new PrivacyError('permission_denied', GENERIC_DENY, 404);
    }
    const current = await this.loadOverlay(actor, input.dungeonId ?? null);
    const next = this.deps.policy.parse(actor.tenantId, input.dungeonId ?? null, {
      ...current,
      ...input.patch,
    });
    if (this.deps.policy.selfGrantAttempt(input.patch) && actor.principalId !== this.deps.ownerPrincipalId) {
      throw new PrivacyError('permission_denied', GENERIC_DENY, 404);
    }
    const consequential = this.deps.policy.isConsequential(current, next);
    if (consequential && input.confirm !== 'CONFIRM') {
      throw new PrivacyError('step_up_required', 'Consequential policy changes require explicit CONFIRM.', 403);
    }
    const stored = await this.deps.persistence.forActor(actor).privacy.upsertPolicy(actor, {
      dungeonId: input.dungeonId ?? null,
      payload: next,
      expectedRevision: input.expectedRevision,
      updatedBy: actor.principalId,
    });
    await this.deps.persistence.forActor(actor).privacy.appendAudit(actor, {
      actorId: actor.principalId,
      action: 'policy.update',
      capability: 'privacy.configure',
      resource: input.dungeonId ?? 'tenant',
      decision: 'ALLOW',
      reasonCode: consequential ? 'step_up' : 'allow',
      before: current,
      after: next,
      stepUp: consequential,
    });
    return this.deps.policy.parse(actor.tenantId, input.dungeonId ?? null, stored.payload, {
      revision: stored.revision,
      updatedAt: stored.updatedAt,
      updatedBy: stored.updatedBy,
    });
  }

  async propose(actor: PrivacyActor, input: { dungeonId?: DungeonId | null; patch: Record<string, unknown> }) {
    if (!actor.tenantId || !actor.principalId) throw new PrivacyError('permission_denied', GENERIC_DENY, 401);
    return this.deps.persistence.forActor(actor).privacy.createProposal(actor, {
      proposedBy: actor.principalId,
      dungeonId: input.dungeonId ?? null,
      patch: input.patch,
    });
  }

  async decideProposal(actor: PrivacyActor, id: string, status: 'approved' | 'denied') {
    this.assertOwner(actor, 'privacy.configure');
    const decided = await this.deps.persistence.forActor(actor).privacy.decideProposal(actor, id, {
      status,
      decidedBy: actor.principalId,
    });
    if (status === 'approved') {
      await this.update(actor, {
        dungeonId: decided.dungeonId,
        patch: decided.patch,
        confirm: 'CONFIRM',
      });
    }
    await this.deps.persistence.forActor(actor).privacy.appendAudit(actor, {
      actorId: actor.principalId,
      action: `proposal.${status}`,
      capability: 'privacy.configure',
      resource: id,
      decision: status === 'approved' ? 'ALLOW' : 'DENY',
      reasonCode: status,
      before: null,
      after: decided.patch,
      stepUp: true,
    });
    return decided;
  }

  async audit(actor: PrivacyActor) {
    this.assertOwner(actor, 'privacy.audit');
    return this.deps.persistence.forActor(actor).privacy.listAudit(actor, 200);
  }

  async listProposals(actor: PrivacyActor) {
    this.assertOwner(actor, 'privacy.view');
    return this.deps.persistence.forActor(actor).privacy.listProposals(actor);
  }

  modelContextFor(policy: EffectivePolicy): ModelPolicyContext {
    return this.deps.policy.modelContext(policy);
  }

  /**
   * Load the stored overlay for enforcement. Viewing policy remains owner-only;
   * applying tools/processing restrictions is host-side for every actor.
   */
  async runtimeOverlay(actor: PersistenceActor, dungeonId: DungeonId | null = null): Promise<EffectivePolicy> {
    return this.loadOverlay(actor, dungeonId);
  }

  toolsAllowed(policy: EffectivePolicy, requested: boolean): boolean {
    return this.deps.policy.toolsAllowed(policy, requested);
  }

  runtimePrivacy(policy: EffectivePolicy, requested: 'any' | 'local_only' = 'any'): 'any' | 'local_only' {
    return this.deps.policy.runtimePrivacy(policy, requested);
  }

  scopedModelInstructions(policy: EffectivePolicy): string {
    return this.deps.policy.scopedModelInstructions(policy);
  }

  private async loadOverlay(actor: PersistenceActor, dungeonId: DungeonId | null): Promise<EffectivePolicy> {
    const tenantRow = await this.row(actor, null);
    const dungeonRow = dungeonId ? await this.row(actor, dungeonId) : null;
    const tenant = this.fromRow(actor.tenantId, null, tenantRow);
    const dungeon = dungeonRow ? this.fromRow(actor.tenantId, dungeonId, dungeonRow) : null;
    return this.deps.policy.overlay(tenant, dungeon);
  }

  private fromRow(tenantId: string, dungeonId: DungeonId | null, row: PrivacyPolicyRow | null): EffectivePolicy {
    return this.deps.policy.parse(tenantId, dungeonId, row?.payload ?? defaultEffectivePolicy(tenantId, dungeonId), {
      revision: row?.revision,
      updatedAt: row?.updatedAt,
      updatedBy: row?.updatedBy,
    });
  }

  private async row(actor: PersistenceActor, dungeonId: DungeonId | null) {
    return this.deps.persistence.forActor(actor).privacy.getPolicy(actor, dungeonId);
  }

  private assertOwner(actor: PrivacyActor, capability: 'privacy.view' | 'privacy.configure' | 'privacy.audit'): void {
    if (!actor.tenantId || !actor.principalId) throw new PrivacyError('permission_denied', GENERIC_DENY, 401);
    if (actor.principalId !== this.deps.ownerPrincipalId) {
      this.deps.authority.decide({
        principal: { principalId: actor.principalId, kind: actor.kind ?? 'user', tenantId: actor.tenantId },
        capability,
        resource: { type: 'policy', tenantId: actor.tenantId },
      });
      throw new PrivacyError('permission_denied', GENERIC_DENY, 404);
    }
    const verdict = this.deps.authority.decide({
      principal: { principalId: actor.principalId, kind: actor.kind ?? 'user', tenantId: actor.tenantId },
      capability,
      resource: { type: 'policy', tenantId: actor.tenantId },
    });
    if (verdict.decision !== 'ALLOW') throw new PrivacyError('permission_denied', GENERIC_DENY, 404);
  }
}

void CONSEQUENTIAL_POLICY_FIELDS;
