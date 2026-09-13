import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_CATALOG,
  CONTRACT_NAMES,
  CONTRACT_VERSION,
  buildJsonSchema,
  buildSchemaBundle,
  diffSchemaBundle,
  hasDrift,
} from '../src/index.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaDir = join(packageRoot, 'schema');

function readCommittedSchemas(): Map<string, string> {
  const onDisk = new Map<string, string>();
  if (!existsSync(schemaDir)) return onDisk;
  for (const entry of readdirSync(schemaDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      onDisk.set(entry.name, readFileSync(join(schemaDir, entry.name), 'utf8'));
    }
  }
  return onDisk;
}

/**
 * The contract surface Workstream A documents. If a name is removed from this
 * list the design gate has regressed, so the list is asserted rather than
 * derived.
 */
const REQUIRED_CONTRACTS = [
  'BlobRef',
  'CapabilityToken',
  'Command',
  'Event',
  'Job',
  'ModuleManifest',
  'Project',
  'ProvenanceRecord',
] as const;

describe('contract catalog', () => {
  it('publishes every contract the design gate requires', () => {
    for (const name of REQUIRED_CONTRACTS) {
      expect(CONTRACT_NAMES, `missing contract: ${name}`).toContain(name);
    }
  });

  it('keys the catalog in a stable, sorted order so schema/index.json diffs stay readable', () => {
    expect(CONTRACT_NAMES).toEqual([...CONTRACT_NAMES].sort());
  });

  it('exposes a parseable zod schema for every catalog entry', () => {
    for (const name of CONTRACT_NAMES) {
      expect(typeof CONTRACT_CATALOG[name].safeParse).toBe('function');
    }
  });
});

describe('emitted JSON Schema', () => {
  it('stamps every schema with the contract version and a 2020-12 dialect', () => {
    for (const name of CONTRACT_NAMES) {
      const schema = buildJsonSchema(name);
      expect(schema['x-atlas-contract-version']).toBe(CONTRACT_VERSION);
      expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(schema['title']).toBe(name);
    }
  });

  it('is deterministic across runs, so drift detection is meaningful', () => {
    const a = buildSchemaBundle();
    const b = buildSchemaBundle();
    expect(a.indexContents).toBe(b.indexContents);
    expect(a.schemas.map((s) => s.sha256)).toEqual(b.schemas.map((s) => s.sha256));
  });

  it('matches the committed schema/ directory (same check as `pnpm contracts:check`)', () => {
    const drift = diffSchemaBundle(buildSchemaBundle(), readCommittedSchemas());
    expect(
      hasDrift(drift),
      `committed schemas have drifted: ${JSON.stringify(drift)}. Run \`pnpm contracts:generate\`.`,
    ).toBe(false);
  });

  it('reports drift when a committed file is tampered with', () => {
    const bundle = buildSchemaBundle();
    const onDisk = readCommittedSchemas();
    const first = bundle.schemas[0];
    expect(first).toBeDefined();
    onDisk.set(first!.file, '{"tampered": true}\n');
    onDisk.set('Orphaned.schema.json', '{}\n');
    onDisk.delete(bundle.indexFile);

    const drift = diffSchemaBundle(bundle, onDisk);
    expect(drift.changed).toContain(first!.file);
    expect(drift.unexpected).toContain('Orphaned.schema.json');
    expect(drift.missing).toContain(bundle.indexFile);
    expect(hasDrift(drift)).toBe(true);
  });
});
