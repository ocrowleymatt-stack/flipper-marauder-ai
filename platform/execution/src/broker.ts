import type { FailureClassification, RouteCandidate, RouteDecision } from '@atlas/contracts';

export class TransportError extends Error {
  readonly classifiedAs: FailureClassification;
  readonly providerId: string | undefined;
  readonly retryable: boolean;

  constructor(classifiedAs: FailureClassification, message: string, providerId?: string) {
    super(message);
    this.name = 'TransportError';
    this.classifiedAs = classifiedAs;
    this.providerId = providerId;
    this.retryable = classifiedAs === 'timeout' || classifiedAs === 'unavailable' || classifiedAs === 'abrupt_end';
  }
}

export type TextChunk = { type: 'text'; text: string };
export type ToolCallChunk = {
  type: 'tool_call';
  call: { id: string; toolId: string; arguments: Record<string, unknown> };
};
export type StreamChunk = TextChunk | ToolCallChunk;

export type AdapterRequest = {
  candidate: RouteCandidate;
  prompt: string;
  signal?: AbortSignal;
};

export interface ProviderAdapter {
  readonly providerId: string;
  readonly modelId?: string;
  stream(request: AdapterRequest): AsyncGenerator<StreamChunk>;
}

export type ExecutionRequest = {
  decision: RouteDecision;
  prompt: string;
  signal?: AbortSignal;
  /** Explicit decisions must not invent extra candidates. Capability lists may be walked. */
  allowFallback?: boolean;
};

export type BrokerEvent =
  | { type: 'attempt'; providerId: string; modelId: string; attempt: number }
  | { type: 'retry'; providerId: string; modelId: string; attempt: number; reason: FailureClassification }
  | { type: 'fallback'; from: string; to: string; reason: FailureClassification }
  | { type: 'text'; text: string; providerId: string; modelId: string }
  | { type: 'tool_call'; call: ToolCallChunk['call']; providerId: string; modelId: string }
  | { type: 'completed'; providerId: string; modelId: string };

const RETRYABLE = new Set<FailureClassification>(['timeout', 'unavailable', 'abrupt_end']);

export type ExecutionBrokerOptions = {
  maxTransientAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  circuitOpenMs?: number;
  circuitFailures?: number;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classify(error: unknown): TransportError {
  if (error instanceof TransportError) return error;
  return new TransportError('unknown', error instanceof Error ? error.message : 'unknown execution error');
}

function adapterKey(adapter: ProviderAdapter): string {
  return adapter.modelId ? `${adapter.providerId}/${adapter.modelId}` : adapter.providerId;
}

/**
 * Walks Nexus candidates. Retries and streaming live here, not in Nexus.
 */
export class ExecutionBroker {
  private readonly maxTransientAttempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly circuitOpenMs: number;
  private readonly circuitFailures: number;
  private readonly failureCounts = new Map<string, number>();
  private readonly openUntil = new Map<string, number>();

  constructor(
    private readonly adapters: ProviderAdapter[],
    options: ExecutionBrokerOptions = {},
  ) {
    this.maxTransientAttempts = Math.max(1, options.maxTransientAttempts ?? 2);
    this.baseDelayMs = Math.max(0, options.baseDelayMs ?? 150);
    this.sleep = options.sleep ?? delay;
    this.circuitOpenMs = options.circuitOpenMs ?? 30_000;
    this.circuitFailures = options.circuitFailures ?? 3;
  }

  private findAdapter(candidate: RouteCandidate): ProviderAdapter | undefined {
    return this.adapters.find(
      (adapter) =>
        adapter.providerId === candidate.providerId &&
        (adapter.modelId === undefined || adapter.modelId === candidate.modelId),
    );
  }

  private circuitClosed(providerId: string): boolean {
    const until = this.openUntil.get(providerId);
    if (until && until > Date.now()) return false;
    if (until) this.openUntil.delete(providerId);
    return true;
  }

  private recordFailure(providerId: string): void {
    const count = (this.failureCounts.get(providerId) ?? 0) + 1;
    this.failureCounts.set(providerId, count);
    if (count >= this.circuitFailures) {
      this.openUntil.set(providerId, Date.now() + this.circuitOpenMs);
    }
  }

  private recordSuccess(providerId: string): void {
    this.failureCounts.delete(providerId);
    this.openUntil.delete(providerId);
  }

  async *execute(request: ExecutionRequest): AsyncGenerator<BrokerEvent> {
    const allowFallback = request.allowFallback ?? request.decision.trace.explicit === null;
    const candidates = allowFallback ? request.decision.candidates : request.decision.candidates.slice(0, 1);
    let lastError: TransportError | null = null;

    for (const [index, candidate] of candidates.entries()) {
      if (!this.circuitClosed(candidate.providerId)) {
        lastError = new TransportError('unavailable', `Circuit open for ${candidate.providerId}`, candidate.providerId);
        continue;
      }
      const adapter = this.findAdapter(candidate);
      if (!adapter) {
        lastError = new TransportError('unavailable', `No adapter for ${candidate.providerId}/${candidate.modelId}`, candidate.providerId);
        continue;
      }

      for (let attempt = 1; attempt <= this.maxTransientAttempts; attempt += 1) {
        yield { type: 'attempt', providerId: candidate.providerId, modelId: candidate.modelId, attempt };
        let emittedVisibleText = false;
        const bufferedToolCalls: ToolCallChunk[] = [];
        try {
          for await (const chunk of adapter.stream({
            candidate,
            prompt: request.prompt,
            signal: request.signal,
          })) {
            if (request.signal?.aborted) {
              throw new TransportError('cancelled', 'Execution aborted', candidate.providerId);
            }
            if (chunk.type === 'tool_call') {
              bufferedToolCalls.push(chunk);
              continue;
            }
            if (chunk.text.length > 0) emittedVisibleText = true;
            yield {
              type: 'text',
              text: chunk.text,
              providerId: candidate.providerId,
              modelId: candidate.modelId,
            };
          }
          for (const chunk of bufferedToolCalls) {
            yield {
              type: 'tool_call',
              call: chunk.call,
              providerId: candidate.providerId,
              modelId: candidate.modelId,
            };
          }
          this.recordSuccess(candidate.providerId);
          yield { type: 'completed', providerId: candidate.providerId, modelId: candidate.modelId };
          return;
        } catch (error) {
          if (request.signal?.aborted) throw classify(error);
          const classified = classify(error);
          this.recordFailure(candidate.providerId);
          if (emittedVisibleText) throw classified;
          lastError = classified;
          const canRetry = RETRYABLE.has(classified.classifiedAs) && attempt < this.maxTransientAttempts;
          if (canRetry) {
            yield {
              type: 'retry',
              providerId: candidate.providerId,
              modelId: candidate.modelId,
              attempt: attempt + 1,
              reason: classified.classifiedAs,
            };
            const waitMs = this.baseDelayMs * attempt;
            if (waitMs > 0) await this.sleep(waitMs);
            continue;
          }
          const next = candidates[index + 1];
          if (next && allowFallback) {
            yield {
              type: 'fallback',
              from: `${candidate.providerId}/${candidate.modelId}`,
              to: `${next.providerId}/${next.modelId}`,
              reason: classified.classifiedAs,
            };
          }
          break;
        }
      }
    }

    throw (
      lastError ??
      new TransportError('unavailable', 'Every candidate failed before producing output')
    );
  }
}
