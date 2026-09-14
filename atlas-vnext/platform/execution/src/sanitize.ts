const SECRET_PATTERN =
  /(sk-[a-zA-Z0-9_-]{8,}|xai-[a-zA-Z0-9_-]{8,}|Bearer\s+\S+|x-api-key["'\s:=]+[^\s"']+|AIza[0-9A-Za-z_-]{20,}|venice[_-]?api[_-]?key["'\s:=]+[^\s"']+)/gi;

const HEADER_PATTERN = /(authorization|x-api-key|x-goog-api-key|api-key)\s*[:=]\s*("?)[^"\s]+/gi;

/**
 * Strip credentials from error text, logs, and provider bodies.
 * Adapters must pass every external message through this before throwing.
 */
export function sanitizeText(value: string): string {
  return value.replace(SECRET_PATTERN, '[redacted]').replace(HEADER_PATTERN, '$1=[redacted]');
}

export function sanitizeUnknown(value: unknown): string {
  if (value instanceof Error) return sanitizeText(value.message);
  if (typeof value === 'string') return sanitizeText(value);
  try {
    return sanitizeText(JSON.stringify(value));
  } catch {
    return 'unserializable error';
  }
}

export function containsSecret(value: string, secret: string | undefined): boolean {
  if (!secret) return false;
  return value.includes(secret);
}
