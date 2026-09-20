import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EnvFlagStore, readKillSwitches } from '@atlas-vnext/flags';
import {
  ProductionConfigError,
  parseOrigins,
  publicConfigView,
  readProductionHostConfig,
  readTimeoutContract,
} from '../../apps/host/src/production-config.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function runConfigValidate(args: string[], extraEnv: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, ...extraEnv };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
  }
  return spawnSync(resolve(root, 'node_modules/.bin/tsx'), [resolve(root, 'scripts/validate-config.ts'), ...args], {
    cwd: root,
    env: env as NodeJS.ProcessEnv,
    encoding: 'utf8',
  });
}

describe('production configuration contract', () => {
  it('fails loud on missing critical production config and refuses silent defaults', () => {
    expect(() => readProductionHostConfig({ NODE_ENV: 'production' })).toThrow(ProductionConfigError);
    expect(() =>
      readProductionHostConfig({
        NODE_ENV: 'production',
        ATLAS_DATABASE_URL: 'postgres://atlas:x@127.0.0.1/atlas',
        ATLAS_TENANT_ID: 'tenant_prod',
        ATLAS_SESSION_SECRET: 'session-secret-value-not-real',
      }),
    ).toThrow(/ATLAS_ALLOWED_ORIGINS|ATLAS_CAS_ROOT/);
    expect(() =>
      readProductionHostConfig({
        NODE_ENV: 'production',
        ATLAS_DATABASE_URL: 'postgres://atlas:x@127.0.0.1/atlas',
        ATLAS_TENANT_ID: 'tenant_prod',
        ATLAS_SESSION_SECRET: 'session-secret-value-not-real',
        ATLAS_ALLOWED_ORIGINS: '*',
        ATLAS_CAS_ROOT: '/var/lib/atlas/cas',
      }),
    ).toThrow(/wildcard/);
    expect(() =>
      readProductionHostConfig({
        NODE_ENV: 'production',
        ATLAS_DATABASE_URL: 'postgres://atlas:x@127.0.0.1/atlas',
        ATLAS_TENANT_ID: 'tenant_prod',
        ATLAS_SESSION_SECRET: 'session-secret-value-not-real',
        ATLAS_ALLOWED_ORIGINS: 'https://atlas.example',
        ATLAS_CAS_ROOT: '/var/lib/atlas/cas',
        ATLAS_USE_MOCK_PROVIDERS: '1',
      }),
    ).toThrow(/MOCK_PROVIDERS/);
    expect(() =>
      readProductionHostConfig({
        NODE_ENV: 'production',
        ATLAS_PERSISTENCE: 'postgres',
        ATLAS_DATABASE_URL: 'postgres://atlas:x@127.0.0.1/atlas',
        ATLAS_TENANT_ID: 'tenant_prod',
        ATLAS_SESSION_SECRET: 'session-secret-value-not-real',
        ATLAS_ALLOWED_ORIGINS: 'https://atlas.example',
        ATLAS_CAS_ROOT: '/var/lib/atlas/cas',
        ATLAS_MUSIC_GPU: '1',
      }),
    ).toThrow(/Music GPU|ACE-Step/);
    expect(() =>
      readProductionHostConfig({
        NODE_ENV: 'production',
        ATLAS_PERSISTENCE: 'postgres',
        ATLAS_DATABASE_URL: 'postgres://atlas:x@127.0.0.1/atlas',
        ATLAS_TENANT_ID: 'tenant_prod',
        ATLAS_SESSION_SECRET: 'session-secret-value-not-real',
        ATLAS_ALLOWED_ORIGINS: 'https://atlas.example',
        ATLAS_CAS_ROOT: '/var/lib/atlas/cas',
        ATLAS_MUSIC_RUNTIME: 'acestep',
      }),
    ).toThrow(/ATLAS_MUSIC_RUNTIME/);
  });

  it('accepts a complete production contract without echoing secrets', () => {
    const config = readProductionHostConfig({
      NODE_ENV: 'production',
      ATLAS_PERSISTENCE: 'postgres',
      ATLAS_DATABASE_URL: 'postgres://atlas:super-secret@db/atlas',
      ATLAS_TENANT_ID: 'tenant_prod',
      ATLAS_SESSION_SECRET: 'session-secret-value-not-real',
      ATLAS_ALLOWED_ORIGINS: 'https://atlas.example',
      ATLAS_CAS_ROOT: '/var/lib/atlas/cas',
      ATLAS_TLS: '1',
    });
    expect(config.production).toBe(true);
    expect(config.persistenceMode).toBe('postgres');
    expect(config.hsts).toBe(true);
    expect(config.allowedOrigins).toEqual(['https://atlas.example']);
    const view = publicConfigView(config);
    expect(JSON.stringify(view)).not.toContain('super-secret');
    expect(JSON.stringify(view)).not.toContain('session-secret');
    expect(view.sessionSecretConfigured).toBe(true);
    expect(view.ha).toBe(false);
    expect(view.topology).toBe('single-instance');
    expect(view.rateLimiterScope).toBe('in-process');
    expect(view.runpodScheduler).toBe('local-file');
    expect(view.tracingExporter).toBe('none');
    expect(parseOrigins('https://a.example, https://b.example')).toEqual(['https://a.example', 'https://b.example']);
    expect(readTimeoutContract({}).providerMs).toBeGreaterThan(0);
  });

  it('allows development file mode without production secrets', () => {
    const config = readProductionHostConfig({ NODE_ENV: 'development' });
    expect(config.production).toBe(false);
    expect(config.persistenceMode).toBe('file');
    expect(config.tenantId).toBe('tenant_local');
  });

  it('forces production validation when requested even without NODE_ENV=production', () => {
    expect(() => readProductionHostConfig({ NODE_ENV: 'development' }, { forceProduction: true })).toThrow(
      ProductionConfigError,
    );
    expect(() => readProductionHostConfig({}, { forceProduction: true })).toThrow(/ATLAS_DATABASE_URL|critical configuration/);
    const config = readProductionHostConfig(
      {
        ATLAS_PERSISTENCE: 'postgres',
        ATLAS_DATABASE_URL: 'postgres://atlas:x@127.0.0.1/atlas',
        ATLAS_TENANT_ID: 'tenant_prod',
        ATLAS_SESSION_SECRET: 'session-secret-value-not-for-production-use',
        ATLAS_ALLOWED_ORIGINS: 'https://atlas.example',
        ATLAS_CAS_ROOT: '/var/lib/atlas/cas',
      },
      { forceProduction: true },
    );
    expect(config.production).toBe(true);
    expect(config.persistenceMode).toBe('postgres');
  });
});

