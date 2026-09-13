import type { BrokerExecuteRequest, Capability, ExecutionIntent, VNextEvent } from "@atlas-vnext/contracts";
import { CAPABILITY_ACTION_RE } from "@atlas-vnext/contracts";

export class CapabilityDenied extends Error {
  constructor(readonly action: string) {
    super(`missing capability for ${action}`);
  }
}

export function hasAction(grants: Capability[], action: string): boolean {
  if (!CAPABILITY_ACTION_RE.test(action)) return false;
  const now = Date.now();
  return grants.some((grant) => {
    if (grant.action !== action) return false;
    if (Date.parse(grant.notBefore) > now) return false;
    if (Date.parse(grant.expiresAt) <= now) return false;
    return true;
  });
}

/** Single choke point. Roles are not consulted. */
export function assertExecuteAllowed(intent: ExecutionIntent): void {
  if (!hasAction(intent.capabilities, "provider:invoke")) {
    throw new CapabilityDenied("provider:invoke");
  }
}

export async function execute(request: BrokerExecuteRequest): Promise<VNextEvent[]> {
  assertExecuteAllowed(request.intent);
  const occurredAt = new Date().toISOString();
  return [
    {
      id: `${request.intent.correlationId}:accepted`,
      sequence: 1,
      occurredAt,
      correlationId: request.intent.correlationId,
      projectId: request.intent.projectId,
      type: "broker:accepted",
      payload: { capabilityId: request.intent.capabilityId, chain: request.intent.chain },
    },
  ];
}
