import { randomUUID } from 'node:crypto';
import { DEFAULT_RETENTION_BOUNDS } from '@atlas-vnext/contracts';
import type { DomainEvent, EventBus, EventPublishInput, EventReplayCursor } from '@atlas-vnext/events';
import { logPlatform } from '@atlas-vnext/observability';
import { OwnershipError } from '../errors.ts';
import { assertActor, type PersistenceActor } from '../actor.ts';
import { mapEvent, type EventRow } from './mappers.ts';
import type { PgTx } from './tx.ts';

const REQUIRED_EVENT_TYPES = new Set([
  'conversation.created',
  'execution.completed',
  'execution.failed',
  'execution.cancelled',
  'job.created',
  'job.completed',
  'job.failed',
  'job.cancelled',
  'job.waiting_runtime',
]);

export function createEventBus(tx: PgTx, actor: PersistenceActor | null, clock: () => string): EventBus {
  const listeners = new Map<string, Set<(event: DomainEvent) => void>>();

  function emit(recorded: DomainEvent): void {
    for (const listener of listeners.get(recorded.channel) ?? []) listener(recorded);
    for (const listener of listeners.get('*') ?? []) listener(recorded);
  }

  return {
    async publish(event: EventPublishInput): Promise<DomainEvent> {
      const tenantId = event.tenantId ?? actor?.tenantId;
      if (!tenantId?.trim()) {
        throw new OwnershipError('Fail-closed: cannot publish an event without a tenant id.');
      }
      if (actor && event.tenantId && event.tenantId !== actor.tenantId) {
        throw new OwnershipError('Fail-closed: cannot publish events for another tenant.');
      }
      const recorded = await tx.run(async () => {
        if (event.idempotencyKey) {
          const existing = await tx.query<EventRow>(
            'SELECT * FROM events WHERE tenant_id = $1 AND idempotency_key = $2',
            [tenantId, event.idempotencyKey],
          );
          if (existing.rows[0]) return mapEvent(existing.rows[0]);
        }
        await tx.query(
          `INSERT INTO event_streams (stream_id, tenant_id, next_seq)
           VALUES ($1, $2, 0)
           ON CONFLICT (tenant_id, stream_id) DO NOTHING`,
          [event.channel, tenantId],
        );
        const stream = await tx.query<{ next_seq: string | number; tenant_id: string }>(
          'SELECT next_seq, tenant_id FROM event_streams WHERE stream_id = $1 AND tenant_id = $2 FOR UPDATE',
          [event.channel, tenantId],
        );
        const streamRow = stream.rows[0];
        if (!streamRow) throw new Error(`Event stream ${event.channel} missing after insert.`);
        if (event.idempotencyKey) {
          const existing = await tx.query<EventRow>(
            'SELECT * FROM events WHERE tenant_id = $1 AND idempotency_key = $2',
            [tenantId, event.idempotencyKey],
          );
          if (existing.rows[0]) return mapEvent(existing.rows[0]);
        }
        const seq = Number(streamRow.next_seq) + 1;
        await tx.query('UPDATE event_streams SET next_seq = $3 WHERE stream_id = $1 AND tenant_id = $2', [
          event.channel,
          tenantId,
          seq,
        ]);
        const eventId = event.eventId ?? `evt_${randomUUID()}`;
        const timestamp = clock();
        const retainedUntil = REQUIRED_EVENT_TYPES.has(event.type) ? '9999-12-31T00:00:00.000Z' : null;
        const inserted = await tx.query<EventRow>(
          `INSERT INTO events (
             id, stream_id, seq, type, payload, tenant_id, workspace_id, conversation_id, job_id, idempotency_key, created_at, retained_until
           ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12)
           RETURNING *`,
          [
            eventId,
            event.channel,
            seq,
            event.type,
            JSON.stringify(event.payload ?? {}),
            tenantId,
            event.workspaceId ?? actor?.workspaceId ?? null,
            event.conversationId ?? null,
            event.jobId ?? null,
            event.idempotencyKey ?? null,
            timestamp,
            retainedUntil,
          ],
        );
        return mapEvent(inserted.rows[0]!);
      });
      emit(recorded);
      return recorded;
    },

    subscribe(channel, listener) {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(listener);
      return () => set?.delete(listener);
    },

    async history(channel) {
      return this.replay(channel);
    },

    async replay(channel, after?: EventReplayCursor) {
      const owner = actor ? assertActor(actor, 'replay events') : null;
      if (!owner && channel !== '*') {
        throw new OwnershipError('Fail-closed: event replay requires a tenant.');
      }
      if (after) {
        logPlatform('event.replay', { channel, tenantId: owner?.tenantId, afterSeq: after.seq, afterEventId: after.eventId });
      }
      let afterSeq = after?.seq;
      if (after?.eventId && afterSeq === undefined) {
        const found = await tx.query<{ seq: string | number }>(
          owner
            ? 'SELECT seq FROM events WHERE id = $1 AND tenant_id = $2'
            : 'SELECT seq FROM events WHERE id = $1',
          owner ? [after.eventId, owner.tenantId] : [after.eventId],
        );
        afterSeq = found.rows[0] ? Number(found.rows[0].seq) : undefined;
      }
      const params: unknown[] = [];
      const where: string[] = [];
      if (channel !== '*') {
        params.push(channel);
        where.push(`stream_id = $${params.length}`);
      }
      if (owner) {
        params.push(owner.tenantId);
        where.push(`tenant_id = $${params.length}`);
        if (owner.workspaceId) {
          params.push(owner.workspaceId);
          where.push(`(workspace_id IS NULL OR workspace_id = $${params.length})`);
        }
      }
      if (typeof afterSeq === 'number') {
        params.push(afterSeq);
        where.push(`seq > $${params.length}`);
      }
      const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY stream_id, seq ASC`;
      const result = await tx.query<EventRow>(sql, params);
      return result.rows.map(mapEvent);
    },
  };
}

export async function applyEventRetention(tx: PgTx, maxEntries = DEFAULT_RETENTION_BOUNDS.maxEventLogEntries): Promise<number> {
  const result = await tx.query<{ id: string }>(
    `WITH ranked AS (
       SELECT id, ROW_NUMBER() OVER (PARTITION BY stream_id ORDER BY seq DESC) AS rank
       FROM events
     )
     DELETE FROM events
     WHERE id IN (SELECT id FROM ranked WHERE rank > $1)
       AND (retained_until IS NULL OR retained_until <= now())
     RETURNING id`,
    [maxEntries],
  );
  return result.rowCount ?? result.rows.length;
}
