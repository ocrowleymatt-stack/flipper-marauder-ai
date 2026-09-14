import type { JobRecord, JobStatus } from '@atlas-vnext/contracts';
import type { JobCheckpointRecord, JobStore } from '@atlas-vnext/jobs';
import { mapJob, type JobRow } from './mappers.ts';
import type { PgTx } from './tx.ts';

export class PostgresJobStore implements JobStore {
  constructor(private readonly tx: PgTx) {}

  async insert(record: JobRecord): Promise<JobRecord> {
    try {
      const inserted = await this.tx.query<JobRow>(
        `INSERT INTO jobs (
           id, tenant_id, workspace_id, project_id, dungeon, type, status, priority, current_stage,
           progress_ratio, checkpoint, retry_count, max_retries, lease_owner, lease_until,
           idempotency_key, cancel_requested, trace_id, failure_reason, created_at, updated_at, started_at, completed_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,$22,$23
         )
         RETURNING *`,
        jobParams(record),
      );
      return mapJob(inserted.rows[0]!);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23505' && record.idempotencyKey && record.tenantId) {
        const existing = await this.findByIdempotency(record.tenantId, record.idempotencyKey);
        if (existing) return existing;
      }
      throw err;
    }
  }

  async findByIdempotency(tenantId: string, key: string): Promise<JobRecord | null> {
    const result = await this.tx.query<JobRow>(
      'SELECT * FROM jobs WHERE tenant_id = $1 AND idempotency_key = $2',
      [tenantId, key],
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async get(tenantId: string, id: string): Promise<JobRecord | null> {
    const result = await this.tx.query<JobRow>('SELECT * FROM jobs WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async save(record: JobRecord, expectedStatuses?: JobStatus[]): Promise<JobRecord> {
    const result = expectedStatuses?.length
      ? await this.tx.query<JobRow>(
          `UPDATE jobs SET
             workspace_id = $3, project_id = $4, dungeon = $5, type = $6, status = $7, priority = $8,
             current_stage = $9, progress_ratio = $10, checkpoint = $11::jsonb, retry_count = $12,
             max_retries = $13, lease_owner = $14, lease_until = $15, idempotency_key = $16,
             cancel_requested = $17, trace_id = $18, failure_reason = $19::jsonb, updated_at = $20,
             started_at = $21, completed_at = $22
           WHERE id = $1 AND tenant_id = $2 AND status = ANY($23::text[])
           RETURNING *`,
          [...jobUpdateParams(record), expectedStatuses],
        )
      : await this.tx.query<JobRow>(
          `UPDATE jobs SET
             workspace_id = $3, project_id = $4, dungeon = $5, type = $6, status = $7, priority = $8,
             current_stage = $9, progress_ratio = $10, checkpoint = $11::jsonb, retry_count = $12,
             max_retries = $13, lease_owner = $14, lease_until = $15, idempotency_key = $16,
             cancel_requested = $17, trace_id = $18, failure_reason = $19::jsonb, updated_at = $20,
             started_at = $21, completed_at = $22
           WHERE id = $1 AND tenant_id = $2
           RETURNING *`,
          jobUpdateParams(record),
        );
    if (!result.rows[0]) {
      throw new Error(`Job ${record.id} was not updated (missing, wrong tenant, or unexpected status).`);
    }
    return mapJob(result.rows[0]);
  }

  async claimQueued(input: {
    tenantId: string;
    workspaceId?: string | null;
    workerId: string;
    leaseUntil: string;
    now: string;
  }): Promise<JobRecord | null> {
    const workspaceClause = input.workspaceId ? 'AND (workspace_id = $5)' : '';
    const params = input.workspaceId
      ? [input.tenantId, input.now, input.workerId, input.leaseUntil, input.workspaceId]
      : [input.tenantId, input.now, input.workerId, input.leaseUntil];
    const result = await this.tx.query<JobRow>(
      `WITH picked AS (
         SELECT id FROM jobs
         WHERE tenant_id = $1
           AND status = 'queued'
           AND cancel_requested = FALSE
           AND (lease_until IS NULL OR lease_until <= $2::timestamptz)
           ${workspaceClause}
         ORDER BY priority DESC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE jobs j
       SET status = 'running',
           lease_owner = $3,
           lease_until = $4::timestamptz,
           started_at = COALESCE(started_at, $2::timestamptz),
           updated_at = $2::timestamptz
       FROM picked
       WHERE j.id = picked.id
       RETURNING j.*`,
      params,
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async listExpiredRunning(now: string): Promise<JobRecord[]> {
    const result = await this.tx.query<JobRow>(
      `SELECT * FROM jobs
       WHERE status = 'running'
         AND lease_until IS NOT NULL
         AND lease_until <= $1::timestamptz`,
      [now],
    );
    return result.rows.map(mapJob);
  }

  async listByLeaseOwner(workerId: string): Promise<JobRecord[]> {
    const result = await this.tx.query<JobRow>('SELECT * FROM jobs WHERE lease_owner = $1', [workerId]);
    return result.rows.map(mapJob);
  }

  async appendCheckpoint(row: JobCheckpointRecord): Promise<void> {
    await this.tx.query(
      `INSERT INTO job_checkpoints (id, tenant_id, job_id, stage, progress_ratio, data, created_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [row.id, row.tenantId, row.jobId, row.stage, row.progressRatio, JSON.stringify(row.data), row.createdAt],
    );
  }

  async latestCheckpoint(tenantId: string, jobId: string): Promise<JobCheckpointRecord | null> {
    const result = await this.tx.query<{
      id: string;
      tenant_id: string;
      job_id: string;
      stage: string;
      progress_ratio: number;
      data: unknown;
      created_at: Date | string;
    }>(
      `SELECT * FROM job_checkpoints WHERE tenant_id = $1 AND job_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [tenantId, jobId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      jobId: row.job_id,
      stage: row.stage,
      progressRatio: Number(row.progress_ratio),
      data: (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) as Record<string, unknown>,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
  }
}

function jobParams(record: JobRecord): unknown[] {
  return [
    record.id,
    record.tenantId,
    record.workspaceId ?? null,
    record.projectId,
    record.dungeon,
    record.type,
    record.status,
    record.priority,
    record.currentStage,
    record.progressRatio,
    JSON.stringify(record.checkpoint ?? {}),
    record.retryCount,
    record.maxRetries,
    record.leaseOwner,
    record.leaseUntil,
    record.idempotencyKey,
    record.cancelRequested ?? false,
    record.traceId,
    record.failureReason ? JSON.stringify(record.failureReason) : null,
    record.createdAt,
    record.updatedAt,
    record.startedAt,
    record.completedAt,
  ];
}

function jobUpdateParams(record: JobRecord): unknown[] {
  return [
    record.id,
    record.tenantId,
    record.workspaceId ?? null,
    record.projectId,
    record.dungeon,
    record.type,
    record.status,
    record.priority,
    record.currentStage,
    record.progressRatio,
    JSON.stringify(record.checkpoint ?? {}),
    record.retryCount,
    record.maxRetries,
    record.leaseOwner,
    record.leaseUntil,
    record.idempotencyKey,
    record.cancelRequested ?? false,
    record.traceId,
    record.failureReason ? JSON.stringify(record.failureReason) : null,
    record.updatedAt,
    record.startedAt,
    record.completedAt,
  ];
}
