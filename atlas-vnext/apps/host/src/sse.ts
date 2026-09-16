import type { ServerResponse } from 'node:http';
import {
  closeAsyncIteratorBounded,
  delayUnref,
  ITERATOR_TEARDOWN_BUDGET_MS,
} from '@atlas-vnext/conversation';
import { DEFAULT_OPERATIONAL_LIMITS } from '@atlas-vnext/contracts';
import { writeSse } from './http.ts';
import type { ResourceGuard } from './limits.ts';

export type SseCancelReason = 'idle_timeout' | 'disconnect' | 'output_limit';

/**
 * Guarded SSE lifecycle shared by conversation turns and Caspa generation.
 *
 * Admission, idle timeout, disconnect, runtime cancellation, generated-output
 * accounting, and bounded/idempotent `iterator.return()` teardown all live here
 * so a second stream path cannot drift away from the protections.
 */
export async function pipeSse(
  res: ServerResponse,
  events: AsyncIterable<{ type: string }>,
  idleMs: number,
  onCancel?: (executionId: string | undefined, reason: SseCancelReason) => Promise<void> | void,
  maxGeneratedBytes = DEFAULT_OPERATIONAL_LIMITS.maxGeneratedBytes,
): Promise<void> {
  const iterator = events[Symbol.asyncIterator]();
  let idle: ReturnType<typeof setTimeout> | undefined;
  let executionId: string | undefined;
  let terminal: Promise<void> | undefined;
  let finished = false;
  let assistantBytes = 0;
  let reasoningBytes = 0;
  let pendingNext: Promise<unknown> | undefined;
  let iteratorClosed = false;

  const disarmIdle = (): void => {
    if (idle) clearTimeout(idle);
    idle = undefined;
  };

  const closeIterator = async (): Promise<void> => {
    if (iteratorClosed) return;
    iteratorClosed = true;
    const pending = pendingNext;
    if (pending) {
      await Promise.race([Promise.resolve(pending).then(() => undefined, () => undefined), delayUnref(ITERATOR_TEARDOWN_BUDGET_MS)]);
    }
    await closeAsyncIteratorBounded(iterator);
  };

  const terminate = (reason: SseCancelReason): Promise<void> => {
    if (!terminal) {
      terminal = (async () => {
        disarmIdle();
        try {
          await onCancel?.(executionId, reason);
        } catch {
          // Runtime cancellation is idempotent; never fail the HTTP teardown.
        }
        await closeIterator();
        if (reason === 'idle_timeout' && !res.writableEnded && !res.destroyed) {
          writeSse(res, 'error', {
            type: 'error',
            failure: { code: 'timeout', message: 'Stream idle timeout.', retryable: true, at: new Date().toISOString() },
          });
        }
        if (reason === 'output_limit' && !res.writableEnded && !res.destroyed) {
          writeSse(res, 'error', {
            type: 'error',
            failure: {
              code: 'payload_too_large',
              message: 'generated exceeds the configured limit.',
              retryable: false,
              at: new Date().toISOString(),
            },
          });
        }
        if (!res.writableEnded) res.end();
      })();
    }
    return terminal;
  };

  const request = res.req;
  const disconnected = new Promise<'disconnect'>((resolve) => {
    const onClose = (): void => resolve('disconnect');
    res.once('close', onClose);
    request?.once('close', onClose);
    request?.once('aborted', onClose);
  });

  try {
    while (!terminal && !res.destroyed && !res.writableEnded) {
      const next = iterator.next().then(
        (result) => ({ kind: 'next' as const, result }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      );
      pendingNext = next;
      const idleWait = new Promise<{ kind: 'idle' }>((resolve) => {
        idle = setTimeout(() => resolve({ kind: 'idle' }), idleMs);
      });
      const winner = await Promise.race([next, idleWait, disconnected.then(() => ({ kind: 'disconnect' as const }))]);
      disarmIdle();
      if (winner.kind === 'idle') {
        await terminate('idle_timeout');
        return;
      }
      if (winner.kind === 'disconnect') {
        await terminate('disconnect');
        return;
      }
      pendingNext = undefined;
      if (winner.kind === 'error') {
        throw winner.error;
      }
      if (winner.result.done) {
        finished = true;
        break;
      }
      const event = winner.result.value;
      const seen = executionIdFromEvent(event);
      if (seen) executionId = seen;
      if (terminal || res.destroyed || res.writableEnded) break;
      const projected = projectGeneratedBytes(eventForAccounting(event), assistantBytes, reasoningBytes);
      if (projected && projected.total > maxGeneratedBytes) {
        await terminate('output_limit');
        return;
      }
      if (projected) {
        assistantBytes = projected.assistantBytes;
        reasoningBytes = projected.reasoningBytes;
      }
      writeSse(res, event.type, event);
    }
  } finally {
    disarmIdle();
    if (!finished && !terminal) {
      await terminate('disconnect');
    } else if (!res.writableEnded) {
      res.end();
    }
    await closeIterator();
  }
}

/**
 * Acquire stream then run permits. If a later stage fails, every permit already
 * taken for this request is released exactly once.
 */
export function acquireRunAndStreamPermits(resources: ResourceGuard | undefined, tenantId: string): () => void {
  const acquired: Array<() => void> = [];
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    while (acquired.length) {
      acquired.pop()?.();
    }
  };
  if (!resources) return release;
  try {
    acquired.push(resources.beginStream(tenantId));
    acquired.push(resources.beginRun(tenantId));
    return release;
  } catch (err) {
    release();
    throw err;
  }
}

