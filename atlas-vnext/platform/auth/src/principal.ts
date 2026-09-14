import {
  GUEST_PRINCIPAL_ID,
  SYSTEM_PRINCIPAL_ID,
  type Principal,
  type PrincipalKind,
} from '@atlas-vnext/contracts';

export interface AuthActor {
  principalId: string;
  kind: PrincipalKind;
  tenantId: string | null;
  workspaceId?: string | null;
  sessionId?: string | null;
  roles?: string[];
}

export function systemPrincipal(tenantId: string | null = null): Principal {
  return {
    id: SYSTEM_PRINCIPAL_ID,
    urn: `urn:atlas:principal:${SYSTEM_PRINCIPAL_ID}`,
    kind: 'system',
    displayName: 'system',
    tenantId,
    sessionId: null,
  };
}

export function guestPrincipal(): Principal {
  return {
    id: GUEST_PRINCIPAL_ID,
    urn: `urn:atlas:principal:${GUEST_PRINCIPAL_ID}`,
    kind: 'guest',
    displayName: 'guest',
    tenantId: null,
    sessionId: null,
  };
}

export function userPrincipal(input: {
  id: string;
  tenantId: string;
  displayName?: string | null;
  sessionId?: string | null;
}): Principal {
  return {
    id: input.id,
    urn: `urn:atlas:principal:${input.id}`,
    kind: 'user',
    displayName: input.displayName ?? null,
    tenantId: input.tenantId,
    sessionId: input.sessionId ?? null,
  };
}

export function toAuthActor(principal: Principal, workspaceId?: string | null): AuthActor {
  return {
    principalId: principal.id,
    kind: principal.kind,
    tenantId: principal.tenantId,
    workspaceId: workspaceId ?? null,
    sessionId: principal.sessionId ?? null,
  };
}

/**
 * Caller-supplied tenant IDs are claims, not membership.
 * Auth resolution never trusts an unauthenticated header/body tenant id.
 */
export function claimedTenantIsNotMembership(claimed: string | undefined, memberOf: string | null): boolean {
  if (!claimed?.trim()) return false;
  return claimed !== memberOf;
}
