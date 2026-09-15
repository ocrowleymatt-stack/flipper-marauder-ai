import { describe, expect, it } from 'vitest';
import {
  PersistenceUncertainError,
  PersistenceUnavailableError,
} from '../../src/errors.ts';
import { PostgresJobStore } from '../../src/postgres/jobs.ts';
import {
  PgTx,
  classifySqlSafety,
  decideTransientRetry,
} from '../../src/postgres/tx.ts';

const CLAIM_SQL = `WITH picked AS (
         SELECT id FROM jobs
         WHERE tenant_id = $1
           AND status = 'queued'
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE jobs j
       SET status = 'running'
       FROM picked
       WHERE j.id = picked.id
       RETURNING j.*`;

const REVISION_SQL = `UPDATE documents SET revision = revision + 1, updated_at = $12
           WHERE id = $1 AND tenant_id = $2 AND revision = $13 AND deleted_at IS NULL
           RETURNING *`;

const READ_SQL = 'SELECT * FROM jobs WHERE tenant_id = $1 AND id = $2';

class NodeishError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'Error';
  }
}

class PgAbortError extends Error {
  severity = 'ERROR';
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'error';
  }
}

interface FakeResult {
  rows: unknown[];
  rowCount: number;
}

function result(rows: unknown[] = []): FakeResult {
  return { rows, rowCount: rows.length };
}

function fakePool(handler: (text: string, params: unknown[]) => Promise<FakeResult> | FakeResult) {
  return {
    query: async (text: string, params: unknown[] = []) => handler(text, params),
    connect: async () => {
      throw new Error('connect() should not be used for autocommit query tests');
    },
  } as never;
}

function fakeClientPool(script: {
  begin?: () => Promise<void> | void;
  commit?: () => Promise<void> | void;
  rollback?: () => Promise<void> | void;
  query?: (text: string, params: unknown[]) => Promise<FakeResult> | FakeResult;
  onRelease?: () => void;
}) {
  let released = 0;
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      const trimmed = text.trim().toUpperCase();
      if (trimmed === 'BEGIN') {
        await script.begin?.();
        return result();
      }
      if (trimmed === 'COMMIT') {
        await script.commit?.();
        return result();
      }
      if (trimmed === 'ROLLBACK') {
        await script.rollback?.();
        return result();
      }
      if (script.query) return script.query(text, params);
      return result();
    },
    release: () => {
      released += 1;
      script.onRelease?.();
    },
  };
  return {
    pool: {
      connect: async () => client,
    } as never,
    released: () => released,
  };
}

describe('SQL safety classification', () => {
  it('classifies reads as retry-safe and mutations as writes', () => {
    expect(classifySqlSafety(READ_SQL)).toBe('read');
    expect(classifySqlSafety('SELECT pg_advisory_lock($1)')).toBe('read');
    expect(classifySqlSafety('SELECT * FROM jobs FOR UPDATE SKIP LOCKED')).toBe('read');
    expect(classifySqlSafety(CLAIM_SQL)).toBe('write');
    expect(classifySqlSafety(REVISION_SQL)).toBe('write');
    expect(classifySqlSafety(`INSERT INTO jobs (id) VALUES ($1)`)).toBe('write');
    expect(classifySqlSafety(`-- UPDATE jobs\nSELECT * FROM jobs`)).toBe('read');
    expect(classifySqlSafety(`SELECT 'UPDATE jobs' AS note`)).toBe('read');
  });

  it('does not treat a transient network error as proof that a mutation is safe to replay', () => {
    const reset = new NodeishError('read ECONNRESET', 'ECONNRESET');
    expect(decideTransientRetry(READ_SQL, reset)).toBe('retry');
    expect(decideTransientRetry(CLAIM_SQL, reset)).toBe('uncertain');
    expect(decideTransientRetry(REVISION_SQL, reset)).toBe('uncertain');
    expect(decideTransientRetry(CLAIM_SQL, new NodeishError('connect ECONNREFUSED', 'ECONNREFUSED'))).toBe('retry');
    expect(decideTransientRetry(CLAIM_SQL, new PgAbortError('could not serialize', '40001'))).toBe('retry');
  });
});

