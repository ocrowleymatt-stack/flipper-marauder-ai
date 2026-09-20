#!/usr/bin/env tsx
/**
 * Operator backup: pg_dump of PostgreSQL + copy of the CAS root.
 * Uses a REPEATABLE READ snapshot so dump hashes and pg_dump match, then
 * verifies every dumped CAS pointer against the copied blobs before success.
 * Does not dump secrets. Does not target a live overlay.
 *
 *   ATLAS_DATABASE_URL=... ATLAS_CAS_ROOT=... ATLAS_BACKUP_DIR=... \
 *     npx tsx scripts/backup-atlas.ts
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { readProductionHostConfig, isProductionEnv } from '../apps/host/src/production-config.ts';
import { CURRENT_SCHEMA_VERSION } from '../platform/persistence/src/postgres/migrate.ts';
import { listCasHashes, verifyCasObjects } from './cas-integrity.ts';

export interface BackupManifest {
  createdAt: string;
  schemaVersion: number;
  postgresDump: string;
  casDir: string;
  casRoot: string;
  casHashes: string[];
}

export async function runBackup(env: Record<string, string | undefined> = process.env): Promise<BackupManifest> {
  const backupDir = env.ATLAS_BACKUP_DIR?.trim();
  const databaseUrl = env.ATLAS_DATABASE_URL?.trim() || env.DATABASE_URL?.trim();
  const casRoot = env.ATLAS_CAS_ROOT?.trim();
  if (!backupDir) throw new Error('ATLAS_BACKUP_DIR is required.');
  if (!databaseUrl) throw new Error('ATLAS_DATABASE_URL is required.');
  if (!casRoot) throw new Error('ATLAS_CAS_ROOT is required.');
  if (isProductionEnv(env) && env.ATLAS_ALLOW_BACKUP !== '1') {
    throw new Error('Refusing production backup without ATLAS_ALLOW_BACKUP=1.');
  }
  mkdirSync(backupDir, { recursive: true });
  const dumpPath = join(backupDir, 'atlas.sql');
  const casDir = join(backupDir, 'cas');
  if (!existsSync(casRoot)) throw new Error(`CAS root missing: ${casRoot}`);

  const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 8_000 });
  const client = await pool.connect();
  let hashes: string[] = [];
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const snap = await client.query<{ pg_export_snapshot: string }>('SELECT pg_export_snapshot()');
    const snapshot = snap.rows[0]?.pg_export_snapshot;
    if (!snapshot) throw new Error('PostgreSQL snapshot export failed.');
    hashes = await listCasHashes(client);
    const dump = spawnSync(
      'pg_dump',
      ['--no-owner', '--no-acl', '--snapshot', snapshot, '--dbname', databaseUrl, '-f', dumpPath],
      { encoding: 'utf8' },
    );
    if (dump.status !== 0) {
      throw new Error(`pg_dump failed: ${dump.stderr || dump.stdout || dump.status}`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }

  cpSync(casRoot, casDir, { recursive: true });
  await verifyCasObjects(casDir, hashes);
  const manifest: BackupManifest = {
    createdAt: new Date().toISOString(),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    postgresDump: dumpPath,
    casDir,
    casRoot,
    casHashes: hashes,
  };
  writeFileSync(join(backupDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

const invoked = process.argv[1]?.includes('backup-atlas');
if (invoked) {
  try {
    if (process.argv.includes('--preflight')) {
      readProductionHostConfig(process.env, { forceProduction: process.argv.includes('--production') });
      console.log(JSON.stringify({ ok: true, mode: 'preflight' }));
      process.exit(0);
    }
    const manifest = await runBackup(process.env);
    console.log(
      JSON.stringify({
        ok: true,
        manifest: {
          createdAt: manifest.createdAt,
          schemaVersion: manifest.schemaVersion,
          casObjects: manifest.casHashes.length,
        },
      }),
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
