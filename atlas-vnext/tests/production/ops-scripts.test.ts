import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runBackup } from '../../scripts/backup-atlas.ts';
import { runMigrate } from '../../scripts/migrate-atlas.ts';
import { runRestore } from '../../scripts/restore-atlas.ts';
import { postgresUrl } from '../../platform/persistence/tests/postgres/harness.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hasPostgres = Boolean(process.env.ATLAS_DATABASE_URL || process.env.DATABASE_URL || postgresUrl());

describe('operator backup/restore/preflight scripts', () => {
  it('backup refuses missing destinations and production without an explicit allow', async () => {
    await expect(runBackup({})).rejects.toThrow(/ATLAS_BACKUP_DIR/);
    await expect(
      runBackup({
        ATLAS_BACKUP_DIR: '/tmp/atlas-backup-test',
        ATLAS_DATABASE_URL: 'postgres://atlas:x@127.0.0.1/atlas',
        ATLAS_CAS_ROOT: '/tmp/missing-cas',
        NODE_ENV: 'production',
      }),
    ).rejects.toThrow(/ATLAS_ALLOW_BACKUP/);
  });

  it('migrate refuses production without an explicit allow', async () => {
    await expect(runMigrate({})).rejects.toThrow(/ATLAS_DATABASE_URL/);
    await expect(
      runMigrate({
        ATLAS_DATABASE_URL: 'postgres://atlas:x@127.0.0.1/atlas',
        NODE_ENV: 'production',
      }),
    ).rejects.toThrow(/ATLAS_ALLOW_MIGRATE/);
  });

  it('restore refuses overlay without ATLAS_RESTORE_NEW_CLUSTER', async () => {
    await expect(runRestore({})).rejects.toThrow(/ATLAS_RESTORE_DIR/);
    await expect(
      runRestore({
        ATLAS_RESTORE_DIR: '/tmp/atlas-restore-test',
        ATLAS_DATABASE_URL: 'postgres://atlas:x@127.0.0.1/atlas',
        ATLAS_CAS_ROOT: '/tmp/cas',
      }),
    ).rejects.toThrow(/ATLAS_RESTORE_NEW_CLUSTER/);
  });

  it('cutover preflight refuses ACE-Step on the LLM host', () => {
    const result = spawnSync(
      resolve(root, 'node_modules/.bin/tsx'),
      [resolve(root, 'scripts/cutover-preflight.ts'), '--production'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          ATLAS_PERSISTENCE: 'postgres',
          ATLAS_DATABASE_URL: 'postgres://atlas:x@127.0.0.1/atlas',
          ATLAS_TENANT_ID: 'tenant_prod',
          ATLAS_SESSION_SECRET: 'session-secret-value-not-real',
          ATLAS_ALLOWED_ORIGINS: 'https://atlas.example',
          ATLAS_CAS_ROOT: '/var/lib/atlas/cas',
          ATLAS_ACE_STEP: '1',
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toMatch(/ACE-Step|Music GPU/i);
  });

  it('cutover preflight fails when the deployed schema cannot be read', () => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      ATLAS_PERSISTENCE: 'postgres',
      ATLAS_DATABASE_URL: 'postgres://atlas:x@127.0.0.1:1/atlas-missing',
      ATLAS_TENANT_ID: 'tenant_prod',
      ATLAS_SESSION_SECRET: 'session-secret-value-not-real',
      ATLAS_ALLOWED_ORIGINS: 'https://atlas.example',
      ATLAS_CAS_ROOT: '/var/lib/atlas/cas',
    };
    delete env.ATLAS_ACE_STEP;
    delete env.ATLAS_MUSIC_GPU;
    delete env.ATLAS_MUSIC_GPU_URL;
    delete env.ACE_STEP_URL;
    delete env.RUNPOD_MUSIC_POD_ID;
    const result = spawnSync(
      resolve(root, 'node_modules/.bin/tsx'),
      [resolve(root, 'scripts/cutover-preflight.ts'), '--production'],
      { cwd: root, encoding: 'utf8', env },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).not.toMatch(/"schemaVersion": 9/);
    expect(`${result.stderr}${result.stdout}`).toMatch(/ok": false/);
  });

  it.skipIf(!hasPostgres)('migrate then preflight against an empty search_path schema', async () => {
    const { randomUUID } = await import('node:crypto');
    const pg = (await import('pg')).default;
    const { dropTestSchema } = await import('../../platform/persistence/tests/postgres/harness.ts');
    const { CURRENT_SCHEMA_VERSION } = await import('../../platform/persistence/src/postgres/migrate.ts');
    const { runCutoverPreflight } = await import('../../scripts/cutover-preflight.ts');
    const schema = `t_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const admin = new pg.Pool({ connectionString: postgresUrl(), connectionTimeoutMillis: 5_000 });
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
    } finally {
      await admin.end();
    }
    try {
      const url = new URL(postgresUrl());
      url.searchParams.set('options', `-c search_path=${schema}`);
      const migrated = await runMigrate({ ATLAS_DATABASE_URL: url.toString() });
      expect(migrated.ok).toBe(true);
      expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(migrated.applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      const report = (await runCutoverPreflight(
        {
          ATLAS_PERSISTENCE: 'postgres',
          ATLAS_DATABASE_URL: url.toString(),
          ATLAS_TENANT_ID: 'tenant_prod',
          ATLAS_SESSION_SECRET: 'session-secret-value-not-real',
          ATLAS_ALLOWED_ORIGINS: 'https://atlas.example',
          ATLAS_CAS_ROOT: '/var/lib/atlas/cas',
        },
        { production: true },
      )) as { ok: boolean; schemaVersion: number };
      expect(report.ok).toBe(true);
      expect(report.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      await dropTestSchema(schema);
    }
  });

  it.skipIf(!hasPostgres)('cutover preflight reads schema_migrations from ATLAS_DATABASE_URL', async () => {
    const { openTestKernel } = await import('../../platform/persistence/tests/postgres/harness.ts');
    const { CURRENT_SCHEMA_VERSION } = await import('../../platform/persistence/src/postgres/migrate.ts');
    const { runCutoverPreflight } = await import('../../scripts/cutover-preflight.ts');
    const kernel = await openTestKernel();
    try {
      const url = new URL(postgresUrl());
      url.searchParams.set('options', `-c search_path=${kernel.schema}`);
      const report = (await runCutoverPreflight(
        {
          ATLAS_PERSISTENCE: 'postgres',
          ATLAS_DATABASE_URL: url.toString(),
          ATLAS_TENANT_ID: 'tenant_prod',
          ATLAS_SESSION_SECRET: 'session-secret-value-not-real',
          ATLAS_ALLOWED_ORIGINS: 'https://atlas.example',
          ATLAS_CAS_ROOT: '/var/lib/atlas/cas',
        },
        { production: true },
      )) as { ok: boolean; schemaVersion: number; aceStep: string; runpod: string };
      expect(report.ok).toBe(true);
      expect(report.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(report.aceStep).toBe('absent');
      expect(report.runpod).toBe('llm-only');
    } finally {
      await kernel.close();
    }
  });
});
