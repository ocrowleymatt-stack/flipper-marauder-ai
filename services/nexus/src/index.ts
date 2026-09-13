import type { ExecutionIntent } from '@atlas/contracts';

/** Read-only registry view supplied to the router; provider execution is absent by design. */
export interface RegistrySnapshot {
  version: number;
  providers: ReadonlyArray<{
    id: string;
    local: boolean;
    health: 'healthy' | 'configured' | 'authentication_failure' | 'unavailable';
    capabilities: readonly string[];
  }>;
}

export interface RouteRequest {
  target: string;
  tenantId: string;
  projectId: string;
  correlationId: string;
  sessionCapabilities: readonly string[];
  contextTokens: number;
}

/** Contract only: implementation arrives after the first design gate. */
export interface NexusRouter {
  resolve(request: RouteRequest, registry: RegistrySnapshot): ExecutionIntent;
}
