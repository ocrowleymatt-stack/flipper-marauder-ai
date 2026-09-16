import type { StreamChunk } from '@atlas-vnext/contracts';
import { ProviderHttpError, httpFailure, throwIfSecretLeaked, usageFromCounts } from '../errors.ts';
import { sanitizeText } from '../sanitize.ts';
import { geminiApiKey, type SecretStore } from '../secrets.ts';
import { parseSse } from '../stream-parse.ts';
import { GeminiFunctionCallAssembler } from '../tool-call-buffer.ts';
import { readAllText, type HttpTransport } from '../transport.ts';
import { geminiContentsFrom, geminiToolsFrom } from '../tool-transcript.ts';
import type { ExecutionContext, ProviderAdapter } from '../types.ts';

export class GeminiAdapter implements ProviderAdapter {
  readonly providerId = 'gemini';

  constructor(
    private readonly options: {
      secrets: SecretStore;
      transport: HttpTransport;
      timeoutMs: number;
      baseUrl: string;
      modelMap?: Record<string, string>;
    },
  ) {}

  async *stream(model: string, context: ExecutionContext): AsyncGenerator<StreamChunk> {
    const apiKey = geminiApiKey(this.options.secrets);
    if (!apiKey) {
      throw new Error('gemini is unavailable: missing credentials.');
    }
    const upstream = this.options.modelMap?.[model] ?? model;
    const body: Record<string, unknown> = {
      contents: geminiContentsFrom(context),
    };
    const toolDeclarations = geminiToolsFrom(context);
    if (toolDeclarations) body.tools = toolDeclarations;
    let response;
    try {
      response = await this.options.transport.send({
        url: `${this.options.baseUrl}/models/${encodeURIComponent(upstream)}:streamGenerateContent?alt=sse`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
        signal: context.signal,
        timeoutMs: this.options.timeoutMs,
      });
    } catch (err) {
      throw new Error(sanitizeText(err instanceof Error ? err.message : String(err), [apiKey]));
    }

    if (response.status >= 400) {
      const text = await readAllText(response.stream);
      const failure = httpFailure(this.providerId, response.status, text, [apiKey]);
      throwIfSecretLeaked(failure.message, apiKey);
      throw new ProviderHttpError(failure);
    }

    const tools = new GeminiFunctionCallAssembler();
    for await (const frame of parseSse(response.stream)) {
      if (context.signal?.aborted) throw new Error('Execution aborted.');
      let parsed: GeminiEvent;
      try {
        parsed = JSON.parse(frame.data) as GeminiEvent;
      } catch {
        yield { type: 'warning', message: 'Ignored malformed Gemini SSE frame.', provider: this.providerId };
        continue;
      }
      if (parsed.error?.message) {
        throw new ProviderHttpError(httpFailure(this.providerId, parsed.error.code ?? 400, parsed.error.message, [apiKey]));
      }
      const candidate = parsed.candidates?.[0];
      let partIndex = 0;
      for (const part of candidate?.content?.parts ?? []) {
        if (part.thought && part.text) yield { type: 'reasoning', text: part.text };
        else if (part.text) yield { type: 'text', text: part.text };
        if (part.functionCall) {
          tools.ingest(part, partIndex);
        }
        partIndex += 1;
      }
      const usage = usageFromCounts(
        parsed.usageMetadata?.promptTokenCount,
        parsed.usageMetadata?.candidatesTokenCount,
        parsed.usageMetadata?.totalTokenCount,
      );
      if (usage) yield { type: 'usage', usage };
    }
    yield* tools.finish(this.providerId);
  }
}

interface GeminiEvent {
  error?: { message?: string; code?: number };
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        thought?: boolean;
        functionCall?: { name?: string; args?: unknown; id?: string };
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}
