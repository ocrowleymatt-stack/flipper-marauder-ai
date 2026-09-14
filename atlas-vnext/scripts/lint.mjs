#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const forbiddenNames = new Set(['pom.xml', 'build.gradle', 'build.gradle.kts']);
const forbiddenExt = ['.java', '.kt', '.groovy'];
const skip = new Set(['node_modules', 'dist', 'coverage', '.git']);
const hits = [];

function visit(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (skip.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      visit(full);
      continue;
    }
    if (forbiddenNames.has(entry) || forbiddenExt.some((ext) => entry.endsWith(ext))) {
      hits.push(relative(root, full));
    }
  }
}

visit(root);

if (hits.length > 0) {
  console.error('Lint failed: Java/Spring artefacts are not part of Atlas vNext:\n' + hits.join('\n'));
  process.exit(1);
}

console.log('lint: no Java/Spring artefacts in atlas-vnext');
