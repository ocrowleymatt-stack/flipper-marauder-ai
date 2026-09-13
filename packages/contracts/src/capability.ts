export interface CapabilityCaveat {
  type: string;
  value?: unknown;
}

/**
 * Capability token. Role/group fields are intentionally absent.
 * Checking `roles` at the broker execute boundary is an architecture violation.
 */
export interface Capability {
  id: string;
  issuer: string;
  subject: string;
  action: `${string}:${string}`;
  resource: string;
  notBefore: string;
  expiresAt: string;
  caveats: CapabilityCaveat[];
  proof: string;
}

export const CAPABILITY_ACTION_RE = /^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/;
