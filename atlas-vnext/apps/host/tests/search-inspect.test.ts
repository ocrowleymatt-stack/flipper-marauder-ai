import { describe, expect, it } from 'vitest';
import { FixtureInspect, NodeFederatedSearch, NodeSourceInspect, searchEnginesFromEnv } from '../src/index.ts';

describe('host federated search', () => {
  it('uses two fixture engines in mock and isolates engine failure', async () => {
    const engines = searchEnginesFromEnv({}, 'mock');
    expect(engines.map((engine) => engine.id).sort()).toEqual(['brave', 'searxng']);
    const search = new NodeFederatedSearch([
      ...engines,
      {
        id: 'boom',
        async search() {
          throw new Error('engine down');
        },
      },
    ]);
    const report = await search.search({ query: 'history of the World Wide Web', count: 6 });
    expect(report.engines).toContain('brave');
    expect(report.engines).toContain('searxng');
    expect(report.hits.length).toBeGreaterThan(1);
    expect(new Set(report.hits.map((hit) => hit.canonicalUrl)).size).toBe(report.hits.length);
    expect(report.errors.some((row) => row.engine === 'boom')).toBe(true);
  });

  it('uses Wikipedia only in live when other engines are unconfigured', () => {
    const engines = searchEnginesFromEnv({}, 'live');
    expect(engines.map((engine) => engine.id)).toEqual(['wikipedia']);
    expect(engines.some((engine) => engine.id === 'fixture')).toBe(false);
  });
});

