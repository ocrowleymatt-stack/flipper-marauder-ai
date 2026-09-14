import { createHash } from 'node:crypto';

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rec).sort()) out[key] = sortValue(rec[key]);
    return out;
  }
  return value;
}

export function sha256Stable(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}
