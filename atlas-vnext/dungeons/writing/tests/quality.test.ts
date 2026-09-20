import { describe, expect, it } from 'vitest';
import { assessWritingQuality } from '../src/quality.ts';
import { assembleStoryBible, mergeStoryBible, replaceStoryBible } from '../src/bible.ts';

describe('writing quality heuristics', () => {
  it('hard-blocks empty and placeholder output', () => {
    expect(assessWritingQuality('').blocking).toBe(true);
    expect(assessWritingQuality('TODO INSERT SOURCE for the harbour scene.').blocking).toBe(true);
    expect(assessWritingQuality('...').blocking).toBe(true);
  });

  it('treats AI-fog as advisory, not a silent veto', () => {
    const assessment = assessWritingQuality(
      'In today\'s fast-paced world the keeper walked the stair. The lamp was lit. Gulls cried over the quay.',
    );
    expect(assessment.blocking).toBe(false);
    expect(assessment.state).toBe('advisory');
    expect(assessment.findings.some((item) => item.id === 'ai-fog')).toBe(true);
  });
});

describe('story bible assembly', () => {
  it('caps context and prefers named characters mentioned in the ask', () => {
    const assembled = assembleStoryBible({
      bible: {
        premise: 'A harbour novel.',
        characters: [
          { name: 'Gideon Hale the Quiet', facts: 'Speaks rarely.' },
          { name: 'Mara', facts: 'Has a scar over her left eye and refuses to enter churches.' },
        ],
        facts: ['The lamp must never go out.'],
      },
      instruction: 'Write chapter two about Mara on the stair.',
      budget: 4000,
    });
    expect(assembled.text).toContain('scar over her left eye');
    expect(assembled.text.indexOf('Mara')).toBeLessThan(assembled.text.indexOf('Gideon Hale the Quiet'));
    const tiny = assembleStoryBible({
      bible: { premise: 'x'.repeat(5000), facts: ['y'.repeat(5000)] },
      budget: 200,
    });
    expect(tiny.truncated).toBe(true);
    expect(tiny.usedChars).toBeLessThanOrEqual(200);
  });

  it('replaces editor lists instead of unioning them', () => {
    const base = mergeStoryBible({}, { facts: ['old line', 'keep me'] });
    const replaced = replaceStoryBible(base, { facts: ['keep me'] });
    expect(replaced.facts).toEqual(['keep me']);
    const appended = mergeStoryBible(base, { facts: ['new line'] });
    expect(appended.facts).toEqual(['old line', 'keep me', 'new line']);
  });
});
