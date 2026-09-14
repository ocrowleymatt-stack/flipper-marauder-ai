import type { StreamChunk } from '@atlas-vnext/contracts';
import { OpenAICompatibleAdapter } from './openai-compatible.ts';
import { MapSecretStore, type SecretStore } from '../secrets.ts';
import type { HttpTransport } from '../transport.ts';
import type { ExecutionContext, ProviderAdapter } from '../types.ts';
import { profileForModel, type RuntimeProfileId } from '../runtime/types.ts';
import type { RuntimeScheduler } from '../runtime/scheduler.ts';

export interface RunPodAdapterOptions {
  scheduler: RuntimeScheduler;
  secrets: SecretStore;
  transport: HttpTransport;
  timeoutMs: number;
  inferenceBaseUrl?: string | null;
  modelMap?: Record<string, string>;
  createInference?: (baseUrl: string) => ProviderAdapter;
}

/**
 * RunPod inference adapter. Owns lease/lifecycle via RuntimeScheduler.
 * Token generation uses the OpenAI-compatible adapter against the warm pod.
 * Startup delay is expected; a stopped pod is not a platform failure.
 */
export class RunPodAdapter implements ProviderAdapter {
  readonly providerId = 'runpod';

  constructor(private readonly options: RunPodAdapterOptions) {}

  async *stream(model: string, context: ExecutionContext): AsyncGenerator<StreamChunk> {
    const jobId = context.traceId ?? `runpod_${Date.now()}`;
    const profile: RuntimeProfileId = profileForModel(model);
    yield {
      type: 'warning',
      message: this.options.scheduler.waitingMessage(jobId),
      provider: this.providerId,
    };
    const lease = await this.options.scheduler.acquire({
      id: jobId,
      profile,
      workloadType: 'inference',
      requestedModel: model,
      traceId: context.traceId ?? jobId,
      signal: context.signal,
    });
    try {
      await this.options.scheduler.heartbeat(lease.id);
      const baseUrl =
        this.options.inferenceBaseUrl ?? this.options.scheduler.inferenceBaseUrl() ?? '';
      if (!baseUrl) {
        throw new Error('runpod inference URL is not configured.');
      }
      const inner =
        this.options.createInference?.(baseUrl) ??
        new OpenAICompatibleAdapter({
          providerId: 'runpod',
          baseUrl,
          secretName: 'RUNPOD_API_KEY',
          secrets: new MapSecretStore({
            RUNPOD_API_KEY: this.options.secrets.get('RUNPOD_API_KEY'),
          }),
          transport: this.options.transport,
          timeoutMs: this.options.timeoutMs,
          modelMap: this.options.modelMap,
          includeStreamUsage: false,
          credentialsOptional: true,
          authHeaders: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
        });
      yield* inner.stream(model, context);
    } finally {
      await this.options.scheduler.release(lease.id);
    }
  }
}
