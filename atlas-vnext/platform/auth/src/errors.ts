export class AuthenticationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AuthenticationError';
    this.code = code;
  }
}

export class SessionRevokedError extends AuthenticationError {
  constructor(message = 'Session revoked.') {
    super('session_revoked', message);
    this.name = 'SessionRevokedError';
  }
}

export class CsrfError extends AuthenticationError {
  constructor(message = 'CSRF validation failed.') {
    super('csrf_failed', message);
    this.name = 'CsrfError';
  }
}

export class OriginError extends AuthenticationError {
  constructor(message = 'Origin validation failed.') {
    super('origin_failed', message);
    this.name = 'OriginError';
  }
}
