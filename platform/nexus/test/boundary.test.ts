import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

describe('Nexus boundary', () => {
  it('does not mention dungeon domains or fetch providers', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '../src');
    const body = walk(src).map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(body).not.toMatch(/dungeons\/writing|osint|investigation|website studio|caspa/i);
    expect(body).not.toMatch(/\bfetch\s*\(/);
  });
});
