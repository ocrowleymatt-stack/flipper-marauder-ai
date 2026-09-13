import type { CapabilityScope, PermissionDecision } from '@atlas-vnext/contracts';

export interface PermissionGate {
  evaluate(scope: CapabilityScope, projectId?: string): PermissionDecision;
  assertAllowed(scope: CapabilityScope, projectId?: string): void;
}

export class PermissionsNotImplementedError extends Error {
  constructor() {
    super('platform/permissions is a design-gate shell; durable implementation is deferred.');
    this.name = 'PermissionsNotImplementedError';
  }
}
