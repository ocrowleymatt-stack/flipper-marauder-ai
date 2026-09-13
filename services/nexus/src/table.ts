import type { CapabilityId } from "@atlas-vnext/contracts";

export interface CapabilityRoute {
  id: CapabilityId;
  chain: string[];
  localOnly: boolean;
}

/** Capability table is data. Owned-first is chain order, not special-case code. */
export const CAPABILITY_TABLE: CapabilityRoute[] = [
  { id: "nexus/instant", chain: ["owned/chat", "cloud/chat"], localOnly: false },
  { id: "nexus/reason", chain: ["owned/reason", "cloud/reason"], localOnly: false },
  { id: "nexus/private", chain: ["local/chat"], localOnly: true },
];
