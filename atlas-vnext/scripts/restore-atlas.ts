#!/usr/bin/env tsx
/**
 * Restore PostgreSQL + CAS onto a NEW cluster. Refuses to overlay a live
 * schema unless ATLAS_RESTORE_NEW_CLUSTER=1 is set. After copy, every
 * restored metadata CAS pointer is hash-verified before success.
 *
 *   ATLAS_DATABASE_URL=... ATLAS_CAS_ROOT=... ATLAS_RESTORE_DIR=... \
 *     ATLAS_RESTORE_NEW_CLUSTER=1 npx tsx scripts/restore-atlas.ts
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { isProductionEnv } from '../apps/host/src/production-config.ts';
import type { BackupManifest } from './backup-atlas.ts';
import { listCasHashes, verifyCasObjects } from './cas-integrity.ts';

export async function runRestore(env: Record<string, string | undefined> = process.env): Promise<{ ok: true; schemaVersion: number; casObjects: number }> {
  const restoreDir = env.ATLAS_RESTORE_DIR?.trim();
  const databaseUrl = env.ATLAS_DATABASE_URL?.trim() || env.DATABASE_URL?.trim();
  const casRoot = env.ATLAS_CAS_ROOT?.trim();
  if (!restoreDir) throw new Error('ATLAS_RESTORE_DIR is required.');
  if (!databaseUrl) throw new Error('ATLAS_DATABASE_URL is required.');
  if (!casRoot) throw new Error('ATLAS_CAS_ROOT is required.');
  if (env.ATLAS_RESTORE_NEW_CLUSTER !== '1') {
    throw new Error('Refusing restore onto an unspecified cluster. Set ATLAS_RESTORE_NEW_CLUSTER=1 for a new empty target.');
  }
  if (isProductionEnv(env) && env.ATLAS_ALLOW_RESTORE !== '1') {
    throw new Error('Refusing production restore without ATLAS_ALLOW_RESTORE=1.');
  }
  const manifestPath = join(restoreDir, 'manifest.json');
  const dumpPath = join(restoreDir, 'atlas.sql');
  const casDir = join(restoreDir, 'cas');
  if (!existsSync(manifestPath) || !existsSync(dumpPath) || !existsSync(casDir)) {
    throw new Error('Restore directory is missing manifest.json, atlas.sql, or cas/.');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest;
  const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    const existing = await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_name = 'schema_migrations'
       ) AS present`,
    );
    if (existing.rows[0]?.present === true) {
      const count = await pool.query('SELECT COUNT(*)::int AS n FROM schema_migrations');
      if (Number(count.rows[0]?.n) > 0 && env.ATLAS_RESTORE_OVERWRITE !== '1') {
        throw new Error('Target already has schema_migrations. Restore onto a new cluster.');
      }
    }
  } finally {
    await pool.end();
  }
  const restore = spawnSync('psql', ['--dbname', databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', dumpPath], {
    encoding: 'utf8',
  });
  if (restore.status !== 0) {
    throw new Error(`psql restore failed: ${restore.stderr || restore.stdout || restore.status}`);
  }
  cpSync(casDir, casRoot, { recursive: true });
  const restored = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  const client = await restored.connect();
  try {
    const hashes = [...new Set([...(manifest.casHashes ?? []), ...(await listCasHashes(client))])].sort();
    await verifyCasObjects(casRoot, hashes);
    return { ok: true, schemaVersion: manifest.schemaVersion, casObjects: hashes.length };
  } finally {
    client.release();
    await restored.end();
  }
}

const invoked = process.argv[1]?.includes('restore-atlas');
if (invoked) {
  try {
    const result = await runRestore(process.env);
    console.log(JSON.stringify(result));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
