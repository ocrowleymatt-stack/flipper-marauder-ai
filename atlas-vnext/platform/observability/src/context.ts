import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  requestId: string;
  tenantId?: string;
  actorId?: string;
  projectId?: string;
  conversationId?: string;
  runId?: string;
  route?: string;
  attempt?: number;
  toolId?: string;
  approvalId?: string;
  documentId?: string;
  provider?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function createRequestId(incoming?: string | null): string {
  const trimmed = incoming?.trim();
  if (trimmed && /^[A-Za-z0-9._-]{8,128}$/.test(trimmed)) return trimmed;
  return `req_${randomUUID()}`;
}

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run({ ...context }, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function patchRequestContext(patch: Partial<RequestContext>): void {
  const current = storage.getStore();
  if (!current) return;
  Object.assign(current, patch);
}

export function correlationFields(extra: RequestContext | undefined = getRequestContext()): Record<string, string | number> {
  if (!extra) return {};
  const out: Record<string, string | number> = { requestId: extra.requestId };
  if (extra.tenantId) out.tenantId = extra.tenantId;
  if (extra.actorId) out.actorId = extra.actorId;
  if (extra.projectId) out.projectId = extra.projectId;
  if (extra.conversationId) out.conversationId = extra.conversationId;
  if (extra.runId) out.runId = extra.runId;
  if (extra.route) out.route = extra.route;
  if (extra.attempt !== undefined) out.attempt = extra.attempt;
  if (extra.toolId) out.toolId = extra.toolId;
  if (extra.approvalId) out.approvalId = extra.approvalId;
  if (extra.documentId) out.documentId = extra.documentId;
  if (extra.provider) out.provider = extra.provider;
  return out;
}
