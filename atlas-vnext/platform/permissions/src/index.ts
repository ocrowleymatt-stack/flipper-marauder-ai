import type { CapabilityScope, PermissionDecision } from '@atlas-vnext/contracts';
import { DANGEROUS_CAPABILITY_SCOPES } from '@atlas-vnext/contracts';

export interface PermissionGate {
  evaluate(scope: CapabilityScope, projectId?: string): PermissionDecision;
  assertAllowed(scope: CapabilityScope, projectId?: string): void;
}

export class PermissionsNotImplementedError extends Error {
  constructor() {
    super('platform/permissions grant persistence is deferred; use DefaultDenyGate for evaluation.');
    this.name = 'PermissionsNotImplementedError';
  }
}

/**
 * Single evaluation point. Default deny for every scope until an explicit grant
 * exists. Dangerous scopes never auto-allow. Persistence of grants is later;
 * scattering checks in dungeons or UI is forbidden.
 */
export class DefaultDenyGate implements PermissionGate {
  private readonly grants = new Set<string>();

  grant(scope: CapabilityScope, projectId = '*'): void {
    this.grants.add(grantKey(scope, projectId));
  }

  revoke(scope: CapabilityScope, projectId = '*'): void {
    this.grants.delete(grantKey(scope, projectId));
  }

  evaluate(scope: CapabilityScope, projectId?: string): PermissionDecision {
    if (this.grants.has(grantKey(scope, '*'))) return 'ALLOW';
    if (projectId && this.grants.has(grantKey(scope, projectId))) return 'ALLOW';
    return 'DENY';
  }

  assertAllowed(scope: CapabilityScope, projectId?: string): void {
    if (this.evaluate(scope, projectId) !== 'ALLOW') {
      throw new Error(`Permission denied: ${scope}`);
    }
  }

  isDangerous(scope: CapabilityScope): boolean {
    return (DANGEROUS_CAPABILITY_SCOPES as readonly string[]).includes(scope);
  }
}

function grantKey(scope: CapabilityScope, projectId: string): string {
  return `${projectId}::${scope}`;
}
