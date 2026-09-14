import { describe, expect, it } from 'vitest';
import { OpenAIToolCallAssembler, AnthropicToolCallAssembler, GeminiFunctionCallAssembler } from '@atlas-vnext/execution';

describe('OpenAI tool-call argument assembly', () => {
  it('mountain-compat: does not parse argument fragments as complete JSON/calls', () => {
    const assembler = new OpenAIToolCallAssembler();
    assembler.ingest([
      { index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{"q":"' } },
    ]);
    assembler.ingest([{ index: 0, function: { arguments: 'atlas' } }]);
    assembler.ingest([{ index: 0, function: { arguments: '"}' } }]);

    const chunks = assembler.finish('openai');
    expect(chunks).toEqual([
      {
        type: 'tool_call',
        call: { id: 'call_1', toolId: 'lookup', arguments: { q: 'atlas' } },
      },
    ]);
  });

  it('assembles parallel tool calls by index even when later deltas omit id/name', () => {
    const assembler = new OpenAIToolCallAssembler();
    assembler.ingest([
      { index: 0, id: 'call_a', function: { name: 'alpha', arguments: '{"n":' } },
      { index: 1, id: 'call_b', function: { name: 'beta', arguments: '{"n":' } },
    ]);
    assembler.ingest([
      { index: 0, function: { arguments: '1}' } },
      { index: 1, function: { arguments: '2}' } },
    ]);

    expect(assembler.finish('openai')).toEqual([
      { type: 'tool_call', call: { id: 'call_a', toolId: 'alpha', arguments: { n: 1 } } },
      { type: 'tool_call', call: { id: 'call_b', toolId: 'beta', arguments: { n: 2 } } },
    ]);
  });

  it('emits a structured warning instead of a raw-fragment call when JSON never completes', () => {
    const assembler = new OpenAIToolCallAssembler();
    assembler.ingest([
      { index: 0, id: 'call_bad', function: { name: 'lookup', arguments: '{"q":' } },
    ]);
    const chunks = assembler.finish('openai');
    expect(chunks.some((chunk) => chunk.type === 'tool_call')).toBe(false);
    expect(chunks).toEqual([
      {
        type: 'warning',
        message: 'Dropped incomplete tool call (lookup); streamed arguments were not structurally complete.',
        provider: 'openai',
      },
    ]);
  });

  it('does not treat a prefix that is valid JSON in isolation as the finished arguments', () => {
    const assembler = new OpenAIToolCallAssembler();
    assembler.ingest([
      { index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{}' } },
    ]);
    assembler.ingest([{ index: 0, function: { arguments: 'oops' } }]);
    const chunks = assembler.finish('openai');
    expect(chunks.some((chunk) => chunk.type === 'tool_call')).toBe(false);
    expect(chunks[0]).toMatchObject({ type: 'warning', provider: 'openai' });
  });

  it('treats empty assembled arguments as an empty object', () => {
    const assembler = new OpenAIToolCallAssembler();
    assembler.ingest([{ index: 0, id: 'call_empty', function: { name: 'noop', arguments: '' } }]);
    expect(assembler.finish('openai')).toEqual([
      { type: 'tool_call', call: { id: 'call_empty', toolId: 'noop', arguments: {} } },
    ]);
  });
});

describe('Anthropic input_json_delta assembly', () => {
  it('does not parse a partial_json fragment as a complete tool call', () => {
    const assembler = new AnthropicToolCallAssembler();
    assembler.start(0, { type: 'tool_use', id: 'toolu_1', name: 'lookup' });
    assembler.ingestDelta(0, { type: 'input_json_delta', partial_json: '{"q":"' });
    const incomplete = assembler.finishBlock(0, 'anthropic');
    expect(incomplete.some((chunk) => chunk.type === 'tool_call')).toBe(false);

    const complete = new AnthropicToolCallAssembler();
    complete.start(0, { type: 'tool_use', id: 'toolu_1', name: 'lookup' });
    complete.ingestDelta(0, { type: 'input_json_delta', partial_json: '{"q":"' });
    complete.ingestDelta(0, { type: 'input_json_delta', partial_json: 'atlas"}' });
    expect(complete.finishBlock(0, 'anthropic')).toEqual([
      { type: 'tool_call', call: { id: 'toolu_1', toolId: 'lookup', arguments: { q: 'atlas' } } },
    ]);
  });
});

describe('Gemini functionCall assembly', () => {
  it('merges name-only then argument fragments of one call', () => {
    const assembler = new GeminiFunctionCallAssembler();
    assembler.ingest({ functionCall: { name: 'lookup' } });
    assembler.ingest({ functionCall: { args: '{"q":"' } });
    assembler.ingest({ functionCall: { args: 'atlas"}' } });
    expect(assembler.finish('gemini')).toEqual([
      { type: 'tool_call', call: { id: 'gcall:0', toolId: 'lookup', arguments: { q: 'atlas' } } },
    ]);
  });

  it('keeps two different function names as separate calls', () => {
    const assembler = new GeminiFunctionCallAssembler();
    assembler.ingest({ functionCall: { name: 'lookup', args: { q: 'a' } } }, 0);
    assembler.ingest({ functionCall: { name: 'search', args: { q: 'b' } } }, 1);
    expect(assembler.finish('gemini')).toEqual([
      { type: 'tool_call', call: { id: 'gcall:0', toolId: 'lookup', arguments: { q: 'a' } } },
      { type: 'tool_call', call: { id: 'gcall:1', toolId: 'search', arguments: { q: 'b' } } },
    ]);
  });

  it('matches nameless argument fragments by part index across parallel calls', () => {
    const assembler = new GeminiFunctionCallAssembler();
    assembler.ingest({ functionCall: { name: 'alpha' } }, 0);
    assembler.ingest({ functionCall: { name: 'beta' } }, 1);
    assembler.ingest({ functionCall: { args: '{"n":' } }, 0);
    assembler.ingest({ functionCall: { args: '{"n":' } }, 1);
    assembler.ingest({ functionCall: { args: '1}' } }, 0);
    assembler.ingest({ functionCall: { args: '2}' } }, 1);
    expect(assembler.finish('gemini')).toEqual([
      { type: 'tool_call', call: { id: 'gcall:0', toolId: 'alpha', arguments: { n: 1 } } },
      { type: 'tool_call', call: { id: 'gcall:1', toolId: 'beta', arguments: { n: 2 } } },
    ]);
  });

  it('keeps two separate calls to the same function name distinct', () => {
    const assembler = new GeminiFunctionCallAssembler();
    assembler.ingest({ functionCall: { name: 'lookup', args: { q: 'first', secret: 'only-call-1' } } }, 0);
    assembler.ingest({ functionCall: { name: 'lookup', args: { q: 'second' } } }, 1);
    const chunks = assembler.finish('gemini');
    expect(chunks.filter((chunk) => chunk.type === 'tool_call')).toEqual([
      { type: 'tool_call', call: { id: 'gcall:0', toolId: 'lookup', arguments: { q: 'first', secret: 'only-call-1' } } },
      { type: 'tool_call', call: { id: 'gcall:1', toolId: 'lookup', arguments: { q: 'second' } } },
    ]);
    const second = chunks[1];
    if (second?.type !== 'tool_call') throw new Error('expected second tool_call');
    expect(second.call.arguments).toEqual({ q: 'second' });
    expect(second.call.arguments).not.toHaveProperty('secret');
    expect(second.call.id).not.toBe(chunks[0]?.type === 'tool_call' ? chunks[0].call.id : '');

    const sequential = new GeminiFunctionCallAssembler();
    sequential.ingest({ functionCall: { name: 'lookup', args: { q: 'one' } } });
    sequential.ingest({ functionCall: { name: 'lookup', args: { q: 'two' } } });
    const sequentialChunks = sequential.finish('gemini');
    expect(sequentialChunks).toEqual([
      { type: 'tool_call', call: { id: 'gcall:0', toolId: 'lookup', arguments: { q: 'one' } } },
      { type: 'tool_call', call: { id: 'gcall:1', toolId: 'lookup', arguments: { q: 'two' } } },
    ]);
  });

  it('keys same-name calls by provider id rather than function name', () => {
    const assembler = new GeminiFunctionCallAssembler();
    assembler.ingest({ functionCall: { id: 'call_a', name: 'lookup', args: { q: 'a' } } });
    assembler.ingest({ functionCall: { id: 'call_b', name: 'lookup', args: { q: 'b' } } });
    expect(assembler.finish('gemini')).toEqual([
      { type: 'tool_call', call: { id: 'call_a', toolId: 'lookup', arguments: { q: 'a' } } },
      { type: 'tool_call', call: { id: 'call_b', toolId: 'lookup', arguments: { q: 'b' } } },
    ]);
  });

  it('does not emit an executable tool_call for incomplete or malformed args', () => {
    const incomplete = new GeminiFunctionCallAssembler();
    incomplete.ingest({ functionCall: { name: 'lookup', args: '{"q":' } });
    const incompleteChunks = incomplete.finish('gemini');
    expect(incompleteChunks.some((chunk) => chunk.type === 'tool_call')).toBe(false);
    expect(incompleteChunks[0]).toMatchObject({ type: 'warning', provider: 'gemini' });

    const malformed = new GeminiFunctionCallAssembler();
    malformed.ingest({ functionCall: { name: 'lookup', args: '["not","an","object"]' } });
    const malformedChunks = malformed.finish('gemini');
    expect(malformedChunks.some((chunk) => chunk.type === 'tool_call')).toBe(false);
    expect(malformedChunks[0]).toMatchObject({
      type: 'warning',
      provider: 'gemini',
      message: expect.stringMatching(/incomplete tool call \(lookup\)/),
    });
  });

  it('does not emit a side-effecting call before arguments are structurally complete', () => {
    const assembler = new GeminiFunctionCallAssembler();
    assembler.ingest({ functionCall: { name: 'write_file', args: '{"path":"/tmp/x","body":"' } });
    expect(assembler.finish('gemini').some((chunk) => chunk.type === 'tool_call')).toBe(false);
  });
});
