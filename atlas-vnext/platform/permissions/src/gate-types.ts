import type { CapabilityScope, PermissionDecision } from '@atlas-vnext/contracts';

export interface PermissionGate {
  evaluate(scope: CapabilityScope, projectId?: string): PermissionDecision;
  assertAllowed(scope: CapabilityScope, projectId?: string): void;
}
