const SECRET_PATTERN =
  /(sk-[a-zA-Z0-9_-]{8,}|xai-[a-zA-Z0-9_-]{8,}|Bearer\s+\S+|x-api-key["'\s:=]+[^\s"']+|AIza[0-9A-Za-z_-]{20,}|venice[_-]?api[_-]?key["'\s:=]+[^\s"']+)/gi;

const HEADER_PATTERN = /(authorization|x-api-key|x-goog-api-key|api-key)\s*[:=]\s*("?)[^"\s]+/gi;

/** Minimum length for value-based redaction so short tokens are not wiped from errors. */
const MIN_SECRET_LENGTH = 8;

/**
 * Strip credentials from error text, logs, and provider bodies.
 *
 * Known secret *values* are redacted first. Patterns (sk-, xai-, Bearer, …)
 * are defence in depth only — secrets may have arbitrary formats.
 */
export function sanitizeText(value: string, secrets: Array<string | undefined | null> = []): string {
  let out = value;
  for (const secret of secrets) {
    const trimmed = secret?.trim();
    if (!trimmed || trimmed.length < MIN_SECRET_LENGTH) continue;
    out = out.split(trimmed).join('[redacted]');
  }
  return out.replace(SECRET_PATTERN, '[redacted]').replace(HEADER_PATTERN, '$1=[redacted]');
}

export function sanitizeUnknown(value: unknown, secrets: Array<string | undefined | null> = []): string {
  if (value instanceof Error) return sanitizeText(value.message, secrets);
  if (typeof value === 'string') return sanitizeText(value, secrets);
  try {
    return sanitizeText(JSON.stringify(value), secrets);
  } catch {
    return 'unserializable error';
  }
}

export function containsSecret(value: string, secret: string | undefined): boolean {
  if (!secret) return false;
  return value.includes(secret);
}
