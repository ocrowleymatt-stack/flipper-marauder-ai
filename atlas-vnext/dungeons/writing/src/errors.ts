export class WritingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
    this.name = 'WritingError';
  }
}

export const GENERIC_DENY = 'Permission denied.';
