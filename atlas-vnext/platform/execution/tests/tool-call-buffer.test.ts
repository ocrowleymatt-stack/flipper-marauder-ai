import { describe, expect, it } from 'vitest';
import { OpenAIToolCallAssembler } from '@atlas-vnext/execution';

describe('OpenAI tool-call argument assembly', () => {
  it('does not parse argument fragments as complete JSON/calls', () => {
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
