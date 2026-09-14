import { posix, resolve, sep } from 'node:path';
import { ToolError } from './errors.ts';

const DEFAULT_ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TERM'];

export function containPath(root: string, candidate: string): string {
  if (!candidate || candidate.includes('\0')) {
    throw new ToolError('path_rejected', 'Fail-closed: path is empty or contains NUL.', false);
  }
  if (posix.isAbsolute(candidate) || candidate.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(candidate)) {
    throw new ToolError('path_rejected', 'Fail-closed: absolute paths are not allowed.', false);
  }
  const normalised = candidate.replace(/\\/g, '/');
  const parts = normalised.split('/');
  if (parts.some((part) => part === '..')) {
    throw new ToolError('path_traversal', 'Fail-closed: path traversal is not allowed.', false);
  }
  const rootResolved = resolve(root);
  const resolved = resolve(rootResolved, normalised);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + sep)) {
    throw new ToolError('path_traversal', 'Fail-closed: path escapes the workspace jail.', false);
  }
  return resolved;
}

export function filterEnv(
  env: Record<string, string | undefined>,
  allowList: string[] = DEFAULT_ENV_ALLOWLIST,
  secretNames: string[] = [],
): Record<string, string> {
  const allow = new Set(allowList);
  const blocked = new Set(secretNames.map((name) => name.toUpperCase()));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (!allow.has(key)) continue;
    if (blocked.has(key.toUpperCase())) continue;
    if (/(SECRET|TOKEN|PASSWORD|API_KEY|DATABASE_URL|CREDENTIAL)/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

export function boundText(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString('utf8');
}
