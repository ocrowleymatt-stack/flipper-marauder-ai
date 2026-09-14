import type { ClassifiedFailure } from '@atlas-vnext/contracts';
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
  const classified = classifyHttpStatus(status, safeBody);
  return {
    code: classified.code,
    message: `${provider} HTTP ${status}${safeBody ? `: ${safeBody}` : ''}`,
    retryable: classified.retryable,
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

/**
 * Mountain-compat retry classification (specified):
 * timeout/reset/429/5xx → transient, bounded retry;
 * 400/401/unsupported/permission/context overflow → terminal.
 */
export function classifyProviderFailure(err: unknown): ClassifiedFailure {
  if (err instanceof ProviderHttpError) {
    return {
      retryClass: err.failure.retryable ? 'transient' : 'terminal',
      code: err.failure.code,
      retryable: err.failure.retryable,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/Execution aborted|\baborted\b/i.test(message)) {
    return { retryClass: 'terminal', code: 'cancelled', retryable: false };
  }
  if (/context (length|overflow|window)|maximum context|prompt size|exceeds context/i.test(message)) {
    return { retryClass: 'terminal', code: 'context_overflow', retryable: false };
  }
  if (/unsupported|not implemented/i.test(message)) {
    return { retryClass: 'terminal', code: 'unsupported', retryable: false };
  }
  if (/permission denied|forbidden|\b403\b/i.test(message)) {
    return { retryClass: 'terminal', code: 'permission_denied', retryable: false };
  }
  if (/missing credentials|authentication_failure|unauthorized|\b401\b/i.test(message)) {
    return { retryClass: 'terminal', code: 'authentication_failure', retryable: false };
  }
  if (/\b400\b|bad request|invalid_request/i.test(message)) {
    return { retryClass: 'terminal', code: 'invalid_request', retryable: false };
  }
  if (
    /timeout|etimedout|econnreset|\breset\b|429|rate.?limit|503|502|500|unavailable|connection failed/i.test(
      message,
    )
  ) {
    return { retryClass: 'transient', code: 'transient', retryable: true };
  }
  return { retryClass: 'transient', code: 'provider_error', retryable: true };
}

/** Auth failures are not retried on the same provider; 429/5xx and transport blips are. */
export function isRetryableError(err: unknown): boolean {
  return classifyProviderFailure(err).retryable;
}

function classifyHttpStatus(status: number, body: string): { code: string; retryable: boolean } {
  if (status === 408 || status === 409 || status === 429 || status >= 500) {
    return {
      code:
        status === 429
          ? 'rate_limited'
          : status >= 500
            ? 'provider_unavailable'
            : 'provider_unavailable',
      retryable: true,
    };
  }
  if (status === 401 || status === 403) {
    return { code: 'authentication_failure', retryable: false };
  }
  if (status === 404) {
    return { code: 'not_found', retryable: false };
  }
  if (status === 400 && /context (length|overflow|window)|maximum context|too many tokens/i.test(body)) {
    return { code: 'context_overflow', retryable: false };
  }
  if (status === 400 && /unsupported/i.test(body)) {
    return { code: 'unsupported', retryable: false };
  }
  return { code: 'provider_error', retryable: false };
}
