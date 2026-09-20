#!/usr/bin/env tsx
/**
 * Cutover preflight. Validates production configuration, refuses Music GPU /
 * ACE-Step on this host, reads the deployed schema_migrations version from
 * ATLAS_DATABASE_URL, and optionally probes a non-production health URL.
 * This script does not deploy, change DNS, or touch production data.
 */
import {
  FORBIDDEN_PRODUCTION_MUSIC_GPU_VARS,
  publicConfigView,
  readProductionHostConfig,
} from '../apps/host/src/production-config.ts';
import { CURRENT_SCHEMA_VERSION } from '../platform/persistence/src/postgres/migrate.ts';
import { readDeployedSchemaVersion } from './cas-integrity.ts';

export async function runCutoverPreflight(
  env: Record<string, string | undefined> = process.env,
  options: { production?: boolean } = {},
): Promise<Record<string, unknown>> {
  const production = options.production === true;
  const config = readProductionHostConfig(env, { forceProduction: production });
  const forbidden = FORBIDDEN_PRODUCTION_MUSIC_GPU_VARS.filter((name) => Boolean(env[name]?.trim()));
  if (forbidden.length) {
    throw Object.assign(new Error('Music GPU env present'), { forbidden });
  }

  const databaseUrl = env.ATLAS_DATABASE_URL?.trim() || env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('ATLAS_DATABASE_URL is required to read the deployed schema version.');
  const schemaVersion = await readDeployedSchemaVersion(databaseUrl);
  if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Deployed schema version is ${schemaVersion}, expected ${CURRENT_SCHEMA_VERSION}.`,
    );
  }

  if (env.ATLAS_PREFLIGHT_URL) {
    const base = env.ATLAS_PREFLIGHT_URL.replace(/\/$/, '');
    const live = await fetch(`${base}/api/health/live`);
    const ready = await fetch(`${base}/api/health/ready`);
    const liveBody = (await live.json()) as { live?: boolean };
    const readyBody = (await ready.json()) as { ready?: boolean; ha?: boolean };
    if (live.status !== 200 || liveBody.live !== true) {
      throw new Error(`liveness failed (${live.status})`);
    }
    if (ready.status !== 200 || readyBody.ready !== true) {
      throw new Error(`readiness failed (${ready.status})`);
    }
    if (readyBody.ha === true) {
      throw new Error('health claimed ha:true');
    }
  }

  return {
    ok: true,
    schemaVersion,
    expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
    musicGpuForbidden: forbidden,
    runpod: 'llm-only',
    aceStep: 'absent',
    topology: config.topology,
    config: publicConfigView(config),
    healthUrl: env.ATLAS_PREFLIGHT_URL ?? null,
  };
}

const invoked = process.argv[1]?.includes('cutover-preflight');
if (invoked) {
  try {
    const report = await runCutoverPreflight(process.env, { production: process.argv.includes('--production') });
    console.log(JSON.stringify(report, null, 2));
  } catch (err) {
    const forbidden = err && typeof err === 'object' && 'forbidden' in err ? (err as { forbidden: string[] }).forbidden : undefined;
    console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err), forbidden }, null, 2));
    process.exit(1);
  }
}
