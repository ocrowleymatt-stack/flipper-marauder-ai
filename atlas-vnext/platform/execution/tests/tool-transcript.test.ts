import { describe, expect, it } from 'vitest';
import type { StreamChunk } from '@atlas-vnext/contracts';
import {
  AnthropicAdapter,
  GeminiAdapter,
  MapSecretStore,
  createOpenAIAdapter,
  fromProviderToolName,
  responseFromText,
  toProviderToolName,
  type ExecutionContext,
  type HttpRequest,
  type HttpTransport,
} from '@atlas-vnext/execution';

const KEY = 'sk-test-secret-value-do-not-leak';

const SEARCH = {
  id: 'retrieval.search',
  description: 'Read-only lexical retrieval over mock knowledge.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { query: { type: 'string', minLength: 1 } },
    required: ['query'],
  },
};

const WRITE = {
  id: 'fs.write',
  description: 'Write a file inside the workspace jail.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
};

function sse(payloads: string[]): string {
  return payloads.map((data) => `data: ${data}\n\n`).join('');
}

function openaiToolCallSse(id: string, toolId: string, args: Record<string, unknown>): string {
  return sse([
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                function: { name: toolId, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
    '[DONE]',
  ]);
}

function anthropicToolUseSse(id: string, name: string, args: Record<string, unknown>): string {
  const json = JSON.stringify(args);
  return [
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
  ].join('');
}

function geminiFunctionCallSse(id: string, name: string, args: Record<string, unknown>): string {
  return sse([
    JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name, args, id } }] } }],
    }),
  ]);
}

function capturingTransport(
  handler: (request: HttpRequest, body: Record<string, unknown>) => { status: number; body: string },
): { transport: HttpTransport; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  return {
    bodies,
    transport: {
      async send(request) {
        const parsed = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
        bodies.push(parsed);
        const result = handler(request, parsed);
        return responseFromText(result.status, result.body, { 'content-type': 'text/event-stream' });
      },
    },
  };
}

async function collect(stream: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const firstResult = {
  callId: 'call_1',
  toolId: 'retrieval.search',
  arguments: { query: 'one' },
  status: 'succeeded',
  output: { hits: [{ id: 'doc_alpha' }] },
  resultRef: 'toolres:1',
  round: 0,
};

const secondResult = {
  callId: 'call_2',
  toolId: 'retrieval.search',
  arguments: { query: 'two' },
  status: 'succeeded',
  output: { hits: [{ id: 'doc_beta' }] },
  resultRef: 'toolres:2',
  round: 1,
};

const PROVIDER_SAFE = /^[a-zA-Z0-9_-]+$/;

describe('provider-safe tool aliases', () => {
  it('maps dotted catalogue ids to OpenAI/Anthropic-safe names and back', () => {
    expect(toProviderToolName('retrieval.search')).toBe('retrieval__search');
    expect(toProviderToolName('project.file_op')).toBe('project__file_op');
    expect(toProviderToolName('job.run')).toBe('job__run');
    expect(toProviderToolName('already_safe')).toBe('already_safe');
    expect(PROVIDER_SAFE.test(toProviderToolName('retrieval.search'))).toBe(true);
    expect(fromProviderToolName('retrieval__search', ['retrieval.search', 'fs.write'])).toBe('retrieval.search');
    expect(fromProviderToolName('retrieval.search', ['retrieval.search'])).toBe('retrieval.search');
  });
});

describe('live adapter tool advertisement', () => {
  it('OpenAI-compatible requests include authorised function declarations only', async () => {
    const captured = capturingTransport(() => ({
      status: 200,
      body: sse(['{"choices":[{"delta":{"content":"ok"}}]}', '[DONE]']),
    }));
    const adapter = createOpenAIAdapter({
      secrets: new MapSecretStore({ OPENAI_API_KEY: KEY }),
      timeoutMs: 5_000,
      baseUrl: 'https://api.openai.com/v1',
      transport: captured.transport,
    });
    await collect(
      adapter.stream('gpt-4o', {
        prompt: 'search',
        tools: [SEARCH],
      }),
    );
    expect(captured.bodies[0]?.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'retrieval__search',
          description: SEARCH.description,
          parameters: SEARCH.inputSchema,
        },
      },
    ]);
    expect(PROVIDER_SAFE.test('retrieval__search')).toBe(true);
    expect(JSON.stringify(captured.bodies[0])).not.toContain('retrieval.search');
    expect(JSON.stringify(captured.bodies[0])).not.toContain('fs.write');
    expect(JSON.stringify(captured.bodies[0])).not.toContain('runpod');
  });

  it('Anthropic requests include authorised input_schema declarations only', async () => {
    const captured = capturingTransport(() => ({
      status: 200,
      body: 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
    }));
    const adapter = new AnthropicAdapter({
      secrets: new MapSecretStore({ ANTHROPIC_API_KEY: KEY }),
      timeoutMs: 5_000,
      baseUrl: 'https://api.anthropic.com',
      transport: captured.transport,
    });
    await collect(adapter.stream('claude-sonnet', { prompt: 'search', tools: [SEARCH] }));
    expect(captured.bodies[0]?.tools).toEqual([
      {
        name: 'retrieval__search',
        description: SEARCH.description,
        input_schema: SEARCH.inputSchema,
      },
    ]);
    expect(JSON.stringify(captured.bodies[0])).not.toContain('retrieval.search');
    expect(JSON.stringify(captured.bodies[0])).not.toContain('fs.write');
  });

  it('Gemini requests include authorised functionDeclarations only', async () => {
    const captured = capturingTransport(() => ({
      status: 200,
      body: sse([JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })]),
    }));
    const adapter = new GeminiAdapter({
      secrets: new MapSecretStore({ GEMINI_API_KEY: KEY }),
      timeoutMs: 5_000,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      transport: captured.transport,
    });
    await collect(adapter.stream('flash', { prompt: 'search', tools: [SEARCH] }));
    expect(captured.bodies[0]?.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'retrieval__search',
            description: SEARCH.description,
            parameters: SEARCH.inputSchema,
          },
        ],
      },
    ]);
    expect(JSON.stringify(captured.bodies[0])).not.toContain('retrieval.search');
    expect(JSON.stringify(captured.bodies[0])).not.toContain('admin.configure');
  });
});

