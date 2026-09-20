#!/usr/bin/env tsx
/**
 * Operator backup: pg_dump of PostgreSQL + copy of the CAS root.
 * Does not dump secrets. Does not target a live overlay.
 *
 *   ATLAS_DATABASE_URL=... ATLAS_CAS_ROOT=... ATLAS_BACKUP_DIR=... \
 *     npx tsx scripts/backup-atlas.ts
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readProductionHostConfig, isProductionEnv } from '../apps/host/src/production-config.ts';

export interface BackupManifest {
  createdAt: string;
  schemaVersion: number;
  postgresDump: string;
  casDir: string;
  casRoot: string;
}

export function runBackup(env: Record<string, string | undefined> = process.env): BackupManifest {
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
  const dump = spawnSync('pg_dump', ['--no-owner', '--no-acl', '--dbname', databaseUrl, '-f', dumpPath], {
    encoding: 'utf8',
  });
  if (dump.status !== 0) {
    throw new Error(`pg_dump failed: ${dump.stderr || dump.stdout || dump.status}`);
  }
  if (!existsSync(casRoot)) throw new Error(`CAS root missing: ${casRoot}`);
  cpSync(casRoot, casDir, { recursive: true });
  const manifest: BackupManifest = {
    createdAt: new Date().toISOString(),
    schemaVersion: 9,
    postgresDump: dumpPath,
    casDir,
    casRoot,
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
    const manifest = runBackup(process.env);
    console.log(JSON.stringify({ ok: true, manifest: { createdAt: manifest.createdAt, schemaVersion: manifest.schemaVersion } }));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
