import type { StreamChunk, TokenUsage } from '@atlas-vnext/contracts';
import { ProviderHttpError, httpFailure } from '../errors.ts';
import { sanitizeText } from '../sanitize.ts';
import { parseSse } from '../stream-parse.ts';
import { OpenAIToolCallAssembler } from '../tool-call-buffer.ts';
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
  chatPath?: string;
  includeStreamUsage?: boolean;
  /** Private LAN inference may omit a bearer token. */
  credentialsOptional?: boolean;
}

/**
 * OpenAI Chat Completions SSE protocol. Used by OpenAI, Venice, xAI, Forge, and RunPod inference.
 * Protocol details terminate here; callers only see StreamChunk.
 */
export class OpenAICompatibleAdapter implements ProviderAdapter {
  constructor(private readonly options: OpenAICompatibleOptions) {}

  get providerId(): string {
    return this.options.providerId;
  }

  async *stream(model: string, context: ExecutionContext): AsyncGenerator<StreamChunk> {
    const apiKey = this.options.secrets.get(this.options.secretName);
    if (!apiKey && !this.options.credentialsOptional) {
      throw new Error(`${this.providerId} is unavailable: missing credentials.`);
    }
    const upstream = this.options.modelMap?.[model] ?? model;
    const body: Record<string, unknown> = {
      model: upstream,
      stream: true,
      messages: messagesFrom(context),
      ...this.options.extraBody,
    };
    if (this.options.includeStreamUsage !== false) {
      body.stream_options = { include_usage: true };
    }
    const tools = toolsFrom(context);
    if (tools) body.tools = tools;

    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (apiKey) Object.assign(headers, this.options.authHeaders(apiKey));

    const chatPath = this.options.chatPath ?? '/chat/completions';
    let response;
    try {
      response = await this.options.transport.send({
        url: `${this.options.baseUrl}${chatPath.startsWith('/') ? chatPath : `/${chatPath}`}`,
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: context.signal,
        timeoutMs: this.options.timeoutMs,
      });
    } catch (err) {
      throw new Error(sanitizeText(err instanceof Error ? err.message : String(err)));
    }

    if (response.status >= 400) {
      const text = await readAllText(response.stream);
      const failure = httpFailure(this.providerId, response.status, text);
      if (apiKey) {
        failure.message = failure.message.split(apiKey).join('[redacted]');
      }
      throw new ProviderHttpError(failure);
    }

    const toolCalls = new OpenAIToolCallAssembler();
    for await (const frame of parseSse(response.stream)) {
      if (context.signal?.aborted) throw new Error('Execution aborted.');
      if (frame.data === '[DONE]') {
        yield* toolCalls.finish(this.providerId);
        return;
      }
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
      const reasoning = delta?.reasoning_content ?? delta?.reasoning;
      if (reasoning) {
        yield { type: 'reasoning', text: reasoning };
      }
      if (delta?.content) {
        yield { type: 'text', text: delta.content };
      }
      if (delta?.tool_calls) {
        toolCalls.ingest(delta.tool_calls);
      }
      const usage = usageFromOpenAI(parsed.usage);
      if (usage) yield { type: 'usage', usage };
    }
    yield* toolCalls.finish(this.providerId);
  }
}

interface OpenAIStreamPayload {
  error?: { message?: string };
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

function usageFromOpenAI(usage: OpenAIStreamPayload['usage']): TokenUsage | null {
  if (!usage) return null;
  if (usage.prompt_tokens == null || usage.completion_tokens == null) return null;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens,
  };
}

function messagesFrom(context: ExecutionContext): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  if (context.systemPrompt) messages.push({ role: 'system', content: context.systemPrompt });
  messages.push({ role: 'user', content: context.prompt });
  return messages;
}

function toolsFrom(context: ExecutionContext): Array<Record<string, unknown>> | null {
  if (!context.tools?.length) return null;
  return context.tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.id,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}
