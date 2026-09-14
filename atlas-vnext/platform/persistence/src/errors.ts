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
