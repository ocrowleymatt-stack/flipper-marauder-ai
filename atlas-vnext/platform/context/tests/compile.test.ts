import { describe, expect, it } from 'vitest';
import { ContextCompiler } from '../src/index.ts';

const compiler = new ContextCompiler();

describe('ContextCompiler', () => {
  it('omits failed and irrelevant attempts unless attemptId is requested', () => {
    const request = {
      objective: 'Summarise the quay brief',
      tokenBudget: 400,
      history: [
        { id: 'h1', attemptId: 'att_ok', status: 'succeeded', content: 'Drafted a quay summary.' },
        { id: 'h-fail', attemptId: 'att_fail', status: 'failed', content: 'Model overflowed the window.' },
        { id: 'h-irrel', attemptId: 'att_old', irrelevant: true, content: 'Unrelated lighthouse note.' },
      ],
    };
    const compiled = compiler.compile(request);
    expect(compiled.items.some((item) => item.id === 'history:h-fail')).toBe(false);
    expect(compiled.items.some((item) => item.id === 'history:h-irrel')).toBe(false);
    expect(compiled.items.some((item) => item.id === 'history:h1')).toBe(true);
    expect(compiled.omitted).toEqual(
      expect.arrayContaining([
        { id: 'history:h-fail', reason: 'failed_attempt' },
        { id: 'history:h-irrel', reason: 'irrelevant' },
      ]),
    );

    const withAttempt = compiler.compile({ ...request, attemptId: 'att_fail' });
    expect(withAttempt.items.some((item) => item.id === 'history:h-fail')).toBe(true);
    expect(withAttempt.items.find((item) => item.id === 'history:h-fail')?.inclusionReason).toBe(
      'requested_attempt',
    );
    expect(withAttempt.omitted.some((entry) => entry.id === 'history:h-irrel')).toBe(true);
  });

  it('respects the token budget and marks truncation', () => {
    const compiled = compiler.compile({
      objective: 'Keep the working set small',
      tokenBudget: 8,
      evidence: [
        { id: 'a', content: 'Short.' },
        {
          id: 'b',
          content:
            'This evidence paragraph is intentionally long so the compiler must omit or truncate it under the budget.',
        },
      ],
      history: [{ id: 'h', content: 'Another bulky history turn that should not dump the estate.' }],
    });
    expect(compiled.tokenCount).toBeLessThanOrEqual(compiled.tokenBudget);
    expect(compiled.tokenBudget).toBe(8);
    expect(compiled.truncated).toBe(true);
    expect(compiled.omitted.some((entry) => entry.reason === 'token_budget')).toBe(true);
    expect(compiled.items.every((item) => item.tokenCost <= compiled.tokenBudget)).toBe(true);
  });

  it('includes an inclusionReason on every kept item and skips empty optional fields', () => {
    const compiled = compiler.compile({
      objective: 'Compile a justified working set',
      tokenBudget: 200,
      policy: 'Do not invent sources.',
      structuredState: { stage: 'draft', chapter: 1 },
      evidence: [{ id: 'e1', content: 'Kettle seen at dawn.', sourceRef: 'cas:abc' }],
      outputContract: { format: 'bullets' },
      history: [],
    });
    expect(compiled.items.length).toBeGreaterThan(0);
    expect(compiled.items.every((item) => item.inclusionReason.length > 0)).toBe(true);
    expect(compiled.items.map((item) => item.kind)).toEqual([
      'objective',
      'policy',
      'structured_state',
      'evidence',
      'output_contract',
    ]);
    expect(compiled.policyExcerpt).toContain('Do not invent sources.');
    expect(compiled.items.find((item) => item.kind === 'objective')?.inclusionReason).toBe('task_objective');
  });

  it('is deterministic for the same request', () => {
    const request = {
      objective: 'Stable ids',
      tokenBudget: 80,
      evidence: [
        { id: 'two', content: 'Second.' },
        { id: 'one', content: 'First.' },
      ],
      history: [{ id: 'h', status: 'ok', content: 'Kept.' }],
    };
    const a = compiler.compile(request);
    const b = compiler.compile(request);
    expect(a.items.map((item) => item.id)).toEqual(b.items.map((item) => item.id));
    expect(a.items.map((item) => item.content)).toEqual(b.items.map((item) => item.content));
    expect(a.omitted).toEqual(b.omitted);
  });

  it('returns an empty working set when the budget is 0', () => {
    const compiled = compiler.compile({
      objective: 'Anything',
      tokenBudget: 0,
      policy: 'Secret policy that must not be dumped.',
    });
    expect(compiled.items).toEqual([]);
    expect(compiled.tokenCount).toBe(0);
    expect(compiled.objective).toBe('');
    expect(compiled.policyExcerpt).toBe('');
    expect(compiled.truncated).toBe(true);
    expect(compiled.omitted.some((entry) => entry.id === 'objective')).toBe(true);
    expect(compiled.omitted.some((entry) => entry.id === 'policy')).toBe(true);
  });
});
