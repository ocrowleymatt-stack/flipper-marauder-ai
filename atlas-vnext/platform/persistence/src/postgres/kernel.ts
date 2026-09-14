import { randomUUID } from 'node:crypto';
import type { ExecutionRecord } from '@atlas-vnext/contracts';
import { createJobEngine, type DurableJobEngine } from '@atlas-vnext/jobs';
import { logPlatform, redactSecret } from '@atlas-vnext/observability';
import type { PersistenceActor } from '../actor.ts';
import type { PersistenceConfig } from '../config.ts';
import { PersistenceUnavailableError, ConflictError, OwnershipError } from '../errors.ts';
import type {
  ActorBoundPersistence,
  ArtefactMetadata,
  ArtefactMetadataStore,
  PlatformPersistence,
  PrincipalRecord,
  RestartRecoveryResult,
  RuntimeLeaseRecord,
  RuntimeLeaseStore,
  TenantRecord,
  WorkspaceRecord,
} from '../kernel.ts';
import { assertActor } from '../actor.ts';
import { createBehaviourStore, createWorkspaceStore, ensurePrincipal, ensureTenant } from './directories.ts';
import { createConversationRepos } from './conversations.ts';
import { applyEventRetention, createEventBus } from './events.ts';
import { PostgresJobStore } from './jobs.ts';
import { createFileStores } from './files.ts';
import { createAuthStores } from './auth.ts';
import { createToolStores, recoverToolInvocations } from './tools.ts';
import { createSiteStores } from './sites.ts';
import { createDocumentStore } from './documents.ts';
import { mapArtefact, mapExecution, mapLease, sqlRow, type ExecutionRow } from './mappers.ts';
import { CURRENT_SCHEMA_VERSION, ensureSchema, loadMigrations, migrate } from './migrate.ts';
import { PgTx, createPool } from './tx.ts';

export class PostgresPersistence implements PlatformPersistence {
  readonly mode = 'postgres' as const;
  readonly runtimeLeases: RuntimeLeaseStore;
  readonly artefacts: ArtefactMetadataStore;
  private readonly jobs: DurableJobEngine;

  constructor(
    readonly tx: PgTx,
    private readonly clock: () => string,
  ) {
    this.jobs = createJobEngine({
      store: new PostgresJobStore(tx),
      clock,
      unitOfWork: this,
      log: (event, fields) => logPlatform(event, fields),
      events: {
        publish: async (input) => {
          const bus = createEventBus(tx, { tenantId: input.tenantId, workspaceId: input.workspaceId }, clock);
          await bus.publish(input);
        },
      },
    });
    this.runtimeLeases = createRuntimeLeaseStore(tx, clock);
    this.artefacts = createArtefactStore(tx, clock);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    return this.tx.run(fn);
  }

  forActor(actor: PersistenceActor): ActorBoundPersistence {
    const scoped = assertActor(actor, 'bind persistence');
    const repos = createConversationRepos(this.tx, scoped, this.clock);
    const events = createEventBus(this.tx, scoped, this.clock);
    const fileStores = createFileStores(this.tx, this.clock);
    const siteStores = createSiteStores(this.tx, this.clock);
    const authStores = createAuthStores(this.tx);
    const toolStores = createToolStores(this.tx);
    return {
      actor: scoped,
      conversations: repos.conversations,
      messages: repos.messages,
      executions: repos.executions,
      provenance: repos.provenance,
      events,
      jobs: this.jobs,
      behaviour: createBehaviourStore(this.tx),
      workspaces: createWorkspaceStore(this.tx),
      files: fileStores.files,
      fileVersions: fileStores.fileVersions,
      extractions: fileStores.extractions,
      chunks: fileStores.chunks,
      attachments: fileStores.attachments,
      casRefs: fileStores.casRefs,
      sites: siteStores.sites,
      sessions: authStores.sessions,
      directory: authStores.directory,
      toolInvocations: toolStores.invocations,
      toolApprovals: toolStores.approvals,
      documents: createDocumentStore(this.tx, this.clock),
    };
  }

  async ensureTenant(input: { id: string; name: string }): Promise<TenantRecord> {
    return ensureTenant(this.tx, input, this.clock());
  }

  async ensurePrincipal(input: { id: string; displayName?: string | null }): Promise<PrincipalRecord> {
    return ensurePrincipal(this.tx, input, this.clock());
  }

  async ensureWorkspace(
    actor: PersistenceActor,
    input: { id?: string; name: string; dungeon?: string },
  ): Promise<WorkspaceRecord> {
    return createWorkspaceStore(this.tx).create(actor, input);
  }

