import type { ContentAddress } from "./storage.js";

export type JobStatus =
  | "queued"
  | "leased"
  | "running"
  | "suspended"
  | "completed"
  | "failed"
  | "cancelled";

export interface Job {
  id: string;
  projectId: string;
  type: `${string}.${string}`;
  status: JobStatus;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  correlationId: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  checkpoint?: ContentAddress;
  input?: ContentAddress;
  result?: ContentAddress;
  error?: string;
  progress?: number;
}
