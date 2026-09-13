import type { ContentAddress } from "./storage.js";

export type EvidentialStatus =
  | "primary"
  | "secondary"
  | "intelligence_lead"
  | "derived"
  | "unavailable";

export type ProvenanceMethod = "http" | "tool" | "model" | "human" | "cas" | "device" | "derived";

export interface Provenance {
  source: string;
  retrievedAt: string;
  method: ProvenanceMethod;
  evidentialStatus: EvidentialStatus;
  contentAddress?: ContentAddress;
  digest?: `sha256:${string}`;
}
