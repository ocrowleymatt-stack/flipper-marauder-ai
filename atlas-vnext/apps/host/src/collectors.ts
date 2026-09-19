import { resolve as dnsResolve } from 'node:dns/promises';
import type { OsintTargetKind, PublicLookupResult } from '@atlas-vnext/contracts';
import type { PublicLookupPort } from '@atlas-vnext/dungeon-osint';
import { fetchPublicHttp } from './public-http.ts';

const UA = 'Atlas-vNext/0.1 (+https://atlas.ocrowley.com)';
const USERNAME_SITES: Array<{ id: string; url: (value: string) => string }> = [
  { id: 'github.com', url: (value) => `https://github.com/${encodeURIComponent(value)}` },
  { id: 'gitlab.com', url: (value) => `https://gitlab.com/${encodeURIComponent(value)}` },
  { id: 'reddit.com', url: (value) => `https://www.reddit.com/user/${encodeURIComponent(value)}` },
];

/**
 * Host-owned public lookup. Sockets stay out of the OSINT dungeon package.
 * Bounded, read-only, and never a TheBigBrother vendor.
 */
export class NodePublicLookup implements PublicLookupPort {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 4_000,
    private readonly mode: 'live' | 'mock' = 'live',
  ) {}

  async lookup(input: { kind: OsintTargetKind; value: string; signal?: AbortSignal }): Promise<PublicLookupResult[]> {
    const value = input.value.trim();
    if (!value) return [];
    const out: PublicLookupResult[] = [];
    const retrievedAt = new Date().toISOString();
    if (input.kind === 'domain' || input.kind === 'organisation' || looksLikeDomain(value)) {
      out.push(...(await lookupDomain(value, retrievedAt)));
      if (this.mode === 'live') {
        out.push(...(await this.httpHead(value.startsWith('http') ? value : `https://${value}`, retrievedAt, input.signal)));
        out.push(...(await this.wikipedia(value, retrievedAt, input.signal)));
      } else {
        out.push({
          source: 'wikipedia.search',
          summary: `${value} encyclopedia fixture`,
          confidence: 'likely',
          evidence: `Fixture encyclopedia snippet for ${value}.`,
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(value)}`,
          retrievedAt,
        });
      }
    }
    if (input.kind === 'email' || value.includes('@')) {
      const domain = value.split('@')[1] ?? value;
      out.push({
        source: 'syntax.email',
        summary: `Email-shaped identifier on ${domain}`,
        confidence: 'possible',
        evidence: `local-syntax:${value.replace(/^(.).*(@.*)$/, '$1***$2')}`,
        retrievedAt,
      });
      if (looksLikeDomain(domain)) {
        out.push(...(await lookupDomain(domain, retrievedAt)));
        if (this.mode === 'live') out.push(...(await this.httpHead(`https://${domain}`, retrievedAt, input.signal)));
      }
    }
    if (input.kind === 'username' || input.kind === 'person') {
      if (this.mode === 'live') {
        out.push(...(await this.usernameProbe(value, retrievedAt, input.signal)));
        out.push(...(await this.wikipedia(value, retrievedAt, input.signal)));
      } else {
        out.push({
          source: 'username.github.com',
          summary: `${value} appears claimed on github.com`,
          confidence: 'likely',
          evidence: JSON.stringify({ site: 'github.com', status: 200, fixture: true }),
          url: `https://github.com/${encodeURIComponent(value)}`,
          retrievedAt,
        });
        out.push({
          source: 'wikipedia.search',
          summary: value,
          confidence: 'possible',
          evidence: `Fixture encyclopedia snippet for ${value}.`,
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(value)}`,
          retrievedAt,
        });
      }
    }
    if (input.kind === 'ip') {
      out.push({
        source: 'syntax.ip',
        summary: `IP-shaped target ${value}`,
        confidence: 'possible',
        evidence: `atlas:osint:ip:${value}`,
        retrievedAt,
      });
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value) && this.mode === 'live') {
        out.push(...(await this.httpHead(`https://${value}`, retrievedAt, input.signal)));
      }
    }
    if (out.length === 0) {
      out.push({
        source: 'atlas.osint',
        summary: `Recorded target ${value} with no public resolution`,
        confidence: 'possible',
        evidence: `atlas:osint:raw:${input.kind}:${value}`,
        retrievedAt,
      });
    }
    return out;
  }

  private async wikipedia(query: string, retrievedAt: string, signal?: AbortSignal): Promise<PublicLookupResult[]> {
    try {
      const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=3&format=json&origin=*`;
      const page = await fetchPublicHttp({
        fetch: this.fetchImpl,
        url,
        init: {
          signal: abortAfter(signal, this.timeoutMs),
          headers: { 'user-agent': UA, accept: 'application/json' },
        },
        maxBytes: 32_768,
      });
      if (page.status < 200 || page.status >= 300) return [];
      const body = JSON.parse(page.body) as { query?: { search?: Array<{ title: string; snippet: string }> } };
      return (body.query?.search ?? []).map((row) => {
        const page = `https://en.wikipedia.org/wiki/${encodeURIComponent(row.title.replace(/ /g, '_'))}`;
        return {
          source: 'wikipedia.search',
          summary: row.title,
          confidence: 'likely' as const,
          evidence: strip(row.snippet || row.title),
          url: page,
          retrievedAt,
        };
      });
    } catch {
      return [];
    }
  }

  private async httpHead(url: string, retrievedAt: string, signal?: AbortSignal): Promise<PublicLookupResult[]> {
    try {
      const page = await fetchPublicHttp({
        fetch: this.fetchImpl,
        url,
        init: {
          method: 'GET',
          signal: abortAfter(signal, this.timeoutMs),
          headers: { 'user-agent': UA, accept: 'text/html' },
        },
        maxBytes: 32_768,
      });
      const title = extractTitle(page.body) || page.url;
      return [
        {
          source: 'http.document',
          summary: `${title} (${page.status})`,
          confidence: page.status >= 200 && page.status < 400 ? 'confirmed' : 'possible',
          evidence: strip(page.body).slice(0, 1_200),
          url: page.url,
          retrievedAt,
        },
      ];
    } catch (err) {
      return [
        {
          source: 'http.document',
          summary: `${url} did not fetch`,
          confidence: 'possible',
          evidence: JSON.stringify({ url, error: err instanceof Error ? err.message : String(err) }),
          url,
          retrievedAt,
        },
      ];
    }
  }

  private async usernameProbe(value: string, retrievedAt: string, signal?: AbortSignal): Promise<PublicLookupResult[]> {
    const out: PublicLookupResult[] = [];
    for (const site of USERNAME_SITES) {
      const url = site.url(value);
      try {
        const page = await fetchPublicHttp({
          fetch: this.fetchImpl,
          url,
          init: {
            method: 'GET',
            signal: abortAfter(signal, this.timeoutMs),
            headers: { 'user-agent': UA, accept: 'text/html' },
          },
          maxBytes: 8_192,
        });
        const claimed = page.status === 200;
        const available = page.status === 404;
        out.push({
          source: `username.${site.id}`,
          summary: claimed
            ? `${value} appears claimed on ${site.id}`
            : available
              ? `${value} was not found on ${site.id}`
              : `${site.id} returned HTTP ${page.status} for ${value}`,
          confidence: claimed ? 'likely' : available ? 'possible' : 'possible',
          evidence: JSON.stringify({ site: site.id, status: page.status, url }),
          url,
          retrievedAt,
        });
      } catch (err) {
        out.push({
          source: `username.${site.id}`,
          summary: `${site.id} lookup failed for ${value}`,
          confidence: 'possible',
          evidence: JSON.stringify({ site: site.id, url, error: err instanceof Error ? err.message : String(err) }),
          url,
          retrievedAt,
        });
      }
    }
    return out;
  }
}

async function lookupDomain(domain: string, retrievedAt: string): Promise<PublicLookupResult[]> {
  const out: PublicLookupResult[] = [];
  try {
    const addresses = await dnsResolve(domain);
    out.push({
      source: 'dns.a',
      summary: `${domain} resolves to ${addresses.slice(0, 4).join(', ')}`,
      confidence: 'confirmed',
      evidence: JSON.stringify({ domain, addresses: addresses.slice(0, 8) }),
      retrievedAt,
    });
  } catch (err) {
    out.push({
      source: 'dns.a',
      summary: `${domain} did not resolve`,
      confidence: 'possible',
      evidence: JSON.stringify({ domain, error: err instanceof Error ? err.message : String(err) }),
      retrievedAt,
    });
  }
  return out;
}

function looksLikeDomain(value: string): boolean {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value);
}

function strip(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return strip(match?.[1] ?? '');
}

function abortAfter(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) ctrl.abort();
  ctrl.signal.addEventListener(
    'abort',
    () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
    { once: true },
  );
  return ctrl.signal;
}
