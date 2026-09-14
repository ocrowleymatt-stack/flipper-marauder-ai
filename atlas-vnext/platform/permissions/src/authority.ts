import {
  capabilityScopeSchema,
  type AuthorityResource,
  type AuthorityVerdict,
  type CapabilityScope,
  type PermissionDecision,
} from '@atlas-vnext/contracts';
import { logPlatform } from '@atlas-vnext/observability';
import type { AuthorityGate } from './behaviour.ts';
import type { PermissionGate } from './gate-types.ts';

export interface AuthorityPrincipal {
  principalId: string;
  kind: 'user' | 'guest' | 'system';
  tenantId: string | null;
  workspaceId?: string | null;
  sessionId?: string | null;
}

export interface AuthorityGrant {
  principalId: string;
  tenantId: string;
  capability: CapabilityScope;
  workspaceId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
}

export interface AuthorityRequest {
  principal: AuthorityPrincipal;
  capability: CapabilityScope | string;
  resource?: AuthorityResource;
  /** Behaviour mode is recorded only; it never grants Authority. */
  behaviour?: 'standard' | 'open';
  fromPlugin?: boolean;
}

const GENERIC_DENY = 'Permission denied.';

export class AuthorityEngine implements PermissionGate, AuthorityGate {
  private readonly grants: AuthorityGrant[] = [];
  private readonly memberships = new Set<string>();
  private readonly workspaceMemberships = new Set<string>();
  private readonly audit: Array<{ at: string; principalId: string; capability: string; decision: string; reasonCode: string }> =
    [];

  grantMembership(principalId: string, tenantId: string): void {
    this.memberships.add(`${principalId}::${tenantId}`);
  }

  grantWorkspaceMembership(principalId: string, tenantId: string, workspaceId: string): void {
    this.workspaceMemberships.add(`${principalId}::${tenantId}::${workspaceId}`);
  }

  grant(scope: CapabilityScope, projectId = '*'): void {
    this.grants.push({
      principalId: '*',
      tenantId: '*',
      capability: scope,
      workspaceId: projectId === '*' ? null : projectId,
      resourceId: projectId === '*' ? null : projectId,
    });
  }

  grantTo(grant: AuthorityGrant): void {
    this.grants.push(grant);
  }

  revoke(scope: CapabilityScope, projectId = '*'): void {
    for (let i = this.grants.length - 1; i >= 0; i -= 1) {
      const row = this.grants[i];
      if (!row) continue;
      if (row.capability !== scope) continue;
      if (projectId === '*' || row.workspaceId === projectId || row.resourceId === projectId) {
        this.grants.splice(i, 1);
      }
    }
  }

  evaluate(scope: CapabilityScope, projectId?: string): PermissionDecision {
    return this.decide({
      principal: { principalId: '*', kind: 'system', tenantId: '*', workspaceId: projectId ?? null },
      capability: scope,
      resource: projectId
        ? { type: 'project', id: projectId, tenantId: '*', workspaceId: projectId }
        : { type: 'tenant', tenantId: '*' },
    }).decision === 'ALLOW'
      ? 'ALLOW'
      : 'DENY';
  }

  assertAllowed(scope: CapabilityScope, projectId?: string): void {
    const verdict = this.decide({
      principal: { principalId: '*', kind: 'system', tenantId: '*', workspaceId: projectId ?? null },
      capability: scope,
      resource: projectId
        ? { type: 'project', id: projectId, tenantId: '*', workspaceId: projectId }
        : { type: 'tenant', tenantId: '*' },
    });
    if (verdict.decision !== 'ALLOW') throw new AuthorityDeniedError(verdict);
  }

