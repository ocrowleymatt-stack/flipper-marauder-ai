import type { InspectedSource, SearchMode, SearchReport } from '@atlas-vnext/contracts';
import type { FederatedSearchPort } from '@atlas-vnext/dungeon-research';
import {
  canonicalUrl,
  coverageOf,
  fuseEngineHits,
  type RankedEngineHit,
} from '@atlas-vnext/search';
import { fetchPublicHttp } from './public-http.ts';

const UA = 'Atlas-vNext/0.1 (+https://atlas.ocrowley.com)';
const DEFAULT_TIMEOUT_MS = 4_000;

export interface SearchEngine {
  readonly id: string;
  search(query: string, signal?: AbortSignal): Promise<RankedEngineHit[]>;
}

export interface HostSearchOptions {
  mode?: 'live' | 'mock';
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  engines?: SearchEngine[];
  timeoutMs?: number;
}

export class NodeFederatedSearch implements FederatedSearchPort {
  private readonly fetchImpl: typeof fetch;
  private readonly engines: SearchEngine[];
  private readonly timeoutMs: number;
  private readonly mode: 'live' | 'mock';

  constructor(options: HostSearchOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.mode = options.mode === 'live' ? 'live' : options.mode === 'mock' ? 'mock' : 'live';
    this.engines =
      options.engines ??
      (options.mode === 'mock'
        ? [new FixtureEngine()]
        : [
            new WikipediaEngine(this.fetchImpl, this.timeoutMs),
            new DuckDuckGoEngine(this.fetchImpl, this.timeoutMs),
            ...(options.env?.BRAVE_SEARCH_API_KEY
              ? [new BraveEngine(this.fetchImpl, this.timeoutMs, options.env.BRAVE_SEARCH_API_KEY)]
              : []),
          ]);
  }

  async search(input: { queries: string[]; mode?: SearchMode; signal?: AbortSignal }): Promise<SearchReport> {
    const mode = input.mode ?? 'research';
    const queries = input.queries.map((item) => item.trim()).filter(Boolean).slice(0, mode === 'deep' ? 6 : 4);
    const collected: RankedEngineHit[] = [];
    const engineIds: string[] = [];
    const retrievedAt = new Date().toISOString();
    for (const query of queries) {
      const rows = await Promise.all(
        this.engines.map(async (engine) => {
          try {
            const hits = await engine.search(query, input.signal);
            engineIds.push(engine.id);
            return hits;
          } catch {
            return [];
          }
        }),
      );
      collected.push(...rows.flat());
    }
    const max = mode === 'search' ? 20 : mode === 'deep' ? 100 : 50;
    const hits = fuseEngineHits(collected, max).map((hit) => ({ ...hit, retrievedAt: hit.retrievedAt || retrievedAt }));
    const engines = [...new Set(engineIds)];
    return {
      queries,
      mode,
      engines,
      hits,
      coverage: coverageOf(hits, mode),
      retrievedAt,
    };
  }

  async inspect(input: { url: string; signal?: AbortSignal }): Promise<InspectedSource | null> {
    const canonical = canonicalUrl(input.url);
    if (!canonical.startsWith('http')) return null;
    if (this.mode === 'mock') {
      return {
        url: input.url,
        canonicalUrl: canonical,
        title: canonical.split('/').pop()?.replace(/_/g, ' ') || canonical,
        excerpt: `Inspected fixture source at ${canonical}.`,
        status: 200,
        retrievedAt: new Date().toISOString(),
      };
    }
    try {
      const page = await fetchPublicHttp({
        fetch: this.fetchImpl,
        url: canonical,
        init: {
          method: 'GET',
          signal: abortAfter(input.signal, this.timeoutMs),
          headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8' },
        },
        maxBytes: 32_768,
      });
      const excerpt = stripHtml(page.body).slice(0, 4_000);
      const title = extractTitle(page.body) || canonical;
      return {
        url: input.url,
        canonicalUrl: canonical,
        title,
        excerpt,
        status: page.status,
        retrievedAt: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }
}

class WikipediaEngine implements SearchEngine {
  readonly id = 'wikipedia';
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly timeoutMs: number,
  ) {}
  async search(query: string, signal?: AbortSignal): Promise<RankedEngineHit[]> {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=8&format=json&origin=*`;
    const response = await this.fetchImpl(url, {
      signal: abortAfter(signal, this.timeoutMs),
      headers: { 'user-agent': UA, accept: 'application/json' },
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { query?: { search?: Array<{ title: string; snippet: string; pageid: number }> } };
    return (body.query?.search ?? []).map((row, index) => ({
      engine: this.id,
      rank: index + 1,
      title: row.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(row.title.replace(/ /g, '_'))}`,
      snippet: stripHtml(row.snippet ?? ''),
    }));
  }
}

