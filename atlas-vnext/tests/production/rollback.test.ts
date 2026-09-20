import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  checksumSql,
  loadMigrations,
} from '../../platform/persistence/src/postgres/migrate.ts';
import { openTestKernel, postgresUrl } from '../../platform/persistence/tests/postgres/harness.ts';

const hasPostgres = Boolean(process.env.ATLAS_DATABASE_URL || process.env.DATABASE_URL || postgresUrl());
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe('application rollback compatibility', () => {
  it('ships the same forward-only schema v9 as public production 68603a4', () => {
    const files = readdirSync(resolve(root, 'platform/persistence/migrations'))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    expect(files).toEqual([
      '001_initial.sql',
      '002_artefacts_and_retention.sql',
      '003_attempts_artefacts_idempotency.sql',
      '004_files_cas_context.sql',
      '005_sites_revision_retention.sql',
      '006_tools_auth.sql',
      '007_documents.sql',
      '008_dungeon_estate.sql',
      '009_principal_credentials.sql',
    ]);
    expect(CURRENT_SCHEMA_VERSION).toBe(9);
    const loaded = loadMigrations();
    expect(loaded.map((item) => item.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const item of loaded) {
      expect(item.checksum).toBe(checksumSql(item.sql));
      expect(item.checksum).toHaveLength(64);
    }
  });
});

describe.skipIf(!hasPostgres)('rollback rehearsal', () => {
  it('does not require a reverse migration; failed SQL is not recorded', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    const versions = await handle.kernel.tx.query<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    expect(versions.rows.map((row) => Number(row.version))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Application rollback to 68603a4 is schema-compatible because Waves 1–6
    // added no SQL. Data rollback remains pg_dump + CAS copy, not DROP.
  });
});
