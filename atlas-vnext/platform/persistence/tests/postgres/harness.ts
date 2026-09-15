import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { PersistenceConfig } from '../../src/config.ts';
import { openPostgresPersistence, type PostgresPersistence } from '../../src/postgres/kernel.ts';
import { withPostgresDdlLock } from '../../src/postgres/migrate.ts';
import { assertIdent } from '../../src/postgres/tx.ts';

const { Pool } = pg;

async function withAdminClient<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const admin = new Pool({
    connectionString: postgresUrl(),
    connectionTimeoutMillis: 5_000,
    options: '-c statement_timeout=15000',
  });
  const client = await admin.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
    await admin.end();
  }
}

async function createTestSchema(schema: string): Promise<void> {
  await withAdminClient((client) =>
    withPostgresDdlLock(client, () => client.query(`CREATE SCHEMA IF NOT EXISTS ${assertIdent(schema)}`)),
  );
}

export async function dropTestSchema(schema: string): Promise<void> {
  await withAdminClient((client) =>
    withPostgresDdlLock(client, () => client.query(`DROP SCHEMA IF EXISTS ${assertIdent(schema)} CASCADE`)),
  );
}

export function postgresUrl(): string {
  return (
    process.env.ATLAS_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    'postgres://atlas:atlas@127.0.0.1:5432/atlas_vnext_test'
  );
}

export function persistenceConfig(schema: string): PersistenceConfig {
  return {
    mode: 'postgres',
    production: false,
    databaseUrl: postgresUrl(),
    poolMax: 8,
    idleTimeoutMs: 5_000,
    connectionTimeoutMs: 5_000,
    statementTimeoutMs: 15_000,
    filePath: null,
    defaultTenantId: 'tenant_local',
    schema,
  };
}

export async function openTestKernel(schema = `t_${randomUUID().replace(/-/g, '').slice(0, 12)}`): Promise<{
  schema: string;
  kernel: PostgresPersistence;
  close: () => Promise<void>;
}> {
  await createTestSchema(schema);
  const kernel = await openPostgresPersistence(persistenceConfig(schema));
  return {
    schema,
    kernel,
    close: async () => {
      await kernel.close();
      await dropTestSchema(schema);
    },
  };
}

export async function openPairedKernels(): Promise<{
  schema: string;
  a: PostgresPersistence;
  b: PostgresPersistence;
  close: () => Promise<void>;
}> {
  const schema = `t_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await createTestSchema(schema);
  const config = persistenceConfig(schema);
  const a = await openPostgresPersistence(config);
  const b = await openPostgresPersistence(config);
  return {
    schema,
    a,
    b,
    close: async () => {
      await a.close();
      await b.close();
      await dropTestSchema(schema);
    },
  };
}

export const tenantA = { tenantId: 'tenant_a' };
export const tenantB = { tenantId: 'tenant_b' };
