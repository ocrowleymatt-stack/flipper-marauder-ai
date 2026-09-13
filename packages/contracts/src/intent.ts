import type { Capability } from "./capability.js";
import type { ContentAddress } from "./storage.js";

export type CapabilityId = `nexus/${string}`;

export interface ExecutionPolicy {
  localOnly: boolean;
  maxTokens?: number;
  retrievalRequired?: boolean;
  posture?: string;
}

export type ExecutionInput =
  | { kind: "inline"; text: string }
  | { kind: "cas"; address: ContentAddress };

/**
 * Nexus → broker handoff. No adapters, retries, roles, or credentials.
 */
export interface ExecutionIntent {
  correlationId: string;
  projectId: string;
  capabilityId: CapabilityId;
  chain: string[];
  policy: ExecutionPolicy;
  input: ExecutionInput;
  capabilities: Capability[];
}

export interface BrokerExecuteRequest {
  intent: ExecutionIntent;
}
