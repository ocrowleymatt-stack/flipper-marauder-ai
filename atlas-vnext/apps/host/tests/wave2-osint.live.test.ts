import { describe, expect, it } from 'vitest';
import { NodePublicLookup } from '../src/collectors.ts';
import { NodeSourceInspect } from '../src/inspect.ts';

const enabled = process.env.ATLAS_WAVE2_LIVE === '1';

describe.skipIf(!enabled)('Wave 2 live public-source OSINT', { timeout: 60_000 }, () => {
  const lookup = new NodePublicLookup({
    inspect: new NodeSourceInspect(),
    bounds: { maxSites: 8, maxVariants: 1, parallelism: 4, probeTimeoutMs: 8000, overallTimeoutMs: 40_000, maxSearchHits: 0 },
  });

  it('observes the public GitHub octocat username', async () => {
    const hits = await lookup.lookup({ kind: 'username', value: 'octocat' });
    const github = hits.find((hit) => hit.probe === 'username.github');
    expect(github?.status).toBe('confirmed');
    expect(github?.url).toMatch(/github\.com\/octocat/i);
    expect(github?.httpStatus).toBe(200);
    expect(github?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(github?.epistemicKind).toBe('observation');
    expect(hits.some((hit) => hit.status === 'negative' || hit.status === 'error' || hit.status === 'blocked' || hit.status === 'rate_limited')).toBe(
      true,
    );
  });

  it('collects DNS/web evidence for example.com', async () => {
    const hits = await lookup.lookup({ kind: 'domain', value: 'example.com' });
    const dns = hits.find((hit) => hit.probe === 'dns.a' && hit.status === 'confirmed');
    expect(dns?.summary).toMatch(/example\.com/);
    const web = hits.find((hit) => hit.probe === 'domain.web');
    expect(web?.status === 'confirmed' || web?.status === 'error' || web?.status === 'blocked').toBe(true);
    if (web?.status === 'confirmed') {
      expect(web.summary).toMatch(/Example Domain|example/i);
      expect(web.contentHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('acquires https://example.com through Wave 1 inspect', async () => {
    const hits = await lookup.lookup({ kind: 'url', value: 'https://example.com/' });
    const page = hits.find((hit) => hit.probe === 'url.inspect');
    expect(page?.status).toBe('confirmed');
    expect(page?.httpStatus).toBe(200);
    expect(page?.summary).toMatch(/Example Domain/i);
  });

  it('does not scan localhost', async () => {
    const hits = await lookup.lookup({ kind: 'ip', value: '127.0.0.1' });
    expect(hits.some((hit) => hit.status === 'blocked' && hit.probe === 'ip.validate')).toBe(true);
  });
});
