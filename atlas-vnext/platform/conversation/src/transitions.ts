import type { ExecutionStatus } from '@atlas-vnext/contracts';

export const EXECUTION_TRANSITIONS: Record<ExecutionStatus, readonly ExecutionStatus[]> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function assertExecutionTransition(from: ExecutionStatus, to: ExecutionStatus): void {
  if (!EXECUTION_TRANSITIONS[from].includes(to)) {
    throw new Error(`Illegal execution transition ${from} → ${to}`);
  }
}
