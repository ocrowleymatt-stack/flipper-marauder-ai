import {
  AUTHORITY_SCOPES_UNCHANGED_BY_BEHAVIOUR,
  DEFAULT_BEHAVIOUR_MODE,
  behaviourModeSchema,
  composedPromptSchema,
  type BehaviourAuthorityBoundary,
  type BehaviourMode,
  type CapabilityScope,
  type ComposedPrompt,
  type PermissionDecision,
  type TenantBehaviourRecord,
} from '@atlas-vnext/contracts';

export interface AuthorityGate {
  evaluate(scope: CapabilityScope, projectId?: string): PermissionDecision;
}

export class TenantIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantIsolationError';
  }
}

export class BehaviourPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BehaviourPolicyError';
  }
}

const OPEN_POSTURE =
  'Behaviour: Open. Answer directly and with fewer conversational refusals of lawful discussion. This posture does not grant tools, filesystem, shell, network, publishing, compute, or administrative authority.';

const STANDARD_POSTURE =
  'Behaviour: Standard. Prefer conservative, scoped assistance. This posture does not grant tools, filesystem, shell, network, publishing, compute, or administrative authority.';

/**
 * Per-tenant Behaviour store. Fail-closed: missing tenant or missing row → Standard.
 * Tenant A cannot read or write tenant B. Not a product database.
 */
export class TenantBehaviourStore {
  private readonly records = new Map<string, TenantBehaviourRecord>();

  resolve(actorTenantId: string, subjectTenantId = actorTenantId): BehaviourMode {
    this.assertTenant(actorTenantId, 'resolve');
    this.assertSameTenant(actorTenantId, subjectTenantId, 'read');
    return this.records.get(subjectTenantId)?.behaviour ?? DEFAULT_BEHAVIOUR_MODE;
  }

  read(actorTenantId: string, subjectTenantId: string): TenantBehaviourRecord | null {
    this.assertTenant(actorTenantId, 'read');
    this.assertSameTenant(actorTenantId, subjectTenantId, 'read');
    return this.records.get(subjectTenantId) ?? null;
  }

  write(
    actorTenantId: string,
    subjectTenantId: string,
    behaviour: BehaviourMode,
    now = () => new Date().toISOString(),
  ): TenantBehaviourRecord {
    this.assertTenant(actorTenantId, 'write');
    this.assertSameTenant(actorTenantId, subjectTenantId, 'write');
    const parsed = behaviourModeSchema.parse(behaviour);
    const record: TenantBehaviourRecord = {
      tenantId: subjectTenantId,
      behaviour: parsed,
      updatedAt: now(),
      updatedByTenantId: actorTenantId,
    };
    this.records.set(subjectTenantId, record);
    return record;
  }

  private assertTenant(tenantId: string, action: string): void {
    if (!tenantId.trim()) {
      throw new TenantIsolationError(`Fail-closed: cannot ${action} Behaviour without a tenant id.`);
    }
  }

  private assertSameTenant(actorTenantId: string, subjectTenantId: string, action: string): void {
    if (!subjectTenantId.trim() || actorTenantId !== subjectTenantId) {
      throw new TenantIsolationError(
        `Fail-closed: tenant ${actorTenantId} cannot ${action} Behaviour for tenant ${subjectTenantId}.`,
      );
    }
  }
}

/**
 * Open/Standard change response posture only. Authority is the permission gate,
 * evaluated independently. Open never auto-grants scopes.
 */
export function authorityBoundary(
  behaviour: BehaviourMode,
  gate: AuthorityGate,
  projectId?: string,
): BehaviourAuthorityBoundary {
  const parsed = behaviourModeSchema.parse(behaviour);
  const granted: CapabilityScope[] = [];
  const denied: CapabilityScope[] = [];
  for (const scope of AUTHORITY_SCOPES_UNCHANGED_BY_BEHAVIOUR) {
    const typed = scope as CapabilityScope;
    const decision: PermissionDecision = gate.evaluate(typed, projectId);
    if (decision === 'ALLOW') granted.push(typed);
    else denied.push(typed);
  }
  return { behaviour: parsed, grantedScopes: granted, deniedScopes: denied };
}

export function behaviourGrantsNoAuthority(behaviour: BehaviourMode, gate: AuthorityGate): boolean {
  const open = authorityBoundary('open', gate);
  const standard = authorityBoundary('standard', gate);
  const same =
    open.grantedScopes.join('|') === standard.grantedScopes.join('|') &&
    open.deniedScopes.join('|') === standard.deniedScopes.join('|');
  return same && behaviour !== undefined;
}

/**
 * Compose Behaviour posture *with* capability and runtime policy.
 * Missing capability/runtime policy fails closed — posture must not replace them.
 */
export function composeBehaviourPrompt(input: {
  behaviour: BehaviourMode;
  capabilityPolicy: string;
  runtimePolicy: string;
}): ComposedPrompt {
  const capabilityPolicy = input.capabilityPolicy.trim();
  const runtimePolicy = input.runtimePolicy.trim();
  if (!capabilityPolicy || !runtimePolicy) {
    throw new BehaviourPolicyError(
      'Fail-closed: Behaviour posture cannot replace capability or runtime policy.',
    );
  }
  const parsedBehaviour = behaviourModeSchema.parse(input.behaviour);
  const behaviourPosture = parsedBehaviour === 'open' ? OPEN_POSTURE : STANDARD_POSTURE;
  const parsed = composedPromptSchema.parse({
    layers: { capabilityPolicy, runtimePolicy, behaviourPosture },
    text: [capabilityPolicy, runtimePolicy, behaviourPosture].join('\n\n'),
  });
  return parsed;
}
