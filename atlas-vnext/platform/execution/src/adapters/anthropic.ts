import type { StreamChunk, TokenUsage } from '@atlas-vnext/contracts';
import { ProviderHttpError, httpFailure, throwIfSecretLeaked, usageFromCounts } from '../errors.ts';
import { sanitizeText } from '../sanitize.ts';
import type { SecretStore } from '../secrets.ts';
import { parseSse } from '../stream-parse.ts';
import { AnthropicToolCallAssembler } from '../tool-call-buffer.ts';
import { readAllText, type HttpTransport } from '../transport.ts';
import type { ExecutionContext, ProviderAdapter } from '../types.ts';

export class AnthropicAdapter implements ProviderAdapter {
  readonly providerId = 'anthropic';

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
    const apiKey = this.options.secrets.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
      throw new Error('anthropic is unavailable: missing credentials.');
    }
    const upstream = this.options.modelMap?.[model] ?? model;
    const body: Record<string, unknown> = {
      model: upstream,
      max_tokens: 4096,
      stream: true,
      system: context.systemPrompt,
      messages: [{ role: 'user', content: context.prompt }],
    };
    if (context.tools?.length) {
      body.tools = context.tools.map((tool) => ({
        name: tool.id,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    }
    let response;
    try {
      response = await this.options.transport.send({
        url: `${this.options.baseUrl}/v1/messages`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': apiKey,
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

    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    const tools = new AnthropicToolCallAssembler();
    for await (const frame of parseSse(response.stream)) {
      if (context.signal?.aborted) throw new Error('Execution aborted.');
      let parsed: AnthropicEvent;
      try {
        parsed = JSON.parse(frame.data) as AnthropicEvent;
      } catch {
        yield { type: 'warning', message: 'Ignored malformed Anthropic SSE frame.', provider: this.providerId };
        continue;
      }
      const type = parsed.type ?? frame.event;
      if (type === 'error' && parsed.error?.message) {
        throw new ProviderHttpError(httpFailure(this.providerId, 400, parsed.error.message, [apiKey]));
      }
      if (type === 'content_block_start' && parsed.content_block) {
        tools.start(parsed.index ?? 0, parsed.content_block);
      }
      if (type === 'content_block_delta' && parsed.delta?.type === 'text_delta' && parsed.delta.text) {
        yield { type: 'text', text: parsed.delta.text };
      }
      if (type === 'content_block_delta' && parsed.delta?.type === 'thinking_delta' && parsed.delta.thinking) {
        yield { type: 'reasoning', text: parsed.delta.thinking };
      }
      if (type === 'content_block_delta' && parsed.delta?.type === 'input_json_delta') {
        tools.ingestDelta(parsed.index ?? 0, parsed.delta);
      }
      if (type === 'content_block_stop') {
        yield* tools.finishBlock(parsed.index ?? 0, this.providerId);
      }
      if (type === 'message_start' && parsed.message?.usage) {
        inputTokens = parsed.message.usage.input_tokens;
      }
      if (type === 'message_delta' && parsed.usage) {
        outputTokens = parsed.usage.output_tokens;
        if (parsed.usage.input_tokens != null) inputTokens = parsed.usage.input_tokens;
      }
    }
    yield* tools.finish(this.providerId);
    const usage = usageFromCounts(inputTokens, outputTokens);
    if (usage) yield { type: 'usage', usage };
  }
}

interface AnthropicEvent {
  type?: string;
  index?: number;
  error?: { message?: string };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
  content_block?: { type?: string; id?: string; name?: string };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
}

export type { TokenUsage };
