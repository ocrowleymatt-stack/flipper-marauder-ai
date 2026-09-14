import { ExtractionError } from '../errors.ts';
import type { ExtractionResult } from './types.ts';
import { decodeUtf8 } from './text.ts';

function flatten(value: unknown, prefix: string, rows: Array<{ path: string; text: string }>): void {
  if (value == null) {
    rows.push({ path: prefix || '$', text: 'null' });
    return;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    rows.push({ path: prefix || '$', text: String(value) });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${prefix}[${index}]`, rows));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const next = prefix ? `${prefix}.${key}` : `$.${key}`;
      flatten(child, next, rows);
    }
  }
}

export function extractJson(bytes: Uint8Array, path: string): ExtractionResult {
  const raw = decodeUtf8(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ExtractionError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const rows: Array<{ path: string; text: string }> = [];
  flatten(parsed, '$', rows);
  const blocks = rows.map((row, index) => ({
    text: `${row.path}: ${row.text}`,
    locator: {
      path,
      startOffset: index,
      endOffset: index + 1,
      jsonPath: row.path,
    },
  }));
  return {
    text: blocks.map((block) => block.text).join('\n'),
    blocks,
    pageCount: null,
    structure: { kind: 'json', keys: rows.map((row) => row.path).slice(0, 200) },
  };
}
