import type { ExecutionIntent } from "@atlas-vnext/contracts";
import { CAPABILITY_TABLE, type CapabilityRoute } from "./table.js";

export interface ResolveInput {
  target: string;
  projectId: string;
  correlationId: string;
  capabilities: ExecutionIntent["capabilities"];
  text: string;
}

function canonicalTarget(target: string): string {
  const t = target.trim().toLowerCase();
  if (t === "auto" || t === "nexus/auto") return "nexus/reason";
  return t.startsWith("nexus/") ? t : `nexus/${t}`;
}

export function resolveRoute(target: string): CapabilityRoute {
  const id = canonicalTarget(target);
  const route = CAPABILITY_TABLE.find((row) => row.id === id);
  if (!route) throw new Error(`unknown capability: ${id}`);
  return route;
}

/** Pure resolution. Side effects belong in the broker. */
export function resolve(input: ResolveInput): ExecutionIntent {
  const route = resolveRoute(input.target);
  return {
    correlationId: input.correlationId,
    projectId: input.projectId,
    capabilityId: route.id,
    chain: [...route.chain],
    policy: { localOnly: route.localOnly },
    input: { kind: "inline", text: input.text },
    capabilities: input.capabilities,
  };
}
