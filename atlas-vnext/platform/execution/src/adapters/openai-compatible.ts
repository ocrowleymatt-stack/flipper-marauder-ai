import type { StreamChunk, TokenUsage } from '@atlas-vnext/contracts';
import { ProviderHttpError, httpFailure, usageFromCounts } from '../errors.ts';
import { sanitizeText } from '../sanitize.ts';
import { parseSse } from '../stream-parse.ts';
import { readAllText, type HttpTransport } from '../transport.ts';
import type { SecretStore } from '../secrets.ts';
import type { ExecutionContext, ProviderAdapter } from '../types.ts';

export interface OpenAICompatibleOptions {
  providerId: string;
  baseUrl: string;
  secretName: string;
  secrets: SecretStore;
  transport: HttpTransport;
  timeoutMs: number;
  authHeaders: (apiKey: string) => Record<string, string>;
  extraBody?: Record<string, unknown>;
  modelMap?: Record<string, string>;
}

/**
 * OpenAI Chat Completions SSE protocol. Used by OpenAI and Venice.
 * Protocol details terminate here; callers only see StreamChunk.
 */
export class OpenAICompatibleAdapter implements ProviderAdapter {
  constructor(private readonly options: OpenAICompatibleOptions) {}

  get providerId(): string {
    return this.options.providerId;
  }

  async *stream(model: string, context: ExecutionContext): AsyncGenerator<StreamChunk> {
    const apiKey = this.options.secrets.get(this.options.secretName);
    if (!apiKey) {
      throw new Error(`${this.providerId} is unavailable: missing credentials.`);
    }
    const upstream = this.options.modelMap?.[model] ?? model;
    const body = {
      model: upstream,
      stream: true,
      stream_options: { include_usage: true },
      messages: messagesFrom(context),
      ...this.options.extraBody,
    };
    let response;
    try {
      response = await this.options.transport.send({
        url: `${this.options.baseUrl}/chat/completions`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.options.authHeaders(apiKey),
        },
        body: JSON.stringify(body),
        signal: context.signal,
        timeoutMs: this.options.timeoutMs,
      });
    } catch (err) {
      throw new Error(sanitizeText(err instanceof Error ? err.message : String(err)));
    }

    if (response.status >= 400) {
      const text = await readAllText(response.stream);
      throw new ProviderHttpError(httpFailure(this.providerId, response.status, text));
    }

    for await (const frame of parseSse(response.stream)) {
      if (context.signal?.aborted) throw new Error('Execution aborted.');
      if (frame.data === '[DONE]') return;
      let parsed: OpenAIStreamPayload;
      try {
        parsed = JSON.parse(frame.data) as OpenAIStreamPayload;
      } catch {
        yield { type: 'warning', message: 'Ignored malformed SSE frame.', provider: this.providerId };
        continue;
      }
      if (parsed.error?.message) {
        throw new ProviderHttpError(httpFailure(this.providerId, 400, parsed.error.message));
      }
      const choice = parsed.choices?.[0];
      const delta = choice?.delta;
      if (delta?.reasoning_content) {
        yield { type: 'reasoning', text: delta.reasoning_content };
      }
      if (delta?.content) {
        yield { type: 'text', text: delta.content };
      }
      if (delta?.tool_calls) {
        for (const call of delta.tool_calls) {
          if (!call.id || !call.function?.name) continue;
          let args: Record<string, unknown> = {};
          try {
            args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
          } catch {
            args = { raw: call.function.arguments };
          }
          yield { type: 'tool_call', call: { id: call.id, toolId: call.function.name, arguments: args } };
        }
      }
      const usage = usageFromOpenAI(parsed.usage);
      if (usage) yield { type: 'usage', usage };
    }
  }
}

interface OpenAIStreamPayload {
  error?: { message?: string };
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

function usageFromOpenAI(usage: OpenAIStreamPayload['usage']): TokenUsage | null {
  if (!usage) return null;
  return usageFromCounts(usage.prompt_tokens, usage.completion_tokens, usage.total_tokens);
}

function messagesFrom(context: ExecutionContext): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  if (context.systemPrompt) messages.push({ role: 'system', content: context.systemPrompt });
  messages.push({ role: 'user', content: context.prompt });
  return messages;
}
