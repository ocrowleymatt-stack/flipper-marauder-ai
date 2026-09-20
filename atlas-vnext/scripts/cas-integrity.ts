import pg from 'pg';
import { FilesystemCas } from '../platform/storage/src/fs-cas.ts';
import { SHA256_HEX } from '../platform/storage/src/cas.ts';

function quoteIdent(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid SQL identifier: ${value}`);
  }
  return `"${value}"`;
}

const HASH_SOURCES: Array<{ table: string; column: string }> = [
  { table: 'cas_objects', column: 'sha256' },
  { table: 'cas_refs', column: 'sha256' },
  { table: 'artefact_metadata', column: 'content_hash' },
  { table: 'files', column: 'content_hash' },
  { table: 'chunks', column: 'content_hash' },
  { table: 'documents', column: 'current_content_hash' },
  { table: 'documents', column: 'draft_content_hash' },
  { table: 'document_versions', column: 'content_hash' },
  { table: 'dungeon_records', column: 'content_hash' },
  { table: 'site_revision_entries', column: 'content_hash' },
];

export async function listCasHashes(client: pg.PoolClient): Promise<string[]> {
  const tables = await client.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = ANY (current_schemas(false))`,
  );
  const present = new Set(tables.rows.map((row) => row.table_name));
  const hashes = new Set<string>();
  for (const source of HASH_SOURCES) {
    if (!present.has(source.table)) continue;
    const rows = await client.query<{ hash: string | null }>(
      `SELECT DISTINCT ${quoteIdent(source.column)} AS hash FROM ${quoteIdent(source.table)}`,
    );
    for (const row of rows.rows) {
      const hash = row.hash?.trim().toLowerCase();
      if (hash && SHA256_HEX.test(hash)) hashes.add(hash);
    }
  }
  return [...hashes].sort();
}

export async function verifyCasObjects(casRoot: string, hashes: string[]): Promise<void> {
  const cas = new FilesystemCas({ root: casRoot });
  const missing: string[] = [];
  for (const hash of hashes) {
    try {
      await cas.get(hash);
    } catch {
      missing.push(hash);
    }
  }
  if (missing.length) {
    throw new Error(`CAS integrity failed for ${missing.length} object(s): ${missing.slice(0, 3).join(', ')}`);
  }
}

export async function readDeployedSchemaVersion(databaseUrl: string): Promise<number> {
  const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    const present = await pool.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = ANY (current_schemas(false))
           AND table_name = 'schema_migrations'
       ) AS present`,
    );
    if (present.rows[0]?.present !== true) return 0;
    const versions = await pool.query<{ n: number }>(
      'SELECT COALESCE(MAX(version), 0)::int AS n FROM schema_migrations',
    );
    return Number(versions.rows[0]?.n ?? 0);
  } finally {
    await pool.end();
  }
}
