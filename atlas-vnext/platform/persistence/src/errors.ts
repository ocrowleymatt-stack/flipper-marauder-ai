export class PersistenceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersistenceConfigError';
  }
}

export class PersistenceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersistenceUnavailableError';
  }
}

export class PersistenceClosedError extends Error {
  constructor(message = 'Persistence kernel has been shut down.') {
    super(message);
    this.name = 'PersistenceClosedError';
  }
}

/**
 * A mutating statement or COMMIT was dispatched, then the client lost the
 * result. The change may already have been applied. Callers must not replay.
 */
export class PersistenceUncertainError extends Error {
  constructor(
    message = 'Persistence operation completed with uncertain commit state.',
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PersistenceUncertainError';
  }
}

export class OwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnershipError';
  }
}

export class MigrationError extends Error {
  constructor(message: string, readonly version?: number) {
    super(message);
    this.name = 'MigrationError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}