  async recoverOnStart(reason = 'Process restarted before the execution finished.'): Promise<RestartRecoveryResult> {
    logPlatform('restart.reconcile', { mode: this.mode });
    const executions = await this.tx.run(async () => {
      const inflight = await this.tx.query<ExecutionRow>(
        `SELECT * FROM executions WHERE status IN ('queued', 'running')`,
      );
      const recovered: ExecutionRecord[] = [];
      const now = this.clock();
      for (const row of inflight.rows) {
        const updated = await this.tx.query<ExecutionRow>(
          `UPDATE executions
           SET status = 'failed',
               failure_reason = $2::jsonb,
               updated_at = $3,
               completed_at = $3,
               started_at = COALESCE(started_at, $3)
           WHERE id = $1 AND status IN ('queued', 'running')
           RETURNING *`,
          [
            row.id,
            JSON.stringify({ code: 'interrupted', message: reason, retryable: true, at: now }),
            now,
          ],
        );
        const execution = updated.rows[0] ? mapExecution(updated.rows[0]) : null;
        if (!execution) continue;
        const bus = createEventBus(this.tx, { tenantId: execution.tenantId ?? row.tenant_id }, this.clock);
        await bus.publish({
          channel: `conversation:${execution.conversationId}`,
          type: 'execution.failed',
          payload: { executionId: execution.id, code: 'interrupted' },
          tenantId: execution.tenantId,
          conversationId: execution.conversationId,
          idempotencyKey: `execution:${execution.id}:interrupted`,
        });
        recovered.push(execution);
      }
      return recovered;
    });
    const jobs = await this.jobs.recoverExpiredLeases(this.clock());
    const runtimeLeases = await this.runtimeLeases.expire(this.clock());
    const tools = await this.tx.run(() => recoverToolInvocations(this.tx, this.clock()));
    await this.tx.run(async () => {
      const docs = createDocumentStore(this.tx, this.clock);
      const now = this.clock();
      for (const doc of await docs.listInFlight()) {
        await docs.update(
          { tenantId: doc.tenantId, principalId: doc.createdBy ?? 'system' },
          doc.id,
          {
            status: 'failed',
            failure: { code: 'interrupted', message: reason, retryable: true, at: now },
            expectedRevision: doc.revision,
          },
        );
      }
    });
    return { executions, jobs, runtimeLeases, tools };
  }

  async applyEventRetention(maxEntries?: number): Promise<number> {
    return applyEventRetention(this.tx, maxEntries);
  }

  async close(): Promise<void> {
    if (this.tx.isClosed) {
      try {
        await this.tx.pool.end();
      } catch {
        // already ended
      }
      return;
    }
    this.tx.markClosed();
    await this.tx.pool.end();
  }
}

export async function openPostgresPersistence(
  config: PersistenceConfig,
  clock: () => string = () => new Date().toISOString(),
): Promise<PostgresPersistence> {
  if (!config.databaseUrl) {
    throw new PersistenceUnavailableError('PostgreSQL persistence requested but no database URL was configured.');
  }
  const pool = createPool({
    connectionString: config.databaseUrl,
    max: config.poolMax,
    idleTimeoutMs: config.idleTimeoutMs,
    connectionTimeoutMs: config.connectionTimeoutMs,
    statementTimeoutMs: config.statementTimeoutMs,
    schema: config.schema,
  });
  const client = await pool.connect().catch((err: unknown) => {
    logPlatform(
      'db.unavailable',
      { error: err instanceof Error ? err.message : String(err), url: redactSecret(config.databaseUrl ?? '') },
      'error',
    );
    void pool.end();
    throw new PersistenceUnavailableError(
      `PostgreSQL is unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  try {
    if (config.schema) {
      await ensureSchema(client, config.schema);
      const ident = config.schema.replace(/[^A-Za-z0-9_]/g, '');
      await client.query(`SET search_path TO ${ident}`);
    }
    await client.query('SELECT 1');
    await migrate(client, loadMigrations());
    logPlatform('migration.success', { version: CURRENT_SCHEMA_VERSION, name: 'bootstrap' });
  } catch (err) {
    client.release();
    await pool.end();
    if (err instanceof PersistenceUnavailableError) throw err;
    logPlatform('db.unavailable', { error: err instanceof Error ? err.message : String(err) }, 'error');
    throw err;
  }
  client.release();
  return new PostgresPersistence(new PgTx(pool), clock);
}

function createRuntimeLeaseStore(tx: PgTx, clock: () => string): RuntimeLeaseStore {
  return {
    async upsert(actor, input) {
      const scoped = assertActor(actor, 'upsert runtime lease');
      const now = clock();
      const id = input.id ?? `rle_${randomUUID()}`;
      const result = await tx.query(
        `INSERT INTO runtime_leases (id, tenant_id, resource_key, owner, lease_until, status, metadata, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$8)
         ON CONFLICT (tenant_id, resource_key) DO UPDATE SET
           owner = EXCLUDED.owner, lease_until = EXCLUDED.lease_until, status = EXCLUDED.status,
           metadata = EXCLUDED.metadata, updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [
          id,
          scoped.tenantId,
          input.resourceKey,
          input.owner,
          input.leaseUntil,
          input.status,
          JSON.stringify(input.metadata ?? {}),
          now,
        ],
      );
      return mapLease(sqlRow(result.rows[0]!));
    },
    async get(actor, resourceKey) {
      const scoped = assertActor(actor, 'read runtime lease');
      const result = await tx.query(
        'SELECT * FROM runtime_leases WHERE tenant_id = $1 AND resource_key = $2',
        [scoped.tenantId, resourceKey],
      );
      return result.rows[0] ? mapLease(sqlRow(result.rows[0])) : null;
    },
    async expire(nowStamp) {
      const now = nowStamp ?? clock();
      const result = await tx.query(
        `UPDATE runtime_leases
         SET status = 'expired', owner = NULL, updated_at = $1
         WHERE lease_until IS NOT NULL AND lease_until <= $1::timestamptz AND status <> 'expired'
         RETURNING *`,
        [now],
      );
      return result.rows.map((row) => mapLease(sqlRow(row)));
    },
  };
}

