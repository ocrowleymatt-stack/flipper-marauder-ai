import type { RouteDecision, StreamChunk, StructuredFailure } from '@atlas-vnext/contracts';
import { CircuitBreaker } from './circuit-breaker.ts';
import type { ExecutionContext, ExecutionObserver, ProviderAdapter } from './types.ts';

const DEFAULT_ATTEMPTS = 2;

/**
 * Execution broker: HOW a RouteDecision runs.
 * Owns retries, circuit breakers, streaming, and transactional tool buffering.
 * Does not choose routes (that's Nexus).
 */
export class ExecutionBroker {
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(private readonly attemptsPerCandidate = DEFAULT_ATTEMPTS) {}

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.providerId, adapter);
  }

  breaker(providerId: string): CircuitBreaker {
    let breaker = this.breakers.get(providerId);
    if (!breaker) {
      breaker = new CircuitBreaker();
      this.breakers.set(providerId, breaker);
    }
    return breaker;
  }

  async *execute(
    decision: RouteDecision,
    context: ExecutionContext,
    observer?: ExecutionObserver,
  ): AsyncGenerator<StreamChunk> {
    let lastError: Error | null = null;
    let attemptIndex = 0;

    for (const candidate of decision.candidateChain) {
      const slash = candidate.indexOf('/');
      const provider = candidate.slice(0, slash);
      const model = candidate.slice(slash + 1);
      if (!provider || !model) continue;

      const adapter = this.adapters.get(provider);
      if (!adapter) {
        attemptIndex += 1;
        observer?.onAttempt({
          index: attemptIndex,
          provider,
          model,
          outcome: 'skipped',
          error: failure('no_adapter', `No adapter registered for ${provider}.`, false),
          emittedVisibleOutput: false,
        });
        continue;
      }

      const breaker = this.breaker(provider);
      if (breaker.isOpen()) {
        attemptIndex += 1;
        observer?.onAttempt({
          index: attemptIndex,
          provider,
          model,
          outcome: 'skipped',
          error: failure('circuit_open', `Circuit open for ${provider}.`, true),
          emittedVisibleOutput: false,
        });
        continue;
      }

      for (let attempt = 1; attempt <= this.attemptsPerCandidate; attempt += 1) {
        const bufferedTools: StreamChunk[] = [];
        let visibleText = false;
        attemptIndex += 1;
        observer?.onAttempt({
          index: attemptIndex,
          provider,
          model,
          outcome: 'started',
          error: null,
          emittedVisibleOutput: false,
        });

        try {
          for await (const chunk of adapter.stream(model, context)) {
            if (context.signal?.aborted) {
              throw new Error('Execution aborted.');
            }
            if (chunk.type === 'tool_call') {
              bufferedTools.push(chunk);
              continue;
            }
            if (chunk.type === 'text' && chunk.text.length > 0) {
              visibleText = true;
            }
            yield chunk;
          }

          for (const call of bufferedTools) {
            yield call;
          }
          breaker.success();
          observer?.onAttempt({
            index: attemptIndex,
            provider,
            model,
            outcome: context.signal?.aborted ? 'cancelled' : 'succeeded',
            error: null,
            emittedVisibleOutput: visibleText,
          });
          observer?.onSelected?.({ provider, model });
          return;
        } catch (err) {
          breaker.failure();
          lastError = err instanceof Error ? err : new Error(String(err));
          const aborted = context.signal?.aborted || lastError.message === 'Execution aborted.';
          observer?.onAttempt({
            index: attemptIndex,
            provider,
            model,
            outcome: aborted ? 'cancelled' : 'failed',
            error: failure(aborted ? 'cancelled' : 'provider_error', lastError.message, !visibleText && !aborted),
            emittedVisibleOutput: visibleText,
          });

          if (visibleText || aborted) {
            throw lastError;
          }
        }
      }
    }

    throw new Error(
      `Execution failed for ${decision.candidateChain.join(' → ')}: ${lastError?.message ?? 'no adapter'}`,
    );
  }
}

function failure(code: string, message: string, retryable: boolean): StructuredFailure {
  return { code, message, retryable, at: new Date().toISOString() };
}
