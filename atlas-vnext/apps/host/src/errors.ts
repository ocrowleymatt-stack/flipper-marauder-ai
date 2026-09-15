export type PlatformErrorCode =
  | 'unauthenticated'
  | 'unauthorised'
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'rate_limit'
  | 'payload_too_large'
  | 'provider_unavailable'
  | 'fail_before_visible'
  | 'fail_after_visible'
  | 'tool_denied'
  | 'tool_uncertain'
  | 'persistence_unavailable'
  | 'cas_unavailable'
  | 'shutting_down'
  | 'timeout'
  | 'kill_switch'
  | 'internal';

export class PlatformHttpError extends Error {
  constructor(
    readonly code: PlatformErrorCode,
    message: string,
    readonly httpStatus: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'PlatformHttpError';
  }
}

export const GENERIC_NOT_FOUND = 'Not found.';
export const GENERIC_DENIED = 'Permission denied.';

export function httpStatusFor(code: PlatformErrorCode): number {
  switch (code) {
    case 'unauthenticated':
      return 401;
    case 'unauthorised':
    case 'tool_denied':
      return 403;
    case 'not_found':
      return 404;
    case 'conflict':
      return 409;
    case 'validation':
      return 400;
    case 'rate_limit':
      return 429;
    case 'payload_too_large':
      return 413;
    case 'provider_unavailable':
    case 'persistence_unavailable':
    case 'cas_unavailable':
    case 'shutting_down':
    case 'kill_switch':
      return 503;
    case 'timeout':
      return 504;
    case 'fail_before_visible':
    case 'fail_after_visible':
    case 'tool_uncertain':
    case 'internal':
    default:
      return 500;
  }
}

export function publicErrorBody(err: PlatformHttpError): { error: string; code: PlatformErrorCode } {
  return { error: err.message, code: err.code };
}