describe('provider tool name round-trip', () => {
  it('OpenAI-compatible maps advertised aliases back to catalogue ids', async () => {
    const captured = capturingTransport(() => ({
      status: 200,
      body: openaiToolCallSse('call_1', 'retrieval__search', { query: 'one' }),
    }));
    const adapter = createOpenAIAdapter({
      secrets: new MapSecretStore({ OPENAI_API_KEY: KEY }),
      timeoutMs: 5_000,
      baseUrl: 'https://api.openai.com/v1',
      transport: captured.transport,
    });
    const chunks = await collect(adapter.stream('gpt-4o', { prompt: 'search', tools: [SEARCH] }));
    const call = chunks.find((chunk) => chunk.type === 'tool_call');
    expect(call).toMatchObject({ type: 'tool_call', call: { id: 'call_1', toolId: 'retrieval.search' } });
    expect(JSON.stringify(captured.bodies[0]?.tools)).toContain('retrieval__search');
    expect(JSON.stringify(captured.bodies[0]?.tools)).not.toContain('retrieval.search');
  });

  it('Anthropic maps advertised aliases back to catalogue ids', async () => {
    const captured = capturingTransport(() => ({
      status: 200,
      body: anthropicToolUseSse('call_1', 'retrieval__search', { query: 'one' }),
    }));
    const adapter = new AnthropicAdapter({
      secrets: new MapSecretStore({ ANTHROPIC_API_KEY: KEY }),
      timeoutMs: 5_000,
      baseUrl: 'https://api.anthropic.com',
      transport: captured.transport,
    });
    const chunks = await collect(adapter.stream('claude-sonnet', { prompt: 'search', tools: [SEARCH] }));
    const call = chunks.find((chunk) => chunk.type === 'tool_call');
    expect(call).toMatchObject({ type: 'tool_call', call: { id: 'call_1', toolId: 'retrieval.search' } });
  });

  it('Gemini round-trips both dotted provider names and aliases to catalogue ids', async () => {
    const dotted = capturingTransport(() => ({
      status: 200,
      body: geminiFunctionCallSse('call_dot', 'retrieval.search', { query: 'one' }),
    }));
    const dottedAdapter = new GeminiAdapter({
      secrets: new MapSecretStore({ GEMINI_API_KEY: KEY }),
      timeoutMs: 5_000,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      transport: dotted.transport,
    });
    const dottedChunks = await collect(dottedAdapter.stream('flash', { prompt: 'search', tools: [SEARCH] }));
    expect(dottedChunks.find((chunk) => chunk.type === 'tool_call')).toMatchObject({
      type: 'tool_call',
      call: { id: 'call_dot', toolId: 'retrieval.search' },
    });

    const aliased = capturingTransport(() => ({
      status: 200,
      body: geminiFunctionCallSse('call_alias', 'retrieval__search', { query: 'one' }),
    }));
    const aliasedAdapter = new GeminiAdapter({
      secrets: new MapSecretStore({ GEMINI_API_KEY: KEY }),
      timeoutMs: 5_000,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      transport: aliased.transport,
    });
    const aliasedChunks = await collect(aliasedAdapter.stream('flash', { prompt: 'search', tools: [SEARCH] }));
    expect(aliasedChunks.find((chunk) => chunk.type === 'tool_call')).toMatchObject({
      type: 'tool_call',
      call: { id: 'call_alias', toolId: 'retrieval.search' },
    });
  });
});

