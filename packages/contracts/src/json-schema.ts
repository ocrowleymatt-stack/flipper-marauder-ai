import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CONTRACT_CATALOG, CONTRACT_NAMES, type ContractName } from './catalog.js';
import { CONTRACT_VERSION } from './version.js';

export const JSON_SCHEMA_TARGET = 'draft-2020-12';
export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';
export const SCHEMA_ID_BASE = 'https://contracts.atlas.dev';
export const SCHEMA_INDEX_FILE = 'index.json';

export interface EmittedSchema {
  readonly name: ContractName;
  readonly file: string;
  readonly sha256: string;
  /** Canonical on-disk text, newline-terminated. */
  readonly contents: string;
}

export interface SchemaBundle {
  readonly contractVersion: string;
  readonly target: string;
  readonly schemas: readonly EmittedSchema[];
  readonly indexFile: string;
  readonly indexContents: string;
}

export function schemaFileName(name: string): string {
  return `${name}.schema.json`;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Emit the JSON Schema for one contract. Zod is the source of truth; this is a
 * projection of it, which is why it is committed and checked rather than
 * generated on demand — non-TypeScript consumers need a stable artefact.
 */
export function buildJsonSchema(name: ContractName): Record<string, unknown> {
  const projected = z.toJSONSchema(CONTRACT_CATALOG[name], {
    target: JSON_SCHEMA_TARGET,
    io: 'output',
  }) as Record<string, unknown>;

  return {
    $schema: JSON_SCHEMA_DIALECT,
    $id: `${SCHEMA_ID_BASE}/${CONTRACT_VERSION}/${schemaFileName(name)}`,
    title: name,
    'x-atlas-contract-version': CONTRACT_VERSION,
    ...projected,
  };
}

export function buildSchemaBundle(): SchemaBundle {
  const schemas: EmittedSchema[] = CONTRACT_NAMES.map((name) => {
    const contents = canonicalJson(buildJsonSchema(name));
    return { name, file: schemaFileName(name), sha256: sha256Hex(contents), contents };
  });

  const indexContents = canonicalJson({
    contractVersion: CONTRACT_VERSION,
    jsonSchemaTarget: JSON_SCHEMA_TARGET,
    generatedBy: '@atlas/contracts — pnpm contracts:generate',
    schemas: schemas.map(({ name, file, sha256 }) => ({ name, file, sha256 })),
  });

  return {
    contractVersion: CONTRACT_VERSION,
    target: JSON_SCHEMA_TARGET,
    schemas,
    indexFile: SCHEMA_INDEX_FILE,
    indexContents,
  };
}

export interface SchemaDrift {
  /** Expected files that are absent from disk. */
  readonly missing: readonly string[];
  /** Files on disk that the catalog no longer produces. */
  readonly unexpected: readonly string[];
  /** Files whose committed contents differ from the source of truth. */
  readonly changed: readonly string[];
}

export function hasDrift(drift: SchemaDrift): boolean {
  return drift.missing.length > 0 || drift.unexpected.length > 0 || drift.changed.length > 0;
}

/**
 * Compare a freshly built bundle against what is committed. `onDisk` maps a
 * file name inside `schema/` to its exact text contents.
 */
export function diffSchemaBundle(
  bundle: SchemaBundle,
  onDisk: ReadonlyMap<string, string>,
): SchemaDrift {
  const expected = new Map<string, string>([[bundle.indexFile, bundle.indexContents]]);
  for (const schema of bundle.schemas) {
    expected.set(schema.file, schema.contents);
  }

  const missing: string[] = [];
  const changed: string[] = [];
  for (const [file, contents] of expected) {
    const actual = onDisk.get(file);
    if (actual === undefined) {
      missing.push(file);
    } else if (actual !== contents) {
      changed.push(file);
    }
  }

  const unexpected = [...onDisk.keys()].filter((file) => !expected.has(file)).sort();

  return { missing: missing.sort(), unexpected, changed: changed.sort() };
}
