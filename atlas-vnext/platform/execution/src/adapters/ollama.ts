import type { StreamChunk } from '@atlas-vnext/contracts';
import { ProviderHttpError, connectionFailure, httpFailure, usageFromCounts } from '../errors.ts';
import { sanitizeText } from '../sanitize.ts';
import { parseNdjson } from '../stream-parse.ts';
import { readAllText, type HttpTransport } from '../transport.ts';
import type { ExecutionContext, ProviderAdapter } from '../types.ts';

export class OllamaAdapter implements ProviderAdapter {
  readonly providerId: string;

  constructor(
    private readonly options: {
      transport: HttpTransport;
      timeoutMs: number;
      baseUrl: string;
      modelMap?: Record<string, string>;
      providerId?: string;
    },
  ) {
    this.providerId = options.providerId ?? 'ollama';
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  async discover(): Promise<string[]> {
    let response;
    try {
      response = await this.options.transport.send({
        url: `${this.options.baseUrl}/api/tags`,
        method: 'GET',
        headers: { accept: 'application/json' },
        timeoutMs: Math.min(this.options.timeoutMs, 8_000),
      });
    } catch (err) {
      throw new ProviderHttpError(connectionFailure(this.providerId, err instanceof Error ? err.message : String(err)));
    }
    if (response.status >= 400) {
      const text = await readAllText(response.stream);
      throw new ProviderHttpError(httpFailure(this.providerId, response.status, text));
    }
    const text = await readAllText(response.stream);
    let parsed: { models?: Array<{ name?: string }> };
    try {
      parsed = JSON.parse(text) as { models?: Array<{ name?: string }> };
    } catch {
      throw new ProviderHttpError(httpFailure(this.providerId, 502, 'invalid discovery payload'));
    }
    return (parsed.models ?? []).map((model) => model.name).filter((name): name is string => Boolean(name));
  }

  async *stream(model: string, context: ExecutionContext): AsyncGenerator<StreamChunk> {
    const upstream = this.options.modelMap?.[model] ?? model;
    const messages: Array<{ role: string; content: string }> = [];
    if (context.systemPrompt) messages.push({ role: 'system', content: context.systemPrompt });
    for (const turn of context.history ?? []) {
      if (turn.role === 'system') continue;
      messages.push({ role: turn.role, content: turn.content });
    }
    messages.push({ role: 'user', content: context.prompt });
    let response;
    try {
      response = await this.options.transport.send({
        url: `${this.options.baseUrl}/api/chat`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: upstream, messages, stream: true }),
        signal: context.signal,
        timeoutMs: this.options.timeoutMs,
      });
    } catch (err) {
      throw new ProviderHttpError(
        connectionFailure(this.providerId, sanitizeText(err instanceof Error ? err.message : String(err))),
      );
    }
    if (response.status >= 400) {
      const text = await readAllText(response.stream);
      throw new ProviderHttpError(httpFailure(this.providerId, response.status, text));
    }

    for await (const row of parseNdjson(response.stream)) {
      if (context.signal?.aborted) throw new Error('Execution aborted.');
      const event = row as OllamaChatEvent;
      if (event.error) {
        throw new ProviderHttpError(httpFailure(this.providerId, 400, event.error));
      }
      const content = event.message?.content;
      if (content) yield { type: 'text', text: content };
      if (event.done) {
        const usage = usageFromCounts(event.prompt_eval_count, event.eval_count);
        if (usage) yield { type: 'usage', usage };
      }
    }
  }
}

interface OllamaChatEvent {
  message?: { content?: string };
  done?: boolean;
  error?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}
