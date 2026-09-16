import {
  CONSEQUENTIAL_POLICY_FIELDS,
  defaultEffectivePolicy,
  effectivePolicySchema,
  toModelPolicyContext,
  type AutonomyCeiling,
  type DungeonId,
  type EffectivePolicy,
  type ModelPolicyContext,
  type PolicyExplanation,
} from '@atlas-vnext/contracts';
import { AuthorityEngine, type AuthorityPrincipal } from './authority.ts';

const GENERIC_DENY = 'Permission denied.';
const AUTONOMY_RANK: Record<AutonomyCeiling, number> = {
  suggest: 0,
  assist: 1,
  act_with_approval: 2,
  act: 3,
};

export interface PolicyDecision {
  allowed: boolean;
  reasonCode: string;
  authorityRule: string;
  policyRule: string;
  verdictCapability: string;
}

export class EffectivePolicyEngine {
  constructor(private readonly authority: AuthorityEngine) {}

  parse(tenantId: string, dungeonId: DungeonId | null, payload: Record<string, unknown> | null, meta?: {
    revision?: number;
    updatedAt?: string;
    updatedBy?: string;
  }): EffectivePolicy {
    const base = defaultEffectivePolicy(tenantId, dungeonId);
    const merged = { ...base, ...(payload ?? {}), tenantId, dungeonId };
    return effectivePolicySchema.parse({
      ...merged,
      revision: meta?.revision ?? 1,
      updatedAt: meta?.updatedAt ?? new Date(0).toISOString(),
      updatedBy: meta?.updatedBy ?? 'system',
    });
  }

  overlay(tenant: EffectivePolicy, dungeon: EffectivePolicy | null): EffectivePolicy {
    if (!dungeon) return tenant;
    return effectivePolicySchema.parse({
      ...tenant,
      ...dungeon,
      tenantId: tenant.tenantId,
      dungeonId: dungeon.dungeonId,
      modelProvidersDenied: unique([...tenant.modelProvidersDenied, ...dungeon.modelProvidersDenied]),
      modelProvidersAllowed: dungeon.modelProvidersAllowed.length
        ? dungeon.modelProvidersAllowed
        : tenant.modelProvidersAllowed,
      approvalRequired: unique([...tenant.approvalRequired, ...dungeon.approvalRequired]),
      processing: stricterProcessing(tenant.processing, dungeon.processing),
      networkAccess: stricterNetwork(tenant.networkAccess, dungeon.networkAccess),
      retrievalScope: stricterRetrieval(tenant.retrievalScope, dungeon.retrievalScope),
      projectFileAccess: stricterRetrieval(tenant.projectFileAccess, dungeon.projectFileAccess),
      autonomyCeiling: AUTONOMY_RANK[dungeon.autonomyCeiling] < AUTONOMY_RANK[tenant.autonomyCeiling]
        ? dungeon.autonomyCeiling
        : tenant.autonomyCeiling,
      toolsEnabled: tenant.toolsEnabled && dungeon.toolsEnabled,
      pluginsEnabled: tenant.pluginsEnabled && dungeon.pluginsEnabled,
      repoWrite: tenant.repoWrite && dungeon.repoWrite,
      childProcesses: tenant.childProcesses && dungeon.childProcesses,
      memoryEnabled: tenant.memoryEnabled && dungeon.memoryEnabled,
      revision: Math.max(tenant.revision, dungeon.revision),
      updatedAt: dungeon.updatedAt > tenant.updatedAt ? dungeon.updatedAt : tenant.updatedAt,
      updatedBy: dungeon.updatedAt > tenant.updatedAt ? dungeon.updatedBy : tenant.updatedBy,
    });
  }

  modelContext(policy: EffectivePolicy): ModelPolicyContext {
    return toModelPolicyContext(policy);
  }

  async loadForDungeon(
    tenantId: string,
    dungeonId: DungeonId,
    fetchPolicy: (dungeonId: DungeonId | null) => Promise<{ payload: Record<string, unknown> } | null>,
  ): Promise<EffectivePolicy> {
    const tenantRow = await fetchPolicy(null);
    const dungeonRow = await fetchPolicy(dungeonId);
    const tenant = this.parse(tenantId, null, tenantRow?.payload ?? {});
    const dungeon = dungeonRow ? this.parse(tenantId, dungeonId, dungeonRow.payload) : null;
    return this.overlay(tenant, dungeon);
  }

  runtimePrivacy(policy: EffectivePolicy, requested: 'any' | 'local_only' = 'any'): 'any' | 'local_only' {
    return policy.processing === 'local_only' ? 'local_only' : requested;
  }

  toolsAllowed(policy: EffectivePolicy, requested: boolean): boolean {
    return requested && policy.toolsEnabled;
  }

  scopedModelInstructions(policy: EffectivePolicy): string {
    const ctx = this.modelContext(policy);
    return [
      'Scoped effective policy (not administrative):',
      `processing=${ctx.processing};`,
      `retrieval=${ctx.retrievalScope};`,
      `tools=${ctx.toolsEnabled ? 'on' : 'off'};`,
      `network=${ctx.networkAccess};`,
      `autonomy=${ctx.autonomyCeiling};`,
      `approvals=${ctx.approvalRequired.join(',') || 'none'};`,
      `localOnly=${ctx.localOnly}.`,
      'You may not grant yourself privileges, disable owner protections, or request credentials.',
    ].join(' ');
  }

