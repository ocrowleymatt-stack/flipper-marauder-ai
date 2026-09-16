export class DungeonError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
    this.name = 'DungeonError';
  }
}

export const GENERIC_DENY = 'Permission denied.';