  decide(request: AuthorityRequest): AuthorityVerdict {
    const parsed = capabilityScopeSchema.safeParse(request.capability);
    if (!parsed.success) {
      return this.finish(request, {
        decision: 'DENY',
        capability: String(request.capability),
        reasonCode: 'invalid_capability',
        message: GENERIC_DENY,
        leakSensitive: false,
      });
    }
    const capability = parsed.data;
    const principal = request.principal;

    if (!principal.principalId?.trim()) {
      return this.finish(request, deny('unauthenticated', capability));
    }
    if (principal.kind === 'guest') {
      return this.finish(request, deny('capability_missing', capability));
    }

    const resourceTenant = request.resource?.tenantId;
    if (resourceTenant && principal.tenantId && resourceTenant !== principal.tenantId && principal.tenantId !== '*') {
      return this.finish(request, deny('cross_tenant', capability));
    }
    if (principal.kind !== 'system' && principal.tenantId !== '*' && principal.tenantId) {
      if (!this.memberships.has(`${principal.principalId}::${principal.tenantId}`) && !this.hasWildcardGrant()) {
        return this.finish(request, deny('not_a_member', capability));
      }
    }
    const workspaceId = request.resource?.workspaceId ?? principal.workspaceId;
    if (
      workspaceId &&
      principal.kind !== 'system' &&
      principal.tenantId &&
      principal.tenantId !== '*' &&
      this.workspaceScoped(workspaceId)
    ) {
      if (!this.workspaceMemberships.has(`${principal.principalId}::${principal.tenantId}::${workspaceId}`)) {
        return this.finish(request, deny('resource_out_of_scope', capability));
      }
    }

    if (request.fromPlugin) {
      const allowed = this.matches(principal, capability, request.resource);
      if (!allowed) return this.finish(request, deny('plugin_cannot_bypass', capability));
    }

    if (this.matches(principal, capability, request.resource)) {
      return this.finish(request, {
        decision: 'ALLOW',
        capability,
        message: 'allowed',
        leakSensitive: false,
      });
    }
    return this.finish(request, deny('capability_missing', capability));
  }

  auditLog() {
    return [...this.audit];
  }

  private workspaceScoped(workspaceId: string): boolean {
    for (const key of this.workspaceMemberships) {
      if (key.endsWith(`::${workspaceId}`)) return true;
    }
    return false;
  }

  private hasWildcardGrant(): boolean {
    return this.grants.some((row) => row.principalId === '*' && row.tenantId === '*');
  }

  private matches(principal: AuthorityPrincipal, capability: CapabilityScope, resource?: AuthorityResource): boolean {
    return this.grants.some((grant) => {
      if (grant.capability !== capability) return false;
      if (grant.principalId !== '*' && grant.principalId !== principal.principalId) return false;
      if (grant.tenantId !== '*' && grant.tenantId !== principal.tenantId) return false;
      if (grant.workspaceId && resource?.workspaceId && grant.workspaceId !== resource.workspaceId) return false;
      if (grant.resourceId && resource?.id && grant.resourceId !== resource.id) return false;
      if (grant.resourceType && resource?.type && grant.resourceType !== resource.type) return false;
      return true;
    });
  }

  private finish(request: AuthorityRequest, verdict: AuthorityVerdict): AuthorityVerdict {
    this.audit.push({
      at: new Date().toISOString(),
      principalId: request.principal.principalId,
      capability: verdict.capability,
      decision: verdict.decision,
      reasonCode: verdict.reasonCode ?? (verdict.decision === 'ALLOW' ? 'allow' : 'deny'),
    });
    logPlatform('authority.decide', {
      principalId: request.principal.principalId,
      tenantId: request.principal.tenantId,
      workspaceId: request.principal.workspaceId ?? request.resource?.workspaceId ?? null,
      capability: verdict.capability,
      decision: verdict.decision,
      reasonCode: verdict.reasonCode ?? null,
      resourceType: request.resource?.type ?? null,
      behaviour: request.behaviour ?? null,
      fromPlugin: request.fromPlugin ?? false,
    });
    return verdict;
  }
}

function deny(
  reasonCode: AuthorityVerdict['reasonCode'],
  capability: string,
): AuthorityVerdict {
  return {
    decision: 'DENY',
    capability,
    reasonCode,
    message: GENERIC_DENY,
    leakSensitive: false,
  };
}

export class AuthorityDeniedError extends Error {
  readonly verdict: AuthorityVerdict;
  constructor(verdict: AuthorityVerdict) {
    super(verdict.message);
    this.name = 'AuthorityDeniedError';
    this.verdict = verdict;
  }
}