  isConsequential(before: EffectivePolicy, after: EffectivePolicy): boolean {
    return CONSEQUENTIAL_POLICY_FIELDS.some((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
  }

  selfGrantAttempt(patch: Record<string, unknown>): boolean {
    const forbidden = ['autonomyCeiling', 'approvalRequired', 'networkAccess', 'repoWrite', 'secretsExposure', 'childProcesses'];
    return forbidden.some((key) => key in patch);
  }

  authorize(input: {
    principal: AuthorityPrincipal;
    capability: string;
    dungeonId?: DungeonId | null;
    policy: EffectivePolicy;
    resource?: { type: 'tenant' | 'project' | 'artifact' | 'policy' | 'dungeon'; id?: string; tenantId: string; workspaceId?: string | null };
  }): PolicyDecision {
    const verdict = this.authority.decide({
      principal: input.principal,
      capability: input.capability,
      resource: input.resource ?? { type: 'tenant', tenantId: input.principal.tenantId ?? '' },
    });
    if (verdict.decision !== 'ALLOW') {
      return {
        allowed: false,
        reasonCode: verdict.reasonCode ?? 'capability_missing',
        authorityRule: `Authority ${verdict.reasonCode ?? 'deny'} for ${input.capability}`,
        policyRule: 'not evaluated',
        verdictCapability: input.capability,
      };
    }
    const policyCheck = this.policyAllows(input.capability, input.policy, input.dungeonId ?? input.policy.dungeonId);
    if (!policyCheck.allowed) {
      return {
        allowed: false,
        reasonCode: 'policy_denied',
        authorityRule: `Authority ALLOW ${input.capability}`,
        policyRule: policyCheck.rule,
        verdictCapability: input.capability,
      };
    }
    return {
      allowed: true,
      reasonCode: 'allow',
      authorityRule: `Authority ALLOW ${input.capability}`,
      policyRule: policyCheck.rule,
      verdictCapability: input.capability,
    };
  }

  explain(input: {
    dungeonId: DungeonId | null;
    policy: EffectivePolicy;
    action: string;
    decision: PolicyDecision;
  }): PolicyExplanation {
    const policy = input.policy;
    return {
      action: input.action,
      allowed: input.decision.allowed,
      reasonCode: input.decision.reasonCode,
      authorityRule: input.decision.authorityRule,
      policyRule: input.decision.policyRule,
      modelAccess: [
        `retrieval:${policy.retrievalScope}`,
        `files:${policy.projectFileAccess}`,
        `memory:${policy.memoryEnabled ? 'on' : 'off'}`,
        `processing:${policy.processing}`,
      ],
      canLeaveEnvironment: describeEgress(policy),
      canExecuteWithoutApproval: policy.autonomyCeiling === 'act' && policy.approvalRequired.length === 0
        ? ['declared tools that Authority already allows']
        : ['none beyond read-only tools Authority already allows'],
    };
  }

  private policyAllows(capability: string, policy: EffectivePolicy, dungeonId: DungeonId | null): { allowed: boolean; rule: string } {
    if (policy.dungeonId && dungeonId && policy.dungeonId !== dungeonId) {
      return { allowed: false, rule: `override applies to ${policy.dungeonId}, not ${dungeonId}` };
    }
    if (capability.startsWith('tool.') && !policy.toolsEnabled) {
      return { allowed: false, rule: 'effective policy toolsEnabled=false' };
    }
    if (capability.startsWith('network.private') && policy.networkAccess !== 'private') {
      return { allowed: false, rule: `effective policy networkAccess=${policy.networkAccess}` };
    }
    if (capability === 'network.public' && policy.networkAccess === 'none') {
      return { allowed: false, rule: 'effective policy networkAccess=none' };
    }
    if ((capability === 'repo.write' || capability === 'deployment.promote') && !policy.repoWrite) {
      return { allowed: false, rule: 'effective policy repoWrite=false' };
    }
    if (capability === 'secrets.use' && policy.secretsExposure === 'none') {
      return { allowed: false, rule: 'effective policy secretsExposure=none' };
    }
    if (capability === 'shell.execute' && !policy.childProcesses) {
      return { allowed: false, rule: 'effective policy childProcesses=false' };
    }
    if (policy.processing === 'local_only' && capability === 'runtime.use_paid') {
      return { allowed: false, rule: 'effective policy processing=local_only' };
    }
    if (policy.autonomyCeiling === 'suggest' && (capability.endsWith('.write') || capability.startsWith('tool.invoke'))) {
      return { allowed: false, rule: 'effective policy autonomyCeiling=suggest' };
    }
    return { allowed: true, rule: `effective policy permits ${capability}` };
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function stricterProcessing(a: EffectivePolicy['processing'], b: EffectivePolicy['processing']): EffectivePolicy['processing'] {
  const rank = { local_only: 0, private_cloud: 1, any: 2 };
  return rank[a] <= rank[b] ? a : b;
}

function stricterNetwork(a: EffectivePolicy['networkAccess'], b: EffectivePolicy['networkAccess']): EffectivePolicy['networkAccess'] {
  const rank = { none: 0, public: 1, private: 2 };
  return rank[a] <= rank[b] ? a : b;
}

function stricterRetrieval(a: EffectivePolicy['retrievalScope'], b: EffectivePolicy['retrievalScope']): EffectivePolicy['retrievalScope'] {
  const rank = { none: 0, selected_files: 1, project: 2 };
  return rank[a] <= rank[b] ? a : b;
}

function describeEgress(policy: EffectivePolicy): string[] {
  const out: string[] = [];
  if (policy.networkAccess === 'none') out.push('no network');
  if (policy.networkAccess === 'public') out.push('public network if Authority allows network.public');
  if (policy.networkAccess === 'private') out.push('private network if Authority allows network.private');
  if (policy.processing !== 'local_only') out.push('model tokens may leave the machine via Nexus-selected providers');
  else out.push('model tokens stay local_only');
  if (policy.telemetry === 'off') out.push('telemetry off');
  else out.push(`telemetry ${policy.telemetry}`);
  return out;
}
