import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { InspectedSource, SourceInspectPort } from '@atlas-vnext/contracts';
import { NodePublicLookup } from '../src/collectors.ts';
import { correlateObservations } from '../src/osint/correlate.ts';
import { looksLikeOsintQuestion, parseOsintTarget, usernameVariants } from '../src/osint/who-parse.ts';
import { USERNAME_SITES } from '../src/osint/catalog.ts';
import { probeSpiderfoot } from '../src/osint/spiderfoot.ts';

function inspectScript(
  script: (url: string) => { status: number; text: string; finalUrl?: string } | 'private',
): SourceInspectPort {
  return {
    async inspect(input: { url: string }): Promise<InspectedSource> {
      const result = script(input.url);
      if (result === 'private') throw new Error('Private or reserved network addresses are not permitted.');
      return {
        requestedUrl: input.url,
        finalUrl: result.finalUrl ?? input.url,
        status: result.status,
        ok: result.status >= 200 && result.status < 300,
        contentType: 'text/html',
        text: result.text,
        contentHash: createHash('sha256').update(result.text).digest('hex'),
        fetchedAt: '2026-09-19T17:00:00.000Z',
        truncated: false,
      };
    },
  };
}

const octocatInspect = inspectScript((url) => {
  if (/127\.0\.0\.1|localhost|10\.0\.|192\.168\./i.test(url)) return 'private';
  if (url.includes('github.com/octocat')) return { status: 200, text: 'The Octocat GitHub profile repositories' };
  if (url.includes('gitlab.com/octocat')) return { status: 200, text: 'octocat GitLab profile' };
  if (url.includes('news.ycombinator.com')) return { status: 200, text: 'No such user.' };
  if (url.includes('reddit.com')) return { status: 200, text: "sorry, nobody on reddit goes by that name" };
  if (url.includes('gravatar.com')) return { status: 404, text: 'not found' };
  if (url.includes('example.com')) return { status: 200, text: 'Example Domain This domain is for use in illustrative examples in documents.' };
  if (url.includes('web.archive.org')) return { status: 200, text: '[["urlkey","timestamp"],["com,example)/","20200101000000"]]' };
  if (url.endsWith('/rate-limited')) return { status: 429, text: 'slow down' };
  return { status: 404, text: 'page not found' };
});