describe('autocommit transient retry contract', () => {
  it('retries a read-only query after a transient failure before completion', async () => {
    let attempts = 0;
    const tx = new PgTx(
      fakePool(async (text) => {
        attempts += 1;
        if (attempts === 1) throw new NodeishError('read ECONNRESET', 'ECONNRESET');
        expect(classifySqlSafety(text)).toBe('read');
        return result([{ id: 'job_1' }]);
      }),
    );
    const rows = await tx.query(READ_SQL, ['tenant_a', 'job_1']);
    expect(attempts).toBe(2);
    expect(rows.rows).toEqual([{ id: 'job_1' }]);
  });

  it('retries a mutation only when the failure proves the statement never executed', async () => {
    let attempts = 0;
    const tx = new PgTx(
      fakePool(async () => {
        attempts += 1;
        if (attempts === 1) throw new NodeishError('connect ECONNREFUSED', 'ECONNREFUSED');
        return result([{ id: 'job_1', status: 'running' }]);
      }),
    );
    const rows = await tx.query(CLAIM_SQL, ['tenant_a']);
    expect(attempts).toBe(2);
    expect(rows.rows[0]).toMatchObject({ id: 'job_1' });
  });

  it('does not blindly replay a mutation that may have committed before connection loss', async () => {
    let attempts = 0;
    const tx = new PgTx(
      fakePool(async () => {
        attempts += 1;
        throw new NodeishError('read ECONNRESET', 'ECONNRESET');
      }),
    );
    await expect(tx.query(CLAIM_SQL, ['tenant_a'])).rejects.toBeInstanceOf(PersistenceUncertainError);
    expect(attempts).toBe(1);
  });

  it('cannot claim a second queued job after an ambiguous first claim', async () => {
    const queued = ['job_a', 'job_b'];
    let executions = 0;
    const claimed: string[] = [];
    const tx = new PgTx(
      fakePool(async (text) => {
        if (classifySqlSafety(text) !== 'write') return result();
        executions += 1;
        const id = queued.shift();
        if (id) claimed.push(id);
        throw new NodeishError('Connection terminated unexpectedly', 'ECONNRESET');
      }),
    );
    const store = new PostgresJobStore(tx);
    await expect(
      store.claimQueued({
        tenantId: 'tenant_a',
        workerId: 'w1',
        leaseUntil: new Date().toISOString(),
        now: new Date().toISOString(),
      }),
    ).rejects.toBeInstanceOf(PersistenceUncertainError);
    expect(executions).toBe(1);
    expect(claimed).toEqual(['job_a']);
  });

  it('cannot double-increment a revision-changing mutation after an ambiguous failure', async () => {
    let increments = 0;
    const tx = new PgTx(
      fakePool(async (text) => {
        if (!/revision\s*=\s*revision\s*\+\s*1/i.test(text)) return result();
        increments += 1;
        throw new NodeishError('write EPIPE', 'EPIPE');
      }),
    );
    await expect(tx.query(REVISION_SQL, [])).rejects.toBeInstanceOf(PersistenceUncertainError);
    expect(increments).toBe(1);
  });
});

describe('transaction rollback and commit semantics', () => {
  it('rolls back work and does not retry the transaction when the statement fails', async () => {
    let begins = 0;
    let rollbacks = 0;
    let inserts = 0;
    let commits = 0;
    const { pool, released } = fakeClientPool({
      begin: () => {
        begins += 1;
      },
      rollback: () => {
        rollbacks += 1;
      },
      commit: () => {
        commits += 1;
      },
      query: () => {
        inserts += 1;
        throw new Error('boom');
      },
    });
    const tx = new PgTx(pool);
    await expect(
      tx.run(async () => {
        await tx.query('INSERT INTO jobs (id) VALUES ($1)', ['job_x']);
      }),
    ).rejects.toThrow(/boom/);
    expect(begins).toBe(1);
    expect(inserts).toBe(1);
    expect(commits).toBe(0);
    expect(rollbacks).toBe(1);
    expect(released()).toBe(1);
  });

  it('surfaces an uncertain outcome when COMMIT may already have applied', async () => {
    let inserts = 0;
    let rollbacks = 0;
    const { pool, released } = fakeClientPool({
      commit: () => {
        throw new NodeishError('read ECONNRESET', 'ECONNRESET');
      },
      rollback: () => {
        rollbacks += 1;
      },
      query: () => {
        inserts += 1;
        return result([{ id: 'job_x' }]);
      },
    });
    const tx = new PgTx(pool);
    await expect(
      tx.run(async () => {
        await tx.query('INSERT INTO jobs (id) VALUES ($1)', ['job_x']);
        return 'ok';
      }),
    ).rejects.toBeInstanceOf(PersistenceUncertainError);
    expect(inserts).toBe(1);
    expect(rollbacks).toBe(0);
    expect(released()).toBe(1);
  });

  it('maps mid-transaction connection loss before COMMIT to unavailable, not a replay', async () => {
    let begins = 0;
    let commits = 0;
    const { pool, released } = fakeClientPool({
      begin: () => {
        begins += 1;
      },
      commit: () => {
        commits += 1;
      },
      query: () => {
        throw new NodeishError('Connection terminated unexpectedly', '57P01');
      },
    });
    const tx = new PgTx(pool);
    await expect(
      tx.run(async () => {
        await tx.query('UPDATE documents SET revision = revision + 1 WHERE id = $1', ['doc_1']);
      }),
    ).rejects.toBeInstanceOf(PersistenceUnavailableError);
    expect(begins).toBe(1);
    expect(commits).toBe(0);
    expect(released()).toBe(1);
  });
});
