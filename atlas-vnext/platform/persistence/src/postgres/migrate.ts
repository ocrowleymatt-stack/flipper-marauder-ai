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

export const CURRENT_SCHEMA_VERSION = 2;

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
    loaded.push({
      version,
      name: filename.replace(/\.sql$/, ''),
      filename,
      sql,
      checksum: checksumSql(sql),
    });
  }
  for (let i = 0; i < loaded.length; i += 1) {
    const expected = i + 1;
    if (loaded[i]?.version !== expected) {
      throw new MigrationError(`Migrations must be contiguous from 1; expected ${expected}, got ${String(loaded[i]?.version)}`);
    }
  }
  return loaded;
}

export function checksumSql(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

export async function migrate(poolOrClient: pg.Pool | pg.PoolClient, migrations = loadMigrations()): Promise<{
  applied: number[];
  skipped: number[];
}> {
  const ownsClient = isPool(poolOrClient);
  const client = ownsClient ? await poolOrClient.connect() : poolOrClient;
  try {
    return await migrateOnClient(client, migrations);
  } finally {
    if (ownsClient) client.release();
  }
}

function isPool(value: pg.Pool | pg.PoolClient): value is pg.Pool {
  return 'totalCount' in value;
}

async function migrateOnClient(client: pg.PoolClient | pg.Pool, migrations: MigrationFile[]): Promise<{
  applied: number[];
  skipped: number[];
}> {
  logPlatform('migration.start', { count: migrations.length });
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        checksum TEXT NOT NULL
      )
    `);
    const appliedRows = await client.query<{ version: number; checksum: string; name: string }>(
      'SELECT version, checksum, name FROM schema_migrations ORDER BY version',
    );
    const appliedMap = new Map(appliedRows.rows.map((row) => [Number(row.version), row]));
    const applied: number[] = [];
    const skipped: number[] = [];

    for (const migration of migrations) {
      const existing = appliedMap.get(migration.version);
      if (existing) {
        if (existing.checksum !== migration.checksum) {
          throw new MigrationError(
            `Migration ${migration.version} checksum mismatch; refusing to mutate an applied schema.`,
            migration.version,
          );
        }
        skipped.push(migration.version);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [migration.version, migration.name, migration.checksum],
        );
        await client.query('COMMIT');
        applied.push(migration.version);
        logPlatform('migration.success', { version: migration.version, name: migration.name });
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore
        }
        logPlatform(
          'migration.failure',
          {
            version: migration.version,
            name: migration.name,
            error: err instanceof Error ? err.message : String(err),
          },
          'error',
        );
        throw new MigrationError(
          `Migration ${migration.version} (${migration.name}) failed: ${err instanceof Error ? err.message : String(err)}`,
          migration.version,
        );
      }
    }
    return { applied, skipped };
  } catch (err) {
    if (err instanceof MigrationError) throw err;
    logPlatform('migration.failure', { error: err instanceof Error ? err.message : String(err) }, 'error');
    throw err;
  }
}

export async function ensureSchema(client: pg.Pool | pg.PoolClient, schema: string): Promise<void> {
  const ident = assertIdent(schema);
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${ident}`);
}
