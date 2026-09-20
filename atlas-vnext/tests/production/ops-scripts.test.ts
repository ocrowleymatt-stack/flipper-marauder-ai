import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runBackup } from '../../scripts/backup-atlas.ts';
import { runRestore } from '../../scripts/restore-atlas.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('operator backup/restore/preflight scripts', () => {
  it('backup refuses missing destinations and production without an explicit allow', () => {
    expect(() => runBackup({})).toThrow(/ATLAS_BACKUP_DIR/);
    expect(() =>
      runBackup({
        ATLAS_BACKUP_DIR: '/tmp/atlas-backup-test',
        ATLAS_DATABASE_URL: 'postgres://atlas:x@127.0.0.1/atlas',
        ATLAS_CAS_ROOT: '/tmp/missing-cas',
        NODE_ENV: 'production',
      }),
    ).toThrow(/ATLAS_ALLOW_BACKUP/);
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

  it('cutover preflight accepts the production contract without Music GPU', () => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      ATLAS_PERSISTENCE: 'postgres',
      ATLAS_DATABASE_URL: 'postgres://atlas:x@127.0.0.1/atlas',
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
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const body = JSON.parse(result.stdout) as { ok: boolean; aceStep: string; runpod: string; schemaVersion: number };
    expect(body.ok).toBe(true);
    expect(body.aceStep).toBe('absent');
    expect(body.runpod).toBe('llm-only');
    expect(body.schemaVersion).toBe(9);
  });
});
