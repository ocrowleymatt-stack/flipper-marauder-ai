import type { PersistenceActor } from '@atlas-vnext/persistence';

export const GENERIC_DENY = 'Permission denied.';

export class InvestigationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
    this.name = 'InvestigationError';
  }
}

export interface InvestigationActor extends PersistenceActor {
  principalId: string;
  tenantId: string;
}
