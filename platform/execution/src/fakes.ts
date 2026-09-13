import type { FailureClassification } from '@atlas/contracts';

import type { AdapterRequest, ProviderAdapter, StreamChunk } from './broker.js';
import { TransportError } from './broker.js';

/** Deterministic adapter for tests and local evals. Not a production client. */
export class FakeAdapter implements ProviderAdapter {
  constructor(
    readonly providerId: string,
    readonly modelId: string,
    private readonly chunks: StreamChunk[] = [{ type: 'text', text: `ok:${providerId}/${modelId}` }],
  ) {}

  async *stream(_request: AdapterRequest): AsyncGenerator<StreamChunk> {
    for (const chunk of this.chunks) yield chunk;
  }
}

export class FailingAdapter implements ProviderAdapter {
  constructor(
    readonly providerId: string,
    readonly modelId: string,
    private readonly classifiedAs: FailureClassification,
    private readonly message = 'injected failure',
  ) {}

  async *stream(_request: AdapterRequest): AsyncGenerator<StreamChunk> {
    throw new TransportError(this.classifiedAs, this.message, this.providerId);
  }
}

/** Yields visible text then dies — execution must not start another model. */
export class PartialThenFailAdapter implements ProviderAdapter {
  constructor(
    readonly providerId: string,
    readonly modelId: string,
    private readonly text = 'partial answer',
  ) {}

  async *stream(_request: AdapterRequest): AsyncGenerator<StreamChunk> {
    yield { type: 'text', text: this.text };
    throw new TransportError('abrupt_end', 'stream died after output', this.providerId);
  }
}

export class TransientThenOkAdapter implements ProviderAdapter {
  private calls = 0;

  constructor(
    readonly providerId: string,
    readonly modelId: string,
    readonly succeedOn = 2,
  ) {}

  async *stream(_request: AdapterRequest): AsyncGenerator<StreamChunk> {
    this.calls += 1;
    if (this.calls < this.succeedOn) {
      throw new TransportError('unavailable', 'transient', this.providerId);
    }
    yield { type: 'text', text: `recovered:${this.providerId}` };
  }
}
