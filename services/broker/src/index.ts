import type { DurableJob, EventEnvelope, ExecutionIntent } from '@atlas/contracts';

export interface PermissionDecision {
  decision: 'allow' | 'deny' | 'suspend';
  decisionId: string;
  matchedGrantIds: string[];
  reason: string;
}

export interface ExecutionBroker {
  execute(intent: ExecutionIntent, signal: AbortSignal): AsyncIterable<EventEnvelope>;
  enqueue(job: DurableJob): Promise<{ jobId: string; created: boolean }>;
  decidePermission(intent: ExecutionIntent, requiredCapability: string): Promise<PermissionDecision>;
}
