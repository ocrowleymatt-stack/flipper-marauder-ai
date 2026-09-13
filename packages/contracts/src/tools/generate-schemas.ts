#!/usr/bin/env node
/**
 * Emits the committed JSON Schema projection of the zod contract catalog.
 *
 *   --write   regenerate `packages/contracts/schema/` in place
 *   --check   fail (exit 1) if the committed schemas have drifted
 *
 * `--check` is what CI runs. It is the mechanism that stops the zod schemas and
 * the published JSON Schema from diverging, which would quietly break every
 * non-TypeScript consumer of the contract surface.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSchemaBundle, diffSchemaBundle, hasDrift } from '../json-schema.js';

const here = dirname(fileURLToPath(import.meta.url));
// dist/tools/ -> dist/ -> <package root>
const packageRoot = resolve(here, '..', '..');
const schemaDir = join(packageRoot, 'schema');

function readSchemaDir(): Map<string, string> {
  const onDisk = new Map<string, string>();
  if (!existsSync(schemaDir)) return onDisk;
  for (const entry of readdirSync(schemaDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    onDisk.set(entry.name, readFileSync(join(schemaDir, entry.name), 'utf8'));
  }
  return onDisk;
}

function write(): void {
  const bundle = buildSchemaBundle();
  mkdirSync(schemaDir, { recursive: true });

  const expected = new Set<string>([bundle.indexFile]);
  for (const schema of bundle.schemas) {
    expected.add(schema.file);
    writeFileSync(join(schemaDir, schema.file), schema.contents, 'utf8');
  }
  writeFileSync(join(schemaDir, bundle.indexFile), bundle.indexContents, 'utf8');

  const stale = [...readSchemaDir().keys()].filter((file) => !expected.has(file));
  if (stale.length > 0) {
    console.error(
      `schema/ contains files the catalog no longer produces; delete them:\n  ${stale.join('\n  ')}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `contracts: wrote ${bundle.schemas.length} schema(s) + ${bundle.indexFile} for contract version ${bundle.contractVersion}`,
  );
}

function check(): void {
  const bundle = buildSchemaBundle();
  const drift = diffSchemaBundle(bundle, readSchemaDir());

  if (!hasDrift(drift)) {
    console.log(
      `contracts: ${bundle.schemas.length} committed schema(s) match the source of truth (contract version ${bundle.contractVersion}).`,
    );
    return;
  }

  console.error('contracts: committed JSON Schema has drifted from the zod source of truth.');
  for (const file of drift.missing) console.error(`  missing:    schema/${file}`);
  for (const file of drift.changed) console.error(`  changed:    schema/${file}`);
  for (const file of drift.unexpected) console.error(`  unexpected: schema/${file}`);
  console.error('\nRun `pnpm contracts:generate` and commit the result.');
  process.exitCode = 1;
}

const mode = process.argv[2];
if (mode === '--write') {
  write();
} else if (mode === '--check') {
  check();
} else {
  console.error('usage: generate-schemas.js --write | --check');
  process.exitCode = 2;
}
