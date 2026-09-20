#!/usr/bin/env tsx
/**
 * Apply freeze-era schema migrations (001–009) to ATLAS_DATABASE_URL.
 * Read-only cutover preflight does not migrate; CI and operators must apply
 * this first against an empty cluster. Refuses production without
 * ATLAS_ALLOW_MIGRATE=1. Does not deploy, change DNS, or overlay live data.
 */
import pg from 'pg';
import { isProductionEnv } from '../apps/host/src/production-config.ts';
import { CURRENT_SCHEMA_VERSION, loadMigrations, migrate } from '../platform/persistence/src/postgres/migrate.ts';
import { readDeployedSchemaVersion } from './cas-integrity.ts';

export async function runMigrate(
  env: Record<string, string | undefined> = process.env,
): Promise<{ ok: true; schemaVersion: number; applied: number[]; skipped: number[] }> {
  const databaseUrl = env.ATLAS_DATABASE_URL?.trim() || env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('ATLAS_DATABASE_URL is required.');
  if (isProductionEnv(env) && env.ATLAS_ALLOW_MIGRATE !== '1') {
    throw new Error('Refusing production migrate without ATLAS_ALLOW_MIGRATE=1.');
  }
  const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 8_000 });
  try {
    const result = await migrate(pool, loadMigrations());
    const schemaVersion = await readDeployedSchemaVersion(databaseUrl);
    if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
      throw new Error(`After migrate, schema version is ${schemaVersion}, expected ${CURRENT_SCHEMA_VERSION}.`);
    }
    return { ok: true, schemaVersion, applied: result.applied, skipped: result.skipped };
  } finally {
    await pool.end();
  }
}

const invoked = process.argv[1]?.includes('migrate-atlas');
if (invoked) {
  try {
    const result = await runMigrate(process.env);
    console.log(JSON.stringify(result));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
