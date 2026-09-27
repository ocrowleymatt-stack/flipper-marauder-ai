import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { logPlatform } from '@atlas-vnext/observability';
import { MigrationError } from '../errors.ts';
import { assertIdent } from './tx.ts';

export interface MigrationFile {
  version: number;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

export const CURRENT_SCHEMA_VERSION = 10;

/**
 * Session-level lock shared by every Atlas process on this database.
 * Parallel test schemas and multi-instance boots must not interleave DDL
 * against PostgreSQL catalogs (CREATE/DROP SCHEMA, CREATE TABLE).
 */
export const ATLAS_POSTGRES_DDL_LOCK = 415_641_511;

export async function withPostgresDdlLock<T>(client: pg.PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query('SELECT pg_advisory_lock($1)', [ATLAS_POSTGRES_DDL_LOCK]);
  try {
    return await fn();
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ATLAS_POSTGRES_DDL_LOCK]);
  }
}

export function defaultMigrationsDir(): string {
  return fileURLToPath(new URL('../../migrations', import.meta.url));
}

export function loadMigrations(dir = defaultMigrationsDir()): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort();
  const loaded: MigrationFile[] = [];
  for (const filename of files) {
    const version = Number(filename.split('_')[0]);
    if (!Number.isInteger(version) || version <= 0) {
      throw new MigrationError(`Invalid migration filename ${filename}`);
    }
    const sql = readFileSync(join(dir, filename), 'utf8');
    loaded.push({ version, name: filename.replace(/^\d+_/, '').replace(/\.sql$/, ''), filename, sql, checksum: checksumSql(sql) });
  }
  return loaded;
}

export function checksumSql(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

export async function migrate(client: pg.PoolClient, migrations = loadMigrations()): Promise<{ applied: number[]; skipped: number[] }> {
  const applied: number[] = [];
  const skipped: number[] = [];
  await withPostgresDdlLock(client, async () => {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      checksum TEXT NOT NULL
    )`);
    for (const migration of migrations) {
      const existing = await client.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE version = $1', [migration.version]);
      if (existing.rowCount) {
        if (existing.rows[0]?.checksum !== migration.checksum) throw new MigrationError(`Migration ${migration.version} checksum mismatch`);
        skipped.push(migration.version);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [migration.version, migration.name, migration.checksum]);
        await client.query('COMMIT');
        applied.push(migration.version);
        logPlatform('info', 'persistence.migration.applied', { version: migration.version, name: migration.name });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  });
  return { applied, skipped };
}