describe('source inspect SSRF', () => {
  it('rejects localhost, private literals, credentials, and private DNS', async () => {
    const inspect = new NodeSourceInspect({
      lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    await expect(inspect.inspect({ url: 'http://localhost/secret' })).rejects.toThrow(/Local-network|private/i);
    await expect(inspect.inspect({ url: 'http://127.0.0.1/' })).rejects.toThrow(/private/i);
    await expect(inspect.inspect({ url: 'http://10.0.0.4/' })).rejects.toThrow(/private/i);
    await expect(inspect.inspect({ url: 'http://192.168.1.1/' })).rejects.toThrow(/private/i);
    await expect(inspect.inspect({ url: 'http://169.254.169.254/' })).rejects.toThrow(/private/i);
    await expect(inspect.inspect({ url: 'https://user:pass@example.com/' })).rejects.toThrow(/credentials/i);
    await expect(inspect.inspect({ url: 'http://metadata.google.internal/' })).rejects.toThrow();
    await expect(inspect.inspect({ url: 'http://evil.example/' })).rejects.toThrow(/private/i);
  });

  it('pins inspect to already-validated public addresses', async () => {
    const seen: Array<{ url: string; addresses: string[] }> = [];
    const inspect = new NodeSourceInspect({
      lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }],
      transport: async ({ url, addresses }) => {
        seen.push({ url, addresses: addresses.map((row) => row.address) });
        return new Response('<title>ok</title>', { status: 200, headers: { 'content-type': 'text/html' } });
      },
    });
    const page = await inspect.inspect({ url: 'https://public.test/page' });
    expect(page.ok).toBe(true);
    expect(seen).toEqual([{ url: 'https://public.test/page', addresses: ['8.8.8.8'] }]);
  });

  it('rejects NAT64 encodings of private IPv4 before connect', async () => {
    const inspect = new NodeSourceInspect({
      lookupImpl: async () => [{ address: '64:ff9b::7f00:1', family: 6 }],
      fetchImpl: async () => new Response('secret', { status: 200, headers: { 'content-type': 'text/plain' } }),
    });
    await expect(inspect.inspect({ url: 'https://public.test/rebind' })).rejects.toThrow(/private/i);
  });

  it('rejects IPv4-mapped IPv6 hex encodings of private IPv4 before connect', async () => {
    for (const address of ['::ffff:7f00:1', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:7f00:1'] as const) {
      const inspect = new NodeSourceInspect({
        lookupImpl: async () => [{ address, family: 6 }],
        fetchImpl: async () => new Response('secret', { status: 200, headers: { 'content-type': 'text/plain' } }),
      });
      await expect(inspect.inspect({ url: 'https://public.test/rebind' })).rejects.toThrow(/private/i);
    }
  });

  it('rejects IPv6 loopback encodings before connect', async () => {
    for (const address of ['::1', '0:0:0:0:0:0:0:1', '::0001', '::1%lo'] as const) {
      const inspect = new NodeSourceInspect({
        lookupImpl: async () => [{ address, family: 6 }],
        fetchImpl: async () => new Response('secret', { status: 200, headers: { 'content-type': 'text/plain' } }),
      });
      await expect(inspect.inspect({ url: 'https://public.test/rebind' })).rejects.toThrow(/private/i);
    }
  });

  it('rejects redirects onto the private network', async () => {
    const inspect = new NodeSourceInspect({
      lookupImpl: async (hostname) =>
        hostname === 'public.test' ? [{ address: '8.8.8.8', family: 4 }] : [{ address: '127.0.0.1', family: 4 }],
      fetchImpl: async () =>
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } }),
    });
    await expect(inspect.inspect({ url: 'https://public.test/page' })).rejects.toThrow(/private|Local-network/i);
  });

  it('truncates oversized bodies and rejects unsupported types', async () => {
    const inspect = new NodeSourceInspect({
      lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }],
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('bin')) {
          return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
        }
        const huge = 'a'.repeat(2_000_100);
        return new Response(huge, { status: 200, headers: { 'content-type': 'text/plain' } });
      },
    });
    await expect(inspect.inspect({ url: 'https://public.test/bin' })).rejects.toThrow(/Unsupported content type/i);
    const page = await inspect.inspect({ url: 'https://public.test/big' });
    expect(page.truncated).toBe(true);
  });

  it('rejects IPv6 loopback, ULA, mapped IPv4, mixed DNS, schemes, and long redirect chains', async () => {
    const inspect = new NodeSourceInspect({
      lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }],
    });
    await expect(inspect.inspect({ url: 'http://[::1]/' })).rejects.toThrow(/private/i);
    await expect(inspect.inspect({ url: 'http://[fd12:3456::1]/' })).rejects.toThrow(/private/i);
    await expect(inspect.inspect({ url: 'http://[fe80::1]/' })).rejects.toThrow(/private/i);
    await expect(inspect.inspect({ url: 'http://[::ffff:127.0.0.1]/' })).rejects.toThrow(/private/i);
    await expect(inspect.inspect({ url: 'http://[::ffff:10.0.0.1]/' })).rejects.toThrow(/private/i);
    await expect(inspect.inspect({ url: 'http://[::ffff:7f00:1]/' })).rejects.toThrow(/private/i);
    await expect(inspect.inspect({ url: 'http://127.1.2.3/' })).rejects.toThrow(/private/i);
    await expect(inspect.inspect({ url: 'http://172.16.0.1/' })).rejects.toThrow(/private/i);
    await expect(inspect.inspect({ url: 'http://0.0.0.0/' })).rejects.toThrow(/private/i);
    await expect(inspect.inspect({ url: 'file:///etc/passwd' })).rejects.toThrow(/http/i);
    await expect(inspect.inspect({ url: 'ftp://example.com/file' })).rejects.toThrow(/http/i);
    await expect(inspect.inspect({ url: 'gopher://example.com/1' })).rejects.toThrow(/http/i);

    const mixed = new NodeSourceInspect({
      lookupImpl: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      fetchImpl: async () => new Response('secret', { status: 200, headers: { 'content-type': 'text/plain' } }),
    });
    await expect(mixed.inspect({ url: 'https://public.test/mixed' })).rejects.toThrow(/private/i);

    let hops = 0;
    const chain = new NodeSourceInspect({
      lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }],
      fetchImpl: async () => {
        hops += 1;
        return new Response(null, { status: 302, headers: { location: `https://public.test/r${hops}` } });
      },
    });
    await expect(chain.inspect({ url: 'https://public.test/start' })).rejects.toThrow(/redirect/i);
    expect(hops).toBeLessThanOrEqual(6);
  });

  it('rejects 6to4 encodings of private IPv4', async () => {
    const inspect = new NodeSourceInspect({
      lookupImpl: async () => [{ address: '2002:c0a8:1::1', family: 6 }],
      fetchImpl: async () => new Response('secret', { status: 200, headers: { 'content-type': 'text/plain' } }),
    });
    await expect(inspect.inspect({ url: 'https://public.test/6to4' })).rejects.toThrow(/private/i);
  });

  it('fixture inspect remains available for mock spines', async () => {
    const page = await new FixtureInspect().inspect({ url: 'https://example.org/a' });
    expect(page.ok).toBe(true);
    expect(page.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
