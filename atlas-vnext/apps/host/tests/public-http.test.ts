import { describe, expect, it } from 'vitest';
import { productionToolAdapters } from '../src/web-tools.ts';
import {
  PrivateDestinationError,
  ResponseLimitError,
  fetchPublicHttp,
  isPrivateIp,
  parsePublicHttpUrl,
  pinnedLookup,
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
    expect(isPrivateIp('64:ff9b::7f00:1')).toBe(true);
    expect(isPrivateIp('64:ff9b::10.0.0.1')).toBe(true);
    expect(isPrivateIp('2002:7f00:1::1')).toBe(true);
    expect(isPrivateIp('2002:c0a8:1::')).toBe(true);
    expect(isPrivateIp('64:ff9b::808:808')).toBe(false);
    expect(isPrivateIp('2002:0808:0808::')).toBe(false);
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

  it('pins DNS lookup to the already-validated addresses', () => {
    const lookup = pinnedLookup([{ address: '93.184.216.34', family: 4 }]);
    let address = '';
    let family = 0;
    lookup('example.com', { verbatim: true }, (err, result, fam) => {
      expect(err).toBeNull();
      address = typeof result === 'string' ? result : result[0]?.address ?? '';
      family = fam ?? (typeof result === 'string' ? 0 : result[0]?.family ?? 0);
    });
    expect(address).toBe('93.184.216.34');
    expect(family).toBe(4);
  });

  it('pins the connection to already-validated public addresses', async () => {
    const seen: Array<{ url: string; addresses: string[] }> = [];
    const page = await fetchPublicHttp({
      url: 'https://example.com/page',
      lookup: publicLookup,
      transport: async ({ url, addresses }) => {
        seen.push({ url, addresses: addresses.map((row) => row.address) });
        return new Response('ok', { status: 200 });
      },
    });
    expect(page.status).toBe(200);
    expect(seen).toEqual([{ url: 'https://example.com/page', addresses: ['93.184.216.34'] }]);
  });

  it('refuses NAT64 encodings of private IPv4 before connect', async () => {
    await expect(
      fetchPublicHttp({
        fetch: fetchThat(() => new Response('secret', { status: 200 })),
        url: 'https://example.com/rebind',
        lookup: async () => [{ address: '64:ff9b::7f00:1' }],
      }),
    ).rejects.toBeInstanceOf(PrivateDestinationError);
  });
});
