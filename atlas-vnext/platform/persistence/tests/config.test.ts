import { describe, expect, it } from 'vitest';
import {
  PersistenceConfigError,
  PersistenceUnavailableError,
  openMemoryPersistence,
  openPlatformPersistence,
  readPersistenceConfig,
} from '../src/index.ts';

describe('persistence config', () => {
  it('requires PostgreSQL URL when postgres mode is requested', () => {
    expect(() => readPersistenceConfig({ ATLAS_PERSISTENCE: 'postgres' })).toThrow(PersistenceConfigError);
  });

  it('refuses production memory/file fallback', () => {
    expect(() => readPersistenceConfig({ NODE_ENV: 'production', ATLAS_PERSISTENCE: 'memory' })).toThrow(
      /Production persistence requires PostgreSQL/,
    );
    expect(() => readPersistenceConfig({ NODE_ENV: 'production', ATLAS_PERSISTENCE: 'file' })).toThrow(
      /Production persistence requires PostgreSQL/,
    );
  });

  it('defaults production to postgres when a URL is present', () => {
    const config = readPersistenceConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://atlas:***@db/atlas',
    });
    expect(config.mode).toBe('postgres');
    expect(config.databaseUrl).toBe('postgres://atlas:***@db/atlas');
    expect(config.defaultTenantId).toBeNull();
  });

  it('does not silently open memory when postgres is requested and unavailable', async () => {
    await expect(
      openPlatformPersistence({
        mode: 'postgres',
        production: true,
        databaseUrl: 'postgres://atlas:atlas@127.0.0.1:1/atlas_vnext',
        poolMax: 1,
        idleTimeoutMs: 200,
        connectionTimeoutMs: 400,
        statementTimeoutMs: 400,
        filePath: null,
        defaultTenantId: 'tenant_local',
      }),
    ).rejects.toBeInstanceOf(PersistenceUnavailableError);
    const memory = openMemoryPersistence();
    expect(memory.mode).toBe('memory');
    await memory.close();
  });

  it('fails closed when production asks for the memory factory', async () => {
    await expect(
      openPlatformPersistence({
        mode: 'memory',
        production: true,
        databaseUrl: null,
        poolMax: 1,
        idleTimeoutMs: 1000,
        connectionTimeoutMs: 1000,
        statementTimeoutMs: 1000,
        filePath: null,
        defaultTenantId: 'tenant_local',
      }),
    ).rejects.toBeInstanceOf(PersistenceConfigError);
  });
});
