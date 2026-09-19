import { describe, expect, it } from 'vitest';
import { productionToolAdapters } from '../src/web-tools.ts';
import {
  PrivateDestinationError,
  ResponseLimitError,
  fetchPublicHttp,
  isPrivateIp,
  parsePublicHttpUrl,
} from '../src/public-http.ts';
import { NodePublicLookup } from '../src/collectors.ts';
import type { ToolAdapterContext } from '@atlas-vnext/tools';

function fetchThat(handler: (url: string) => Response): typeof fetch {
  return (async (input: string | URL | { url: string }) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url);
  }) as typeof fetch;
}

const publicLookup = async () => [{ address: '93.184.216.34' }];

describe('public HTTP destinations', () => {
  it('rejects loopback, private, and link-local hosts before fetch', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('10.0.0.8')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
    expect(isPrivateIp('169.254.169.254')).toBe(true);
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(() => parsePublicHttpUrl('http://localhost/admin')).toThrow(PrivateDestinationError);
    expect(() => parsePublicHttpUrl('http://127.0.0.1/')).toThrow(PrivateDestinationError);
  });

  it('does not follow redirects onto private destinations', async () => {
    const seen: string[] = [];
    const fetchImpl = fetchThat((url) => {
      seen.push(url);
      if (url.startsWith('https://example.com')) {
        return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/internal' } });
      }
      return new Response('internal', { status: 200 });
    });
    await expect(
      fetchPublicHttp({
        fetch: fetchImpl,
        url: 'https://example.com/page',
        lookup: publicLookup,
      }),
    ).rejects.toBeInstanceOf(PrivateDestinationError);
    expect(seen).toEqual(['https://example.com/page']);
  });

  it('caps response bytes before buffering the whole body', async () => {
    const fetchImpl = fetchThat(() => new Response('n'.repeat(20_000), { status: 200 }));
    await expect(
      fetchPublicHttp({
        fetch: fetchImpl,
        url: 'https://example.com/big',
        lookup: publicLookup,
        maxBytes: 64,
      }),
    ).rejects.toBeInstanceOf(ResponseLimitError);
  });

  it('refuses live tool reads of private destinations', async () => {
    const seen: string[] = [];
    const adapters = productionToolAdapters({
      search: {
        async search() {
          return {
            queries: [],
            mode: 'search',
            engines: [],
            hits: [],
            coverage: { score: 0, engineCount: 0, hitCount: 0, primaryLike: 0, gaps: ['no_hits'] },
            retrievedAt: new Date().toISOString(),
          };
        },
        async inspect() {
          return null;
        },
      },
      fetch: fetchThat((url) => {
        seen.push(url);
        return new Response('secret', { status: 200 });
      }),
    });
    const api = adapters.find((adapter) => adapter.id === 'api.read');
    const browser = adapters.find((adapter) => adapter.id === 'browser.navigate');
    const ctx = { signal: new AbortController().signal } as ToolAdapterContext;
    await expect(api!.execute({ url: 'http://127.0.0.1/' }, ctx)).rejects.toBeInstanceOf(PrivateDestinationError);
    await expect(browser!.execute({ url: 'http://10.0.0.1/' }, ctx)).rejects.toBeInstanceOf(PrivateDestinationError);
    expect(seen).toEqual([]);
  });

  it('does not fetch private addresses during OSINT document probes', async () => {
    const seen: string[] = [];
    const collector = new NodePublicLookup(
      fetchThat((url) => {
        seen.push(url);
        return new Response('<title>internal</title>', { status: 200 });
      }),
      1_000,
      'live',
    );
    const hits = await collector.lookup({ kind: 'ip', value: '127.0.0.1' });
    expect(hits.some((hit) => hit.source === 'http.document' && /did not fetch/.test(hit.summary))).toBe(true);
    expect(seen).toEqual([]);
  });
});