class DuckDuckGoEngine implements SearchEngine {
  readonly id = 'duckduckgo';
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly timeoutMs: number,
  ) {}
  async search(query: string, signal?: AbortSignal): Promise<RankedEngineHit[]> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await this.fetchImpl(url, {
      signal: abortAfter(signal, this.timeoutMs),
      headers: { 'user-agent': UA, accept: 'text/html' },
    });
    if (!response.ok) return [];
    const html = await response.text();
    return parseDuckDuckGo(html).slice(0, 10);
  }
}

class BraveEngine implements SearchEngine {
  readonly id = 'brave';
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly timeoutMs: number,
    private readonly apiKey: string,
  ) {}
  async search(query: string, signal?: AbortSignal): Promise<RankedEngineHit[]> {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query.slice(0, 400))}&count=10`;
    const response = await this.fetchImpl(url, {
      signal: abortAfter(signal, this.timeoutMs),
      headers: { 'user-agent': UA, accept: 'application/json', 'x-subscription-token': this.apiKey },
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { web?: { results?: Array<{ title: string; url: string; description?: string }> } };
    return (body.web?.results ?? []).map((row, index) => ({
      engine: this.id,
      rank: index + 1,
      title: row.title,
      url: row.url,
      snippet: row.description ?? '',
    }));
  }
}

class FixtureEngine implements SearchEngine {
  readonly id = 'fixture';
  async search(query: string): Promise<RankedEngineHit[]> {
    const slug = encodeURIComponent(query.trim().replace(/\s+/g, '_').slice(0, 64) || 'query');
    return [
      {
        engine: 'wikipedia',
        rank: 1,
        title: `${query.trim() || 'Query'} — encyclopedia`,
        url: `https://en.wikipedia.org/wiki/${slug}`,
        snippet: `Encyclopedia entry matching “${query.trim()}”.`,
      },
      {
        engine: 'duckduckgo',
        rank: 1,
        title: `${query.trim() || 'Query'} — independent source`,
        url: `https://example.test/research/${slug}`,
        snippet: `Independent public page for “${query.trim()}”.`,
      },
    ];
  }
}

export function parseDuckDuckGo(html: string): RankedEngineHit[] {
  const hits: RankedEngineHit[] = [];
  const resultRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = resultRe.exec(html))) {
    const href = decodeDuckHref(match[1] ?? '');
    const title = stripHtml(match[2] ?? '').trim();
    if (!href || !title) continue;
    hits.push({ engine: 'duckduckgo', rank: hits.length + 1, title, url: href, snippet: title });
  }
  if (hits.length === 0) {
    const uddg = /uddg=([^&"]+)/gi;
    while ((match = uddg.exec(html))) {
      const href = safeDecode(match[1] ?? '');
      if (!href.startsWith('http')) continue;
      hits.push({
        engine: 'duckduckgo',
        rank: hits.length + 1,
        title: href,
        url: href,
        snippet: '',
      });
    }
  }
  return hits;
}

function decodeDuckHref(href: string): string {
  try {
    const url = new URL(href, 'https://html.duckduckgo.com');
    const uddg = url.searchParams.get('uddg');
    if (uddg) return uddg;
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
    return '';
  } catch {
    return '';
  }
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&/g, '&')
    .replace(/"/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return stripHtml(match?.[1] ?? '');
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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
