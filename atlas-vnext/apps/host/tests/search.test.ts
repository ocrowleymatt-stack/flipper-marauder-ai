import { describe, expect, it } from 'vitest';
import { NodeFederatedSearch, parseDuckDuckGo } from '../src/search.ts';

describe('host federated search', () => {
  it('parses DuckDuckGo HTML results and fuses engines in mock mode', async () => {
    const html = `
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FOrpheus">Orpheus</a>
      <a class="result__a" href="https://example.test/orpheus">Independent</a>
    `;
    const parsed = parseDuckDuckGo(html);
    expect(parsed[0]?.url).toBe('https://en.wikipedia.org/wiki/Orpheus');
    const search = new NodeFederatedSearch({ mode: 'mock' });
    const report = await search.search({ queries: ['Orpheus myth'], mode: 'research' });
    expect(report.engines.length).toBeGreaterThan(0);
    expect(report.hits.length).toBeGreaterThan(1);
    expect(report.hits.some((hit) => hit.canonicalUrl.includes('wikipedia.org'))).toBe(true);
    const inspected = await search.inspect({ url: report.hits[0]!.canonicalUrl });
    expect(inspected?.excerpt).toMatch(/Inspected fixture/);
  });

  it('does not inspect private destinations', async () => {
    const search = new NodeFederatedSearch({
      mode: 'live',
      fetch: (async () => new Response('secret', { status: 200 })) as unknown as typeof fetch,
    });
    expect(await search.inspect({ url: 'http://127.0.0.1/' })).toBeNull();
  });
});
