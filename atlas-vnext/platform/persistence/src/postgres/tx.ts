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
    return this.pool.query<T>(text, params);
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
  return new Pool({
    connectionString: input.connectionString,
    max: input.max,
    idleTimeoutMillis: input.idleTimeoutMs,
    connectionTimeoutMillis: input.connectionTimeoutMs,
    options: flags.join(' '),
    application_name: 'atlas-vnext',
  });
}

export { Pool };
