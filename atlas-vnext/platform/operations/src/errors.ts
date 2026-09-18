/** Generic denial copied onto repair execution. Never leak capability or resource detail. */
export const GENERIC_REPAIR_DENIED = 'Permission denied.';

export class OperationsRepairDeniedError extends Error {
  constructor() {
    super(GENERIC_REPAIR_DENIED);
    this.name = 'OperationsRepairDeniedError';
  }
}

export class OperationsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationsError';
  }
}
