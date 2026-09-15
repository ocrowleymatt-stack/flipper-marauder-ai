import { describe, expect, it } from 'vitest';
import { EnvFlagStore, readKillSwitches } from '@atlas-vnext/flags';
import {
  ProductionConfigError,
  parseOrigins,
  publicConfigView,
  readProductionHostConfig,
  readTimeoutContract,
} from '../../apps/host/src/production-config.ts';

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
    expect(parseOrigins('https://a.example, https://b.example')).toEqual(['https://a.example', 'https://b.example']);
    expect(readTimeoutContract({}).providerMs).toBeGreaterThan(0);
  });

  it('allows development file mode without production secrets', () => {
    const config = readProductionHostConfig({ NODE_ENV: 'development' });
    expect(config.production).toBe(false);
    expect(config.persistenceMode).toBe('file');
    expect(config.tenantId).toBe('tenant_local');
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