export function executionIdFromEvent(event: { type: string }): string | undefined {
  const record = event as { execution?: { id?: unknown }; executionId?: unknown; event?: unknown };
  if (record.execution && typeof record.execution.id === 'string' && record.execution.id) {
    return record.execution.id;
  }
  if (typeof record.executionId === 'string' && record.executionId) {
    return record.executionId;
  }
  if (record.event && typeof record.event === 'object' && record.event !== null && record.event !== event) {
    return executionIdFromEvent(record.event as { type: string });
  }
  return undefined;
}

function eventForAccounting(event: { type: string }): { type: string } {
  const record = event as { type: string; event?: { type?: unknown } };
  if (record.type === 'execution' && record.event && typeof record.event === 'object' && typeof record.event.type === 'string') {
    return record.event as { type: string };
  }
  return event;
}

function projectGeneratedBytes(
  event: { type: string },
  assistantBytes: number,
  reasoningBytes: number,
): { assistantBytes: number; reasoningBytes: number; total: number } | null {
  const record = event as { type: string; text?: unknown; content?: unknown };
  if (record.type === 'assistant.delta') {
    const extra = typeof record.text === 'string' ? Buffer.byteLength(record.text, 'utf8') : 0;
    const nextAssistant = assistantBytes + extra;
    return { assistantBytes: nextAssistant, reasoningBytes, total: nextAssistant + reasoningBytes };
  }
  if (record.type === 'assistant.completed') {
    const bytes = typeof record.text === 'string' ? Buffer.byteLength(record.text, 'utf8') : 0;
    const nextAssistant = Math.max(assistantBytes, bytes);
    return { assistantBytes: nextAssistant, reasoningBytes, total: nextAssistant + reasoningBytes };
  }
  if (record.type === 'message.delta') {
    // True incremental text is already counted on assistant.delta; do not double-count.
    return null;
  }
  if (record.type === 'reasoning.delta') {
    const extra = typeof record.text === 'string' ? Buffer.byteLength(record.text, 'utf8') : 0;
    const nextReasoning = reasoningBytes + extra;
    return { assistantBytes, reasoningBytes: nextReasoning, total: assistantBytes + nextReasoning };
  }
  return null;
}
