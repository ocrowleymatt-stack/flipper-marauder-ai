import type { ToolInvocationStatus } from '@atlas-vnext/contracts';

export const TOOL_TRANSITIONS: Record<ToolInvocationStatus, readonly ToolInvocationStatus[]> = {
  proposed: ['validated', 'failed', 'denied', 'cancelled'],
  validated: ['authorised', 'denied', 'failed', 'cancelled'],
  authorised: ['awaiting_approval', 'queued', 'denied', 'cancelled', 'failed'],
  awaiting_approval: ['queued', 'denied', 'cancelled', 'failed'],
  queued: ['running', 'cancelled', 'failed'],
  running: ['succeeded', 'failed', 'cancelled', 'uncertain'],
  succeeded: [],
  failed: [],
  cancelled: [],
  denied: [],
  uncertain: [],
};

export const TERMINAL_TOOL_STATUSES: readonly ToolInvocationStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
  'denied',
  'uncertain',
];

export function assertToolTransition(from: ToolInvocationStatus, to: ToolInvocationStatus): void {
  if (from === to) return;
  if (!TOOL_TRANSITIONS[from].includes(to)) {
    throw new Error(`Illegal tool invocation transition ${from} → ${to}`);
  }
}

export function isTerminalToolStatus(status: ToolInvocationStatus): boolean {
  return (TERMINAL_TOOL_STATUSES as readonly string[]).includes(status);
}
