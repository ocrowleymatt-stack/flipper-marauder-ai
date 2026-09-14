import { OwnershipError } from './errors.ts';

export interface PersistenceActor {
  tenantId: string;
  workspaceId?: string | null;
  principalId?: string | null;
}

export function assertActor(actor: PersistenceActor | null | undefined, action: string): PersistenceActor {
  if (!actor?.tenantId?.trim()) {
    throw new OwnershipError(`Fail-closed: cannot ${action} without a tenant id.`);
  }
  return actor;
}

export function sameWorkspace(actor: PersistenceActor, workspaceId: string | null | undefined): boolean {
  if (!actor.workspaceId) return true;
  if (!workspaceId) return true;
  return actor.workspaceId === workspaceId;
}
