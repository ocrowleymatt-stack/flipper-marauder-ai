import { describe, expect, it } from 'vitest';
import {
  canonicalUrl,
  coverageOf,
  detectContradictions,
  fuseEngineHits,
  planQueries,
  strongestHit,
} from '../src/index.ts';

describe('federated search primitives', () => {
  it('canonicalises URLs by stripping trackers and default ports', () => {
    expect(canonicalUrl('https://Example.com:443/a/?utm_source=x&b=1&fbclid=zz#frag')).toBe(
      'https://example.com/a?b=1',
    );
  });

  it('fuses duplicate URLs with RRF and records engine overlap', () => {
    const fused = fuseEngineHits([
      { engine: 'wikipedia', rank: 1, title: 'Orpheus', url: 'https://en.wikipedia.org/wiki/Orpheus?utm_source=x', snippet: 'myth' },
      { engine: 'duckduckgo', rank: 3, title: 'Orpheus', url: 'https://en.wikipedia.org/wiki/Orpheus', snippet: 'Thracian bard' },
      { engine: 'duckduckgo', rank: 1, title: 'Other', url: 'https://example.test/orpheus', snippet: 'page' },
    ]);
    expect(fused[0]?.canonicalUrl).toBe('https://en.wikipedia.org/wiki/Orpheus');
    expect(fused[0]?.engineCount).toBe(2);
    expect(fused[0]?.sourceType).toBe('encyclopedia');
    expect(fused.map((hit) => hit.canonicalUrl)).toHaveLength(2);
  });

  it('plans a follow-up wave and withholds extra queries when coverage is already strong', () => {
    const planned = planQueries('Atlas Mountain TypeScript');
    expect(planned[0]).toBe('Atlas Mountain TypeScript');
    expect(planned.some((item) => /critic/i.test(item))).toBe(true);
    const strong = coverageOf(
      [
        {
          rank: 1,
          title: 'A',
          url: 'https://www.gov.uk/a',
          canonicalUrl: 'https://www.gov.uk/a',
          snippet: 'official',
          engine: 'brave',
          sourceType: 'official',
          engineCount: 3,
          engines: ['brave', 'kagi', 'wikipedia'],
          retrievedAt: '2026-09-19T00:00:00.000Z',
        },
        {
          rank: 2,
          title: 'B',
          url: 'https://arxiv.org/abs/1',
          canonicalUrl: 'https://arxiv.org/abs/1',
          snippet: 'paper',
          engine: 'exa',
          sourceType: 'academic',
          engineCount: 2,
          engines: ['exa', 'searxng'],
          retrievedAt: '2026-09-19T00:00:00.000Z',
        },
      ],
      'research',
    );
    expect(strong.score).toBeGreaterThanOrEqual(82);
    expect(strong.gaps.includes('coverage_below_stop')).toBe(false);
    expect(coverageOf([], 'research').gaps).toContain('no_hits');
  });

  it('detects opposing polarity on shared entities and picks a strongest hit', () => {
    const contradictions = detectContradictions([
      { id: 'a', text: 'The copper kettle is confirmed official.' },
      { id: 'b', text: 'The copper kettle is not official.' },
      { id: 'c', text: 'Unrelated weather in Manchester.' },
    ]);
    expect(contradictions).toEqual([expect.objectContaining({ a: 'a', b: 'b' })]);
    const strongest = strongestHit([
      {
        rank: 4,
        title: 'forum',
        url: 'https://reddit.com/r/x',
        canonicalUrl: 'https://reddit.com/r/x',
        snippet: 'chat',
        engine: 'duckduckgo',
        sourceType: 'discussion',
        engineCount: 1,
        engines: ['duckduckgo'],
        retrievedAt: '2026-09-19T00:00:00.000Z',
      },
      {
        rank: 2,
        title: 'gov',
        url: 'https://www.gov.uk/x',
        canonicalUrl: 'https://www.gov.uk/x',
        snippet: 'notice',
        engine: 'brave+wikipedia',
        sourceType: 'official',
        engineCount: 2,
        engines: ['brave', 'wikipedia'],
        retrievedAt: '2026-09-19T00:00:00.000Z',
      },
    ]);
    expect(strongest?.canonicalUrl).toBe('https://www.gov.uk/x');
  });
});
