import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { logPlatform } from '@atlas-vnext/observability';
import { PersistenceClosedError } from '../errors.ts';

const { Pool } = pg;

export type Queryable = pg.Pool | pg.PoolClient;

export function assertIdent(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid SQL identifier: ${value}`);
  }
  return value;
}

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  '57P01',
  '57P02',
  '57P03',
  '08000',
  '08001',
  '08003',
  '08006',
  '40001',
]);

const MAX_TRANSIENT_RETRIES = 2;

export class PgTx {
  readonly als = new AsyncLocalStorage<pg.PoolClient>();
  private closed = false;

  constructor(readonly pool: pg.Pool) {}

  markClosed(): void {
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<pg.QueryResult<T>> {
    if (this.closed) throw new PersistenceClosedError();
    const client = this.als.getStore();
    if (client) return client.query<T>(text, params);
    return queryWithBoundedRetry(this.pool, text, params);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) throw new PersistenceClosedError();
    const existing = this.als.getStore();
    if (existing) return fn();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await this.als.run(client, fn);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback failure; the connection will be discarded
      }
      logPlatform(
        'transaction.failure',
        { error: err instanceof Error ? err.message : String(err) },
        'error',
      );
      throw err;
    } finally {
      client.release();
    }
  }
}

export function createPool(input: {
  connectionString: string;
  max: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  statementTimeoutMs: number;
  schema?: string;
}): pg.Pool {
  const flags = [`-c statement_timeout=${input.statementTimeoutMs}`];
  if (input.schema) flags.push(`-c search_path=${assertIdent(input.schema)}`);
  const pool = new Pool({
    connectionString: input.connectionString,
    max: input.max,
    idleTimeoutMillis: input.idleTimeoutMs,
    connectionTimeoutMillis: input.connectionTimeoutMs,
    options: flags.join(' '),
    application_name: 'atlas-vnext',
  });
  pool.on('error', (err) => {
    logPlatform('db.pool.idle_error', { error: err instanceof Error ? err.message : String(err) }, 'error');
  });
  pool.on('connect', () => {
    if (pool.waitingCount > 0) {
        logPlatform(
          'db.pool.pressure',
          { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, max: input.max },
          'warn',
        );
    }
  });
  return pool;
}

async function queryWithBoundedRetry<T extends pg.QueryResultRow>(
  pool: pg.Pool,
  text: string,
  params: unknown[],
): Promise<pg.QueryResult<T>> {
  let last: unknown;
  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt += 1) {
    try {
      return await pool.query<T>(text, params);
    } catch (err) {
      last = err;
      if (!isTransientDbError(err) || attempt === MAX_TRANSIENT_RETRIES) break;
      logPlatform(
        'db.transient_retry',
        { attempt: attempt + 1, max: MAX_TRANSIENT_RETRIES, error: err instanceof Error ? err.message : String(err) },
        'warn',
      );
      await delay(50 * 2 ** attempt);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export function isTransientDbError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = 'code' in err ? String((err as { code?: unknown }).code) : '';
  return TRANSIENT_CODES.has(code);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { Pool };