describe('Wave 2 OSINT engine', () => {
  it('confirms public username presence via GET+soft-404, not syntactic stamps', async () => {
    const lookup = new NodePublicLookup({
      inspect: octocatInspect,
      now: () => '2026-09-19T17:00:00.000Z',
      sites: USERNAME_SITES,
      bounds: { maxSites: 8, maxVariants: 1, parallelism: 8, probeTimeoutMs: 1000, overallTimeoutMs: 5000, maxSearchHits: 0 },
    });
    const hits = await lookup.lookup({ kind: 'username', value: 'octocat' });
    const github = hits.find((hit) => hit.probe === 'username.github');
    const hn = hits.find((hit) => hit.probe === 'username.hackernews');
    const reddit = hits.find((hit) => hit.probe === 'username.reddit');
    const npm = hits.find((hit) => hit.probe === 'username.npm');
    expect(github?.status).toBe('confirmed');
    expect(github?.url).toMatch(/github\.com\/octocat/);
    expect(github?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(github?.epistemicKind).toBe('observation');
    expect(hn?.status).toBe('negative');
    expect(reddit?.status).toBe('negative');
    expect(npm?.status).toBe('negative');
    const correlation = hits.find((hit) => hit.epistemicKind === 'correlation');
    expect(correlation?.summary).toMatch(/GitHub/);
    expect(correlation?.summary).toMatch(/GitLab/);
    expect(hits.find((hit) => hit.probe === 'spiderfoot')?.summary).toMatch(/not configured/i);
  });

  it('distinguishes rate-limit and block from not-found', async () => {
    const lookup = new NodePublicLookup({
      inspect: inspectScript((url) => {
        if (url.includes('github.com')) return { status: 429, text: 'rate' };
        if (url.includes('gitlab.com')) return { status: 403, text: 'waf' };
        return { status: 404, text: 'missing' };
      }),
      now: () => '2026-09-19T17:00:00.000Z',
      sites: USERNAME_SITES.slice(0, 3),
      bounds: { maxSites: 3, maxVariants: 1, parallelism: 3, probeTimeoutMs: 500, overallTimeoutMs: 2000, maxSearchHits: 0 },
    });
    const hits = await lookup.lookup({ kind: 'username', value: 'octocat' });
    expect(hits.find((hit) => hit.probe === 'username.github')?.status).toBe('rate_limited');
    expect(hits.find((hit) => hit.probe === 'username.gitlab')?.status).toBe('blocked');
    expect(hits.find((hit) => hit.probe === 'username.reddit')?.status).toBe('negative');
  });

  it('bounds username variants and refuses private IP/URL targets', async () => {
    expect(usernameVariants('John Doe').length).toBeLessThanOrEqual(4);
    expect(parseOsintTarget('Run OSINT on octocat').kind).toBe('person');
    expect(parseOsintTarget('octocat', 'username').kind).toBe('username');
    expect(parseOsintTarget('https://example.com/x').kind).toBe('url');
    expect(looksLikeOsintQuestion('Run OSINT on octocat')).toBe(true);
    expect(looksLikeOsintQuestion('What did I say my dog’s name was?')).toBe(false);

    const lookup = new NodePublicLookup({ inspect: octocatInspect });
    const ip = await lookup.lookup({ kind: 'ip', value: '127.0.0.1' });
    expect(ip.some((hit) => hit.status === 'blocked' && hit.probe === 'ip.validate')).toBe(true);
    const mapped = await lookup.lookup({ kind: 'ip', value: '::ffff:127.0.0.1' });
    expect(mapped.some((hit) => hit.status === 'blocked')).toBe(true);
    const url = await lookup.lookup({ kind: 'url', value: 'http://127.0.0.1/' });
    expect(url.some((hit) => hit.status === 'blocked' && hit.probe === 'url.validate')).toBe(true);
  });

  it('inspects a public URL through Wave 1 inspect and correlates shared hosts', async () => {
    const lookup = new NodePublicLookup({ inspect: octocatInspect });
    const hits = await lookup.lookup({ kind: 'url', value: 'https://example.com/' });
    const page = hits.find((hit) => hit.probe === 'url.inspect');
    expect(page?.status).toBe('confirmed');
    expect(page?.summary).toMatch(/Example Domain/);
    const correlated = correlateObservations([
      { source: 'a', probe: 'username.github', url: 'https://github.com/octocat', summary: 'a', confidence: 'confirmed', status: 'confirmed', evidence: 'e', epistemicKind: 'observation' },
      { source: 'b', probe: 'username.gitlab', url: 'https://gitlab.com/octocat', summary: 'b', confidence: 'confirmed', status: 'confirmed', evidence: 'e', epistemicKind: 'observation' },
    ]);
    expect(correlated.some((hit) => hit.epistemicKind === 'correlation')).toBe(true);
  });

  it('reports SpiderFoot as NOT CONFIGURED rather than a fake pass', async () => {
    const absent = await probeSpiderfoot(null, 'octocat');
    expect(absent?.epistemicKind).toBe('hypothesis');
    expect(absent?.summary).toMatch(/not configured/i);
  });

  it('does not treat login redirects or challenge interstitials as confirmed profiles', async () => {
    const lookup = new NodePublicLookup({
      inspect: inspectScript((url) => {
        if (url.includes('github.com')) {
          return {
            status: 200,
            text: 'Sign in to GitHub · Password · Forgot password?',
            finalUrl: 'https://github.com/login?return_to=/octocat',
          };
        }
        if (url.includes('gitlab.com')) {
          return { status: 200, text: 'Just a moment... Checking your browser before continuing.' };
        }
        return { status: 404, text: 'page not found' };
      }),
      now: () => '2026-09-19T17:00:00.000Z',
      sites: USERNAME_SITES.filter((site) => site.id === 'github' || site.id === 'gitlab'),
      bounds: { maxSites: 2, maxVariants: 1, parallelism: 2, probeTimeoutMs: 500, overallTimeoutMs: 2000, maxSearchHits: 0 },
    });
    const hits = await lookup.lookup({ kind: 'username', value: 'octocat' });
    const github = hits.find((hit) => hit.probe === 'username.github');
    const gitlab = hits.find((hit) => hit.probe === 'username.gitlab');
    expect(github?.status).toBe('unknown');
    expect(github?.status).not.toBe('confirmed');
    expect(JSON.parse(github?.evidence ?? '{}').retained).toBe(false);
    expect(gitlab?.status).toBe('blocked');
    expect(gitlab?.summary).toMatch(/challenge/i);
    expect(hits.some((hit) => hit.epistemicKind === 'correlation')).toBe(false);
  });

  it('correlates a handle across distinct platforms, not duplicate hits on one site', () => {
    const githubA = {
      source: 'GitHub',
      probe: 'username.github',
      url: 'https://github.com/octocat',
      summary: 'GitHub profile',
      confidence: 'confirmed' as const,
      status: 'confirmed' as const,
      evidence: 'e',
      epistemicKind: 'observation' as const,
    };
    const githubB = {
      ...githubA,
      url: 'https://github.com/Octocat',
      summary: 'GitHub profile variant',
    };
    const gitlab = {
      source: 'GitLab',
      probe: 'username.gitlab',
      url: 'https://gitlab.com/octocat',
      summary: 'GitLab profile',
      confidence: 'confirmed' as const,
      status: 'confirmed' as const,
      evidence: 'e',
      epistemicKind: 'observation' as const,
    };
    const dupOnly = correlateObservations([githubA, githubB]);
    expect(dupOnly.filter((hit) => hit.source === 'correlation.username')).toHaveLength(0);
    const cross = correlateObservations([githubA, githubB, gitlab]);
    const usernameCorr = cross.find((hit) => hit.source === 'correlation.username');
    expect(usernameCorr?.summary).toMatch(/2 platforms/);
    expect(usernameCorr?.summary).toMatch(/GitHub/);
    expect(usernameCorr?.summary).toMatch(/GitLab/);
    expect(usernameCorr?.summary).not.toMatch(/GitHub, GitHub/);
  });

  it('honours abort on DNS lookups instead of waiting out the resolver', async () => {
    const lookup = new NodePublicLookup({
      inspect: octocatInspect,
      bounds: { maxSites: 1, maxVariants: 1, parallelism: 1, probeTimeoutMs: 8_000, overallTimeoutMs: 40_000, maxSearchHits: 0 },
    });
    const started = Date.now();
    const hits = await lookup.lookup({ kind: 'ip', value: '8.8.8.8', signal: AbortSignal.abort() });
    expect(Date.now() - started).toBeLessThan(2000);
    const ptr = hits.find((hit) => hit.probe === 'ip.ptr');
    expect(ptr?.status).toBe('error');
    expect(ptr?.evidence).toMatch(/aborted/);
  });
});
