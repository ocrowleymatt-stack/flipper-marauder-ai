import type { IncomingMessage, ServerResponse } from 'node:http';
import { AuthenticationError } from '@atlas-vnext/auth';
import { canonicalProposal, type OperationsDoctor, type RepairExecutor } from '@atlas-vnext/operations';
import { json, readJson, urlPath } from './http.ts';
import { resolveActor, type WorkbenchHostOptions } from './workbench.ts';

export interface OperationsHostOptions extends WorkbenchHostOptions {
  doctor?: OperationsDoctor | null;
  repairs?: RepairExecutor | null;
}

export async function handleOperations(
  req: IncomingMessage,
  res: ServerResponse,
  options: OperationsHostOptions,
): Promise<boolean> {
  const pathname = urlPath(req);
  const doctorPath = pathname === '/api/ops/doctor';
  const applyPath = pathname.match(/^\/api\/ops\/repairs\/([^/]+)\/apply$/);
  if (!doctorPath && !applyPath) return false;

  const actor = await resolveActor(req, options);
  if (!actor) {
    throw new AuthenticationError('unauthenticated', 'Authentication required.');
  }
  const principal = {
    principalId: actor.principalId,
    tenantId: actor.tenantId,
    kind: 'user' as const,
  };

  if (req.method === 'GET' && doctorPath) {
    const doctor = options.doctor;
    if (!doctor) {
      json(res, 503, { error: 'operations_unavailable' });
      return true;
    }
    json(res, 200, await doctor.inspect(principal));
    return true;
  }

  if (req.method === 'POST' && applyPath) {
    const repairs = options.repairs;
    if (!repairs) {
      json(res, 503, { error: 'operations_unavailable' });
      return true;
    }
    const id = decodeURIComponent(applyPath[1]!);
    const proposal = canonicalProposal(id);
    if (!proposal) {
      json(res, 404, { error: 'Permission denied.' });
      return true;
    }
    await readJson(req, options.maxRequestBytes);
    json(res, 200, await repairs.apply(principal, proposal));
    return true;
  }

  return false;
}
