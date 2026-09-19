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

  it('does not false-confirm a known-absent GitHub username from a generic page', async () => {
    const hits = await lookup.lookup({ kind: 'username', value: 'this-user-does-not-exist-atlas-wave2-zzzz' });
    const github = hits.find((hit) => hit.probe === 'username.github');
    expect(github?.status).not.toBe('confirmed');
    expect(github?.status === 'negative' || github?.status === 'unknown' || github?.status === 'likely' || github?.status === 'blocked' || github?.status === 'error' || github?.status === 'rate_limited').toBe(
      true,
    );
  });

  it('collects DNS and TLS evidence for wikipedia.org', async () => {
    const hits = await lookup.lookup({ kind: 'domain', value: 'wikipedia.org' });
    expect(hits.some((hit) => (hit.probe === 'dns.a' || hit.probe === 'dns.aaaa') && hit.status === 'confirmed')).toBe(true);
    const tls = hits.find((hit) => hit.probe === 'domain.tls');
    if (tls) {
      const evidence = JSON.parse(tls.evidence);
      expect(evidence).toHaveProperty('authorized');
      if (evidence.authorized === true) {
        expect(tls.status).toBe('confirmed');
        expect(tls.summary).toMatch(/wikipedia/i);
      } else {
        expect(tls.status).not.toBe('confirmed');
      }
    }
    const web = hits.find((hit) => hit.probe === 'domain.web');
    expect(web?.status === 'confirmed' || web?.status === 'error' || web?.status === 'blocked').toBe(true);
  });

  it('observes MX for a documentation mailbox without inventing account presence', async () => {
    const hits = await lookup.lookup({ kind: 'email', value: 'nonexistent@example.com' });
    const mx = hits.find((hit) => hit.probe === 'email.mx');
    expect(mx).toBeTruthy();
    expect(mx?.epistemicKind).toBe('observation');
    const gravatar = hits.find((hit) => hit.probe === 'email.gravatar');
    if (gravatar?.status === 'confirmed') {
      expect(gravatar.httpStatus).toBe(200);
    } else if (gravatar) {
      expect(gravatar.status).not.toBe('confirmed');
    }
  });

  it('does not scan localhost', async () => {
    const hits = await lookup.lookup({ kind: 'ip', value: '127.0.0.1' });
    expect(hits.some((hit) => hit.status === 'blocked' && hit.probe === 'ip.validate')).toBe(true);
  });
});
