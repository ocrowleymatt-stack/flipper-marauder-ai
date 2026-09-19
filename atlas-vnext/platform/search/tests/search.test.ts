import { describe, expect, it } from 'vitest';
import {
  assertPublicHttpUrl,
  canonicalUrl,
  coverageScore,
  detectContradictions,
  fuseHits,
  isPrivateAddress,
  looksLikeResearchRequest,
  planQueries,
  strongestFinding,
} from '../src/index.ts';
import type { ResearchFinding, SearchHit } from '@atlas-vnext/contracts';

function hit(engine: string, url: string, rank: number, snippet = 'snippet'): SearchHit {
  return {
    engine,
    title: url,
    url,
    canonicalUrl: url,
    snippet,
    rank,
    retrievedAt: '2026-09-19T00:00:00.000Z',
    source: null,
  };
}

describe('search primitives', () => {
  it('canonicalises URLs, strips tracking, and fuses ranked lists', () => {
    expect(canonicalUrl('HTTPS://WWW.Example.com/path/?utm_source=x&b=1&a=2#frag')).toBe(
      'https://example.com/path?a=2&b=1',
    );
    const fused = fuseHits([
      [hit('brave', 'https://www.example.com/a', 1), hit('brave', 'https://other.test/b', 2)],
      [hit('searxng', 'https://example.com/a?utm_campaign=1', 3), hit('searxng', 'https://third.test/c', 1)],
    ]);
    expect(fused[0]?.canonicalUrl).toBe('https://example.com/a');
    expect(fused.map((row) => row.canonicalUrl)).toContain('https://third.test/c');
  });

  it('plans diversified queries and measures coverage', () => {
    const queries = planQueries('history of the World Wide Web');
    expect(queries[0]).toMatch(/World Wide Web/);
    expect(queries.some((item) => /controversy|disputed/i.test(item))).toBe(true);
    const poor = coverageScore('world wide web', ['en.wikipedia.org'], ['the page']);
    expect(poor.adequate).toBe(false);
    const good = coverageScore(
      'world wide web',
      ['en.wikipedia.org', 'w3.org'],
      ['The World Wide Web was invented at CERN.', 'W3C maintains web standards.'],
    );
    expect(good.adequate).toBe(true);
  });

  it('detects contradictions and strongest evidence without an LLM', () => {
    const findings: ResearchFinding[] = [
      {
        id: 'a',
        title: 'A',
        url: 'https://a.test/1',
        canonicalUrl: 'https://a.test/1',
        summary: 'The protocol is established and confirmed.',
        engine: 'brave',
        host: 'a.test',
        confidence: 'possible',
        wave: 1,
      },
      {
        id: 'b',
        title: 'B',
        url: 'https://b.test/1',
        canonicalUrl: 'https://b.test/1',
        summary: 'The origin remains disputed and uncertain.',
        engine: 'searxng',
        host: 'b.test',
        confidence: 'confirmed',
        wave: 1,
      },
    ];
    expect(detectContradictions(findings).length).toBeGreaterThan(0);
    expect(strongestFinding(findings)?.id).toBe('b');
  });

  it('classifies research intent without false-positives on memory probes', () => {
    expect(looksLikeResearchRequest('My dog’s name is ORPHEUS-731.')).toBe(false);
    expect(looksLikeResearchRequest('What did I say my dog’s name was?')).toBe(false);
    expect(
      looksLikeResearchRequest(
        'Research the history of the World Wide Web using multiple independent sources. Tell me what is strongly established.',
      ),
    ).toBe(true);
  });

  it('rejects private SSRF targets', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('10.0.0.4')).toBe(true);
    expect(isPrivateAddress('192.168.1.1')).toBe(true);
    expect(isPrivateAddress('169.254.169.254')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateAddress('::ffff:7f00:1')).toBe(true);
    expect(isPrivateAddress('::ffff:a9fe:a9fe')).toBe(true);
    expect(isPrivateAddress('0:0:0:0:0:ffff:7f00:1')).toBe(true);
    expect(isPrivateAddress('::ffff:808:808')).toBe(false);
    expect(isPrivateAddress('64:ff9b::7f00:1')).toBe(true);
    expect(isPrivateAddress('2002:c0a8:1::')).toBe(true);
    expect(isPrivateAddress('64:ff9b::808:808')).toBe(false);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('::')).toBe(true);
    expect(isPrivateAddress('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isPrivateAddress('::0001')).toBe(true);
    expect(isPrivateAddress('::1%lo')).toBe(true);
    expect(isPrivateAddress('0000:0000:0000:0000:0000:0000:0000:0001')).toBe(true);
    expect(isPrivateAddress('2001:4860:4860::8888')).toBe(false);
    expect(() => assertPublicHttpUrl('http://localhost/secret')).toThrow(/Local-network/);
    expect(() => assertPublicHttpUrl('https://user:pass@example.com/')).toThrow(/credentials/);
    expect(() => assertPublicHttpUrl('file:///etc/passwd')).toThrow(/http/);
  });
});