function createArtefactStore(tx: PgTx, clock: () => string): ArtefactMetadataStore {
  const store: ArtefactMetadataStore = {
    async record(actor, input) {
      const scoped = assertActor(actor, 'record artefact metadata');
      const now = clock();
      const urn = `urn:atlas:artefact:${input.id}`;
      const result = await tx.query(
        `INSERT INTO artefact_metadata (
           id, urn, tenant_id, workspace_id, type, version, parent_id, created_by, execution_id, job_id,
           content_hash, mime_type, size_bytes, created_at, updated_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
         ON CONFLICT (id) DO UPDATE SET
           type = COALESCE(EXCLUDED.type, artefact_metadata.type),
           version = EXCLUDED.version,
           parent_id = COALESCE(EXCLUDED.parent_id, artefact_metadata.parent_id),
           created_by = COALESCE(EXCLUDED.created_by, artefact_metadata.created_by),
           execution_id = COALESCE(EXCLUDED.execution_id, artefact_metadata.execution_id),
           job_id = COALESCE(EXCLUDED.job_id, artefact_metadata.job_id),
           content_hash = COALESCE(EXCLUDED.content_hash, artefact_metadata.content_hash),
           mime_type = COALESCE(EXCLUDED.mime_type, artefact_metadata.mime_type),
           size_bytes = COALESCE(EXCLUDED.size_bytes, artefact_metadata.size_bytes),
           updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [
          input.id,
          urn,
          scoped.tenantId,
          input.workspaceId ?? scoped.workspaceId ?? null,
          input.type ?? null,
          input.version ?? 1,
          input.parentId ?? null,
          input.createdBy ?? scoped.principalId ?? null,
          input.executionId ?? null,
          input.jobId ?? null,
          input.contentHash,
          input.mimeType,
          input.sizeBytes,
          input.createdAt ?? now,
        ],
      );
      return mapArtefact(sqlRow(result.rows[0]!));
    },
    async get(actor, id) {
      const scoped = assertActor(actor, 'read artefact metadata');
      const result = await tx.query(
        'SELECT * FROM artefact_metadata WHERE id = $1 AND tenant_id = $2',
        [id, scoped.tenantId],
      );
      const mapped = result.rows[0] ? mapArtefact(sqlRow(result.rows[0])) : null;
      if (!mapped) return null;
      if (scoped.workspaceId && mapped.workspaceId && scoped.workspaceId !== mapped.workspaceId) return null;
      return mapped;
    },
    async list(actor, workspaceId) {
      const scoped = assertActor(actor, 'list artefact metadata');
      if (scoped.workspaceId && workspaceId && scoped.workspaceId !== workspaceId) return [];
      const result = workspaceId
        ? await tx.query(
            'SELECT * FROM artefact_metadata WHERE tenant_id = $1 AND workspace_id = $2 ORDER BY created_at',
            [scoped.tenantId, workspaceId],
          )
        : await tx.query('SELECT * FROM artefact_metadata WHERE tenant_id = $1 ORDER BY created_at', [scoped.tenantId]);
      return result.rows
        .map((row) => mapArtefact(sqlRow(row)))
        .filter((item) => !scoped.workspaceId || !item.workspaceId || item.workspaceId === scoped.workspaceId);
    },
    async createVersion(actor, parentId, input) {
      const scoped = assertActor(actor, 'version artefact');
      const parent = await store.get(actor, parentId);
      if (!parent) {
        throw new OwnershipError(`Fail-closed: artefact ${parentId} is not visible to tenant ${scoped.tenantId}.`);
      }
      if (parent.version !== input.expectedVersion) {
        throw new ConflictError(
          `Artefact ${parentId} version ${input.expectedVersion} does not match ${parent.version}.`,
        );
      }
      return store.record(actor, {
        id: input.id,
        workspaceId: parent.workspaceId,
        type: input.type ?? parent.type,
        version: parent.version + 1,
        parentId: parent.id,
        createdBy: input.createdBy ?? scoped.principalId ?? parent.createdBy,
        executionId: input.executionId ?? null,
        jobId: input.jobId ?? null,
        contentHash: input.contentHash,
        mimeType: input.mimeType ?? parent.mimeType,
        sizeBytes: input.sizeBytes ?? parent.sizeBytes,
      });
    },
  };
  return store;
}

export type { RuntimeLeaseRecord, ArtefactMetadata };