describe('native multi-round tool transcripts', () => {
  it('OpenAI-compatible follow-ups send assistant tool_calls and tool results, including two sequential rounds', async () => {
    const captured = capturingTransport((_request, body) => {
      const messages = body.messages as Array<{ role: string }>;
      const toolMessages = messages.filter((row) => row.role === 'tool');
      if (toolMessages.length === 0) {
        return { status: 200, body: openaiToolCallSse('call_1', 'retrieval__search', { query: 'one' }) };
      }
      if (toolMessages.length === 1) {
        return { status: 200, body: openaiToolCallSse('call_2', 'retrieval__search', { query: 'two' }) };
      }
      return {
        status: 200,
        body: sse(['{"choices":[{"delta":{"content":"used both searches"}}]}', '[DONE]']),
      };
    });
    const adapter = createOpenAIAdapter({
      secrets: new MapSecretStore({ OPENAI_API_KEY: KEY }),
      timeoutMs: 5_000,
      baseUrl: 'https://api.openai.com/v1',
      transport: captured.transport,
    });
    const tools = [SEARCH];
    const first = await collect(adapter.stream('gpt-4o', { prompt: 'search twice', tools }));
    expect(first.some((chunk) => chunk.type === 'tool_call' && chunk.call.toolId === 'retrieval.search')).toBe(true);

    const secondCtx: ExecutionContext = {
      prompt: 'search twice',
      tools,
      priorToolResults: [firstResult],
    };
    const second = await collect(adapter.stream('gpt-4o', secondCtx));
    expect(second.some((chunk) => chunk.type === 'tool_call' && chunk.call.toolId === 'retrieval.search')).toBe(true);
    const secondMessages = captured.bodies[1]?.messages as Array<Record<string, unknown>>;
    expect(secondMessages.some((row) => row.role === 'assistant' && Array.isArray(row.tool_calls))).toBe(true);
    expect(
      secondMessages.some(
        (row) => row.role === 'tool' && row.tool_call_id === 'call_1' && String(row.content).includes('doc_alpha'),
      ),
    ).toBe(true);
    expect(JSON.stringify(secondMessages)).toContain('retrieval__search');
    expect(JSON.stringify(secondMessages)).not.toContain('"name":"retrieval.search"');

    const third = await collect(
      adapter.stream('gpt-4o', {
        prompt: 'search twice',
        tools,
        priorToolResults: [firstResult, secondResult],
      }),
    );
    expect(third.some((chunk) => chunk.type === 'text' && chunk.text.includes('used both searches'))).toBe(true);
    const thirdMessages = captured.bodies[2]?.messages as Array<Record<string, unknown>>;
    const assistantTurns = thirdMessages.filter((row) => row.role === 'assistant' && Array.isArray(row.tool_calls));
    const toolTurns = thirdMessages.filter((row) => row.role === 'tool');
    expect(assistantTurns).toHaveLength(2);
    expect(toolTurns.map((row) => row.tool_call_id)).toEqual(['call_1', 'call_2']);
    expect(JSON.stringify(thirdMessages)).toContain('\\"query\\":\\"one\\"');
    expect(JSON.stringify(thirdMessages)).toContain('\\"query\\":\\"two\\"');
  });

  it('Anthropic follow-ups send tool_use then tool_result across two sequential rounds', async () => {
    const captured = capturingTransport((_request, body) => {
      const messages = body.messages as Array<{ role: string }>;
      const assistantTurns = messages.filter((row) => row.role === 'assistant');
      if (assistantTurns.length === 0) {
        return { status: 200, body: anthropicToolUseSse('call_1', 'retrieval__search', { query: 'one' }) };
      }
      if (assistantTurns.length === 1) {
        return { status: 200, body: anthropicToolUseSse('call_2', 'retrieval__search', { query: 'two' }) };
      }
      return {
        status: 200,
        body: 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"used both searches"}}\n\n',
      };
    });
    const adapter = new AnthropicAdapter({
      secrets: new MapSecretStore({ ANTHROPIC_API_KEY: KEY }),
      timeoutMs: 5_000,
      baseUrl: 'https://api.anthropic.com',
      transport: captured.transport,
    });
    const tools = [SEARCH];
    await collect(adapter.stream('claude-sonnet', { prompt: 'search twice', tools }));
    await collect(
      adapter.stream('claude-sonnet', { prompt: 'search twice', tools, priorToolResults: [firstResult] }),
    );
    const second = captured.bodies[1]?.messages as Array<Record<string, unknown>>;
    expect(JSON.stringify(second)).toContain('"type":"tool_use"');
    expect(JSON.stringify(second)).toContain('"type":"tool_result"');
    expect(JSON.stringify(second)).toContain('call_1');
    await collect(
      adapter.stream('claude-sonnet', {
        prompt: 'search twice',
        tools,
        priorToolResults: [firstResult, secondResult],
      }),
    );
    const third = JSON.stringify(captured.bodies[2]?.messages);
    expect(third).toContain('call_1');
    expect(third).toContain('call_2');
    expect(third).toContain('"query":"two"');
    expect(third).toContain('doc_beta');
  });

  it('Gemini follow-ups send functionCall then functionResponse across two sequential rounds', async () => {
    const captured = capturingTransport((_request, body) => {
      const contents = body.contents as Array<{ role: string }>;
      const modelTurns = contents.filter((row) => row.role === 'model');
      if (modelTurns.length === 0) {
        return { status: 200, body: geminiFunctionCallSse('call_1', 'retrieval.search', { query: 'one' }) };
      }
      if (modelTurns.length === 1) {
        return { status: 200, body: geminiFunctionCallSse('call_2', 'retrieval.search', { query: 'two' }) };
      }
      return {
        status: 200,
        body: sse([JSON.stringify({ candidates: [{ content: { parts: [{ text: 'used both searches' }] } }] })]),
      };
    });
    const adapter = new GeminiAdapter({
      secrets: new MapSecretStore({ GEMINI_API_KEY: KEY }),
      timeoutMs: 5_000,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      transport: captured.transport,
    });
    const tools = [SEARCH];
    await collect(adapter.stream('flash', { prompt: 'search twice', tools }));
    await collect(adapter.stream('flash', { prompt: 'search twice', tools, priorToolResults: [firstResult] }));
    const second = JSON.stringify(captured.bodies[1]?.contents);
    expect(second).toContain('functionCall');
    expect(second).toContain('functionResponse');
    expect(second).toContain('call_1');
    await collect(
      adapter.stream('flash', {
        prompt: 'search twice',
        tools,
        priorToolResults: [firstResult, secondResult],
      }),
    );
    const third = JSON.stringify(captured.bodies[2]?.contents);
    expect(third).toContain('call_1');
    expect(third).toContain('call_2');
    expect(third).toContain('"query":"two"');
    expect(third).not.toContain(WRITE.id);
  });
});