describe('kill switches', () => {
  it('are operational flags, not Authority grants, and default enabled', () => {
    const flags = new EnvFlagStore({});
    expect(flags.enabled('tools')).toBe(true);
    expect(flags.enabled('generation')).toBe(true);
    expect(flags.enabled('dungeon.writing')).toBe(true);
    const killed = readKillSwitches({
      ATLAS_FLAG_TOOLS: 'off',
      ATLAS_FLAG_GENERATION: '0',
      ATLAS_FLAG_DUNGEON_WRITING: 'false',
      ATLAS_KILL_PROVIDERS: 'openai, anthropic',
    });
    expect(killed.tools).toBe(false);
    expect(killed.generation).toBe(false);
    expect(killed.dungeonWriting).toBe(false);
    expect(killed.disabledProviders).toEqual(['openai', 'anthropic']);
  });
});

describe('single-instance topology contract', () => {
  const complete = {
    NODE_ENV: 'production',
    ATLAS_PERSISTENCE: 'postgres',
    ATLAS_DATABASE_URL: 'postgres://atlas:x@127.0.0.1/atlas',
    ATLAS_TENANT_ID: 'tenant_prod',
    ATLAS_SESSION_SECRET: 'session-secret-value-not-real',
    ATLAS_ALLOWED_ORIGINS: 'https://atlas.example',
    ATLAS_CAS_ROOT: '/var/lib/atlas/cas',
  };

  it('accepts explicit single-instance topology and refuses HA / replica claims', () => {
    expect(readProductionHostConfig({ ...complete, ATLAS_DEPLOYMENT_TOPOLOGY: 'single-instance' }).topology.ha).toBe(
      false,
    );
    expect(() => readProductionHostConfig({ ...complete, ATLAS_HA: '1' })).toThrow(/ATLAS_HA/);
    expect(() => readProductionHostConfig({ ...complete, ATLAS_MULTI_INSTANCE: 'true' })).toThrow(/MULTI_INSTANCE/);
    expect(() => readProductionHostConfig({ ...complete, ATLAS_REPLICAS: '2' })).toThrow(/ATLAS_REPLICAS/);
    expect(() => readProductionHostConfig({ ...complete, ATLAS_DEPLOYMENT_TOPOLOGY: 'ha' })).toThrow(/not supported/);
  });
});

describe('config:validate --production CLI', () => {
  it('fails when --production is set but mandatory production settings are missing', () => {
    const result = runConfigValidate(['--production'], {
      NODE_ENV: 'development',
      ATLAS_ENV: undefined,
      ATLAS_DATABASE_URL: undefined,
      DATABASE_URL: undefined,
      ATLAS_TENANT_ID: undefined,
      ATLAS_SESSION_SECRET: undefined,
      ATLAS_ALLOWED_ORIGINS: undefined,
      ATLAS_CAS_ROOT: undefined,
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toMatch(/critical configuration|ProductionConfigError|ATLAS_DATABASE_URL/);
  });

  it('accepts a complete production configuration via --production without NODE_ENV', () => {
    const result = runConfigValidate(['--production'], {
      NODE_ENV: 'development',
      ATLAS_ENV: undefined,
      ATLAS_PERSISTENCE: 'postgres',
      ATLAS_DATABASE_URL: 'postgres://atlas:x@127.0.0.1/atlas',
      ATLAS_TENANT_ID: 'tenant_prod',
      ATLAS_SESSION_SECRET: 'session-secret-value-not-for-production-use',
      ATLAS_ALLOWED_ORIGINS: 'https://atlas.example',
      ATLAS_CAS_ROOT: '/var/lib/atlas/cas',
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; config: { production: boolean } };
    expect(parsed.ok).toBe(true);
    expect(parsed.config.production).toBe(true);
  });

  it('leaves ordinary development validation unchanged', () => {
    const result = runConfigValidate([], {
      NODE_ENV: 'development',
      ATLAS_ENV: undefined,
      ATLAS_DATABASE_URL: undefined,
      ATLAS_TENANT_ID: undefined,
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; catalogue: unknown[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.catalogue.length).toBeGreaterThan(0);
  });
});
