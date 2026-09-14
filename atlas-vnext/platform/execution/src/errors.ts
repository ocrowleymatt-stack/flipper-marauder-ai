import type { StructuredFailure, TokenUsage } from '@atlas-vnext/contracts';
import { sanitizeText } from './sanitize.ts';

export class ProviderHttpError extends Error {
  readonly failure: StructuredFailure;

  constructor(failure: StructuredFailure) {
    super(failure.message);
    this.name = 'ProviderHttpError';
    this.failure = failure;
  }
}

export function httpFailure(
  provider: string,
  status: number,
  body: string,
  secrets: Array<string | undefined | null> = [],
): StructuredFailure {
  const safeBody = sanitizeText(body, secrets).slice(0, 400);
  const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
  const code =
    status === 401 || status === 403
      ? 'authentication_failure'
      : status === 404
        ? 'not_found'
        : status === 429
          ? 'rate_limited'
          : retryable
            ? 'provider_unavailable'
            : 'provider_error';
  return {
    code,
    message: `${provider} HTTP ${status}${safeBody ? `: ${safeBody}` : ''}`,
    retryable,
    at: new Date().toISOString(),
  };
}

export function connectionFailure(
  provider: string,
  reason: string,
  secrets: Array<string | undefined | null> = [],
): StructuredFailure {
  return {
    code: 'connection_failure',
    message: `${provider} connection failed: ${sanitizeText(reason, secrets)}`,
    retryable: true,
    at: new Date().toISOString(),
  };
}

export function usageFromCounts(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  totalTokens?: number,
): TokenUsage | null {
  if (inputTokens == null || outputTokens == null) return null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens ?? inputTokens + outputTokens,
  };
}

export function throwIfSecretLeaked(message: string, secret: string | undefined): void {
  if (secret && message.includes(secret)) {
    throw new Error('Refusing to throw an error that contains a provider secret.');
  }
}

/** Auth failures are not retried on the same provider; 429/5xx and transport blips are. */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof ProviderHttpError) return err.failure.retryable;
  const message = err instanceof Error ? err.message : String(err);
  if (/missing credentials|authentication_failure|not implemented/i.test(message)) return false;
  if (/Execution aborted|aborted/i.test(message)) return false;
  return true;
}
