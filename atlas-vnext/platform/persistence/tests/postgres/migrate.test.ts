import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { CURRENT_SCHEMA_VERSION, checksumSql, defaultMigrationsDir, loadMigrations, migrate, withPostgresDdlLock } from '../../src/postgres/migrate.ts';
import { assertIdent } from '../../src/postgres/tx.ts';
import { dropTestSchema, openTestKernel, postgresUrl } from './harness.ts';

const { Pool } = pg;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe('schema bootstrap and migrations', () => {
  it('bootstraps an empty database and is safe to run twice', async () => {
    const first = await openTestKernel();
    cleanups.push(first.close);
    await first.kernel.ensureTenant({ id: 'tenant_a', name: 'A' });
    const second = await openTestKernel(first.schema);
    cleanups.push(async () => {
      await second.kernel.close();
    });
    const versions = await second.kernel.tx.query<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    expect(versions.rows.map((row) => Number(row.version))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(CURRENT_SCHEMA_VERSION).toBe(8);
    const tenant = await second.kernel.tx.query('SELECT id FROM tenants WHERE id = $1', ['tenant_a']);
    expect(tenant.rows).toHaveLength(1);
    const artefact = await second.kernel.tx.query('SELECT COUNT(*)::int AS n FROM artefact_metadata');
    expect(artefact.rows[0]?.n).toBe(0);
  });

  it('upgrades from a frozen v1 schema fixture without destroying rows', async () => {
    const schema = `t_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const pool = new Pool({ connectionString: postgresUrl(), connectionTimeoutMillis: 5_000 });
    cleanups.push(async () => {
      await dropTestSchema(schema);
      await pool.end();
    });
    const admin = await pool.connect();
    try {
      await withPostgresDdlLock(admin, () => admin.query(`CREATE SCHEMA ${assertIdent(schema)}`));
    } finally {
      admin.release();
    }
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${assertIdent(schema)}`);
      const v1 = loadMigrations().find((item) => item.version === 1);
      expect(v1).toBeTruthy();
      await withPostgresDdlLock(client, async () => {
        await client.query(v1!.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
          1,
          v1!.name,
          v1!.checksum,
        ]);
      });
      await client.query(
        `INSERT INTO tenants (id, urn, name, created_at, updated_at)
         VALUES ('tenant_keep', 'urn:atlas:tenant:keep', 'Keep', now(), now())`,
      );
      const result = await migrate(client, loadMigrations());
      expect(result.applied).toEqual([2, 3, 4, 5, 6, 7]);
      expect(result.skipped).toEqual([1]);
      const tenants = await client.query('SELECT id FROM tenants');
      expect(tenants.rows.map((row) => row.id)).toContain('tenant_keep');
      const artefacts = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = $1 AND table_name = 'artefact_metadata'
         ) AS present`,
        [schema],
      );
      expect(artefacts.rows[0]?.present).toBe(true);
      const attempts = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = $1 AND table_name = 'job_attempts'
         ) AS present`,
        [schema],
      );
      const files = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = $1 AND table_name = 'files'
         ) AS present`,
        [schema],
      );
      expect(files.rows[0]?.present).toBe(true);
      const sites = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = $1 AND table_name = 'site_records'
         ) AS present`,
        [schema],
      );
      expect(sites.rows[0]?.present).toBe(true);
    } finally {
      client.release();
    }
  });

  it('is idempotent: checksum-matched migrations are skipped, not re-executed', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    const client = await handle.kernel.tx.pool.connect();
    try {
      await client.query(`SET search_path TO ${assertIdent(handle.schema)}`);
      const again = await migrate(client, loadMigrations());
      expect(again.applied).toEqual([]);
      expect(again.skipped).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    } finally {
      client.release();
    }
  });

  it('fails visibly on a bad migration and does not record it or destroy data', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    await handle.kernel.ensureTenant({ id: 'tenant_a', name: 'A' });
    const dir = mkdtempSync(join(tmpdir(), 'atlas-mig-'));
    for (const migration of loadMigrations(defaultMigrationsDir())) {
      writeFileSync(join(dir, migration.filename), readFileSync(join(defaultMigrationsDir(), migration.filename)));
    }
    writeFileSync(join(dir, '008_bad.sql'), 'THIS IS NOT SQL;');
    const client = await handle.kernel.tx.pool.connect();
    try {
      await client.query(`SET search_path TO ${assertIdent(handle.schema)}`);
      await expect(migrate(client, loadMigrations(dir))).rejects.toThrow(/Migration 8/);
      const versions = await client.query('SELECT version FROM schema_migrations ORDER BY version');
      expect(versions.rows.map((row) => Number(row.version))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      const tenant = await client.query('SELECT id FROM tenants WHERE id = $1', ['tenant_a']);
      expect(tenant.rows).toHaveLength(1);
    } finally {
      client.release();
    }
    expect(checksumSql('abc')).toHaveLength(64);
  });

  it('bootstraps several schemas in parallel without stalling on catalog DDL', async () => {
    const handles = await Promise.all(Array.from({ length: 4 }, () => openTestKernel()));
    cleanups.push(...handles.map((handle) => handle.close));
    for (const handle of handles) {
      const versions = await handle.kernel.tx.query<{ n: number }>(
        'SELECT COUNT(*)::int AS n FROM schema_migrations',
      );
      expect(versions.rows[0]?.n).toBe(CURRENT_SCHEMA_VERSION);
    }
  });

  it('rolls back an interrupted migration and does not record the version', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    await handle.kernel.ensureTenant({ id: 'tenant_keep', name: 'Keep' });
    const dir = mkdtempSync(join(tmpdir(), 'atlas-mig-int-'));
    for (const migration of loadMigrations(defaultMigrationsDir())) {
      writeFileSync(join(dir, migration.filename), readFileSync(join(defaultMigrationsDir(), migration.filename)));
    }
    writeFileSync(
      join(dir, '008_interrupt.sql'),
      `CREATE TABLE interrupted_probe (id TEXT PRIMARY KEY);
       SELECT 1/0;`,
    );
    const client = await handle.kernel.tx.pool.connect();
    try {
      await client.query(`SET search_path TO ${assertIdent(handle.schema)}`);
      await expect(migrate(client, loadMigrations(dir))).rejects.toThrow(/Migration 8/);
      const versions = await client.query('SELECT version FROM schema_migrations ORDER BY version');
      expect(versions.rows.map((row) => Number(row.version))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      const probe = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = $1 AND table_name = 'interrupted_probe'
         ) AS present`,
        [handle.schema],
      );
      expect(probe.rows[0]?.present).toBe(false);
      const tenant = await client.query('SELECT id FROM tenants WHERE id = $1', ['tenant_keep']);
      expect(tenant.rows).toHaveLength(1);
    } finally {
      client.release();
    }
  });
});
