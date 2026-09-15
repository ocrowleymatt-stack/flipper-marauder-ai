import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { logPlatform } from '@atlas-vnext/observability';
import { PersistenceClosedError, PersistenceUnavailableError, PersistenceUncertainError } from '../errors.ts';

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
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  '57P01',
  '57P02',
  '57P03',
  '08000',
  '08001',
  '08003',
  '08006',
  '40001',
  '40P01',
]);

/** Failures that prove the statement never reached PostgreSQL. */
const PRE_DISPATCH_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  '08001',
  '57P03',
]);

/** PostgreSQL aborted the statement/transaction; it did not commit. */
const ABORT_CODES = new Set(['40001', '40P01']);

const MAX_TRANSIENT_RETRIES = 2;

const WRITE_KEYWORD =
  /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE|COPY|CALL|DO|REFRESH|VACUUM|CLUSTER|REINDEX|LOCK|NOTIFY|LISTEN|UNLISTEN)\b/i;

export type SqlSafety = 'read' | 'write';
export type TransientRetryDecision = 'retry' | 'throw' | 'uncertain';

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
    try {
      const client = this.als.getStore();
      if (client) return await client.query<T>(text, params);
      return await queryWithBoundedRetry(this.pool, text, params);
    } catch (err) {
      throw remapUnavailable(err);
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) throw new PersistenceClosedError();
    const existing = this.als.getStore();
    if (existing) return fn();
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch (err) {
      throw remapUnavailable(err);
    }
    let began = false;
    let committed = false;
    try {
      await client.query('BEGIN');
      began = true;
      const result = await this.als.run(client, fn);
      try {
        await client.query('COMMIT');
        committed = true;
      } catch (commitErr) {
        if (isAmbiguousApplicationState(commitErr)) {
          throw new PersistenceUncertainError(
            'Transaction commit completed with uncertain outcome.',
            commitErr,
          );
        }
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback failure; the connection will be discarded
        }
        throw remapUnavailable(commitErr);
      }
      return result;
    } catch (err) {
      if (!committed && began && !(err instanceof PersistenceUncertainError)) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback failure; the connection will be discarded
        }
      }
      if (!(err instanceof PersistenceUncertainError)) {
        logPlatform(
          'transaction.failure',
          { error: err instanceof Error ? err.message : String(err) },
          'error',
        );
      }
      throw remapUnavailable(err);
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
      const decision = decideTransientRetry(text, err);
      if (decision === 'uncertain') {
        throw new PersistenceUncertainError(
          'Database mutation completed with uncertain commit state.',
          err,
        );
      }
      if (decision !== 'retry' || attempt === MAX_TRANSIENT_RETRIES) break;
      logPlatform(
        'db.transient_retry',
        {
          attempt: attempt + 1,
          max: MAX_TRANSIENT_RETRIES,
          safety: classifySqlSafety(text),
          error: err instanceof Error ? err.message : String(err),
        },
        'warn',
      );
      await delay(50 * 2 ** attempt);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export function classifySqlSafety(text: string): SqlSafety {
  const normalized = stripSqlNoise(text)
    .replace(/\bFOR\s+UPDATE\b/gi, ' ')
    .replace(/\bFOR\s+NO\s+KEY\s+UPDATE\b/gi, ' ')
    .replace(/\bFOR\s+SHARE\b/gi, ' ')
    .replace(/\bFOR\s+KEY\s+SHARE\b/gi, ' ')
    .trim();
  if (!normalized) return 'write';
  return WRITE_KEYWORD.test(normalized) ? 'write' : 'read';
}

export function decideTransientRetry(sql: string, err: unknown): TransientRetryDecision {
  const abort = isTransactionAbort(err);
  const transient = isTransientDbError(err);
  if (!abort && !transient) return 'throw';
  const safety = classifySqlSafety(sql);
  if (safety === 'read') return 'retry';
  if (abort) return 'retry';
  if (isPreDispatchFailure(err)) return 'retry';
  if (isAmbiguousApplicationState(err)) return 'uncertain';
  return 'throw';
}

export function isPreDispatchFailure(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if (isPgServerError(err)) return false;
  const code = errorCode(err);
  if (PRE_DISPATCH_CODES.has(code)) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /connect ECONNREFUSED|getaddrinfo|connect ENETUNREACH|connect EHOSTUNREACH/i.test(message);
}

export function isTransactionAbort(err: unknown): boolean {
  return ABORT_CODES.has(errorCode(err));
}

export function isAmbiguousApplicationState(err: unknown): boolean {
  if (isTransactionAbort(err) || isPreDispatchFailure(err)) return false;
  if (isPersistenceConnectionLoss(err)) return true;
  const code = errorCode(err);
  return code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT';
}

export function isTransientDbError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return TRANSIENT_CODES.has(errorCode(err));
}

const CONNECTION_LOSS_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  '57P01',
  '57P02',
  '57P03',
  '08000',
  '08001',
  '08003',
  '08006',
]);

export function isPersistenceConnectionLoss(err: unknown): boolean {
  if (err instanceof PersistenceClosedError || err instanceof PersistenceUnavailableError) return true;
  if (err && typeof err === 'object' && CONNECTION_LOSS_CODES.has(errorCode(err))) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /pool after calling end|Connection terminated|Client has encountered a connection error|connect ECONNREFUSED/i.test(
    message,
  );
}

function remapUnavailable(err: unknown): unknown {
  if (err instanceof PersistenceClosedError || err instanceof PersistenceUnavailableError) return err;
  if (err instanceof PersistenceUncertainError) return err;
  if (isPersistenceConnectionLoss(err)) {
    return new PersistenceUnavailableError('Persistence unavailable.');
  }
  return err;
}

function errorCode(err: unknown): string {
  if (!err || typeof err !== 'object' || !('code' in err)) return '';
  return String((err as { code?: unknown }).code ?? '');
}

function isPgServerError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const severity = 'severity' in err ? (err as { severity?: unknown }).severity : undefined;
  return typeof severity === 'string' && severity.length > 0;
}

function stripSqlNoise(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const next = sql[i]!;
    const nextTwo = sql.slice(i, i + 2);
    if (nextTwo === '--') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
      out += ' ';
      continue;
    }
    if (nextTwo === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
      continue;
    }
    if (next === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      out += "''";
      continue;
    }
    if (next === '"') {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      out += '""';
      continue;
    }
    if (next === '$') {
      const tag = sql.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
      if (tag) {
        const closer = sql.indexOf(tag[0], i + tag[0].length);
        i = closer === -1 ? sql.length : closer + tag[0].length;
        out += ' ';
        continue;
      }
    }
    out += next;
    i += 1;
  }
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { Pool };
