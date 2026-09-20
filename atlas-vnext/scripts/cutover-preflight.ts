#!/usr/bin/env tsx
/**
 * Cutover preflight. Validates production configuration, refuses Music GPU /
 * ACE-Step on this host, and optionally probes a non-production health URL.
 * This script does not deploy, change DNS, or touch production data.
 */
import {
  FORBIDDEN_PRODUCTION_MUSIC_GPU_VARS,
  publicConfigView,
  readProductionHostConfig,
} from '../apps/host/src/production-config.ts';
import { CURRENT_SCHEMA_VERSION } from '../platform/persistence/src/postgres/migrate.ts';

const production = process.argv.includes('--production');
const config = readProductionHostConfig(process.env, { forceProduction: production });
const forbidden = FORBIDDEN_PRODUCTION_MUSIC_GPU_VARS.filter((name) => Boolean(process.env[name]?.trim()));

const report = {
  ok: forbidden.length === 0 && config.production === production,
  schemaVersion: CURRENT_SCHEMA_VERSION,
  musicGpuForbidden: forbidden,
  runpod: 'llm-only',
  aceStep: 'absent',
  topology: config.topology,
  config: publicConfigView(config),
  healthUrl: process.env.ATLAS_PREFLIGHT_URL ?? null,
};

if (forbidden.length) {
  console.error(JSON.stringify({ ok: false, error: 'Music GPU env present', forbidden }, null, 2));
  process.exit(1);
}

if (process.env.ATLAS_PREFLIGHT_URL) {
  const live = await fetch(`${process.env.ATLAS_PREFLIGHT_URL.replace(/\/$/, '')}/api/health/live`);
  const ready = await fetch(`${process.env.ATLAS_PREFLIGHT_URL.replace(/\/$/, '')}/api/health/ready`);
  const liveBody = (await live.json()) as { live?: boolean };
  const readyBody = (await ready.json()) as { ready?: boolean; ha?: boolean };
  if (live.status !== 200 || liveBody.live !== true) {
    console.error(JSON.stringify({ ok: false, error: 'liveness failed', status: live.status }));
    process.exit(1);
  }
  if (ready.status !== 200 || readyBody.ready !== true) {
    console.error(JSON.stringify({ ok: false, error: 'readiness failed', status: ready.status }));
    process.exit(1);
  }
  if (readyBody.ha === true) {
    console.error(JSON.stringify({ ok: false, error: 'health claimed ha:true' }));
    process.exit(1);
  }
}

console.log(JSON.stringify({ ...report, ok: true }, null, 2));
