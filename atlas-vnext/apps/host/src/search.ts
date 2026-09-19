import type { FederatedSearchPort, SearchHit, SearchReport } from '@atlas-vnext/contracts';
import { canonicalUrl, dedupeHits, fuseHits, hostOf } from '@atlas-vnext/search';

const SEARCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_QUERY_CHARS = 400;
const MAX_QUERY_WORDS = 50;

export interface SearchEngine {
  readonly id: string;
  search(query: string, count: number, signal?: AbortSignal): Promise<SearchHit[]>;
}

export class FixtureSearchEngine implements SearchEngine {
  constructor(readonly id: string) {}

  async search(query: string, count: number): Promise<SearchHit[]> {
    const now = new Date().toISOString();
    const topic = query.trim() || 'query';
    const rows = [
      {
        title: `${topic} — encyclopedic overview`,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(topic.replace(/\s+/g, '_'))}`,
        snippet: `${topic}: a documented public overview used as an independent source.`,
      },
      {
        title: `${topic} — standards note`,
        url: 'https://www.w3.org/History/1989/proposal.html',
        snippet: `Independent technical source discussing ${topic} and related public standards.`,
      },
      {
        title: `${topic} — secondary analysis`,
        url: 'https://example.org/research/secondary',
        snippet: `A second independent write-up of ${topic} noting both established facts and remaining uncertainty.`,
      },
    ];
    return rows.slice(0, count).map((row, index) => ({
      engine: this.id,
      title: row.title,
      url: row.url,
      canonicalUrl: canonicalUrl(row.url) ?? row.url,
      snippet: row.snippet,
      rank: index + 1,
      retrievedAt: now,
      source: hostOf(row.url),
    }));
  }
}

export class BraveSearchEngine implements SearchEngine {
  readonly id = 'brave';
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async search(query: string, count: number, signal?: AbortSignal): Promise<SearchHit[]> {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(count));
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-subscription-token': this.apiKey,
        'user-agent': 'Atlas-vNext/0.1 (+research search)',
      },
      signal: mergeAbort(signal, SEARCH_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Brave search HTTP ${response.status}`);
    const payload = (await readBoundedJson(response)) as {
      web?: { results?: Array<{ title?: unknown; url?: unknown; description?: unknown }> };
    };
    const results = Array.isArray(payload.web?.results) ? payload.web!.results! : [];
    const now = new Date().toISOString();
    return results.flatMap((raw, index) => {
      if (typeof raw.url !== 'string' || typeof raw.title !== 'string') return [];
      const canonical = canonicalUrl(raw.url);
      if (!canonical) return [];
      return [
        {
          engine: this.id,
          title: raw.title,
          url: raw.url,
          canonicalUrl: canonical,
          snippet: typeof raw.description === 'string' ? raw.description : '',
          rank: index + 1,
          retrievedAt: now,
          source: hostOf(raw.url),
        },
      ];
    });
  }
}

export class SearxngSearchEngine implements SearchEngine {
  readonly id = 'searxng';
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async search(query: string, count: number, signal?: AbortSignal): Promise<SearchHit[]> {
    const url = new URL('search', this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': 'Atlas-vNext/0.1 (+self-hosted web search)',
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers,
      signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`SearXNG HTTP ${response.status}`);
    const payload = (await readBoundedJson(response)) as {
      results?: Array<{ title?: unknown; url?: unknown; content?: unknown }>;
    };
    const results = Array.isArray(payload.results) ? payload.results : [];
    const now = new Date().toISOString();
    return results.slice(0, count).flatMap((raw, index) => {
      if (typeof raw.url !== 'string' || typeof raw.title !== 'string') return [];
      const canonical = canonicalUrl(raw.url);
      if (!canonical) return [];
      return [
        {
          engine: this.id,
          title: raw.title,
          url: raw.url,
          canonicalUrl: canonical,
          snippet: typeof raw.content === 'string' ? raw.content : '',
          rank: index + 1,
          retrievedAt: now,
          source: hostOf(raw.url),
        },
      ];
    });
  }
}

export class WikipediaSearchEngine implements SearchEngine {
  readonly id = 'wikipedia';
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async search(query: string, count: number, signal?: AbortSignal): Promise<SearchHit[]> {
    const url = new URL('https://en.wikipedia.org/w/api.php');
    url.searchParams.set('action', 'opensearch');
    url.searchParams.set('search', query);
    url.searchParams.set('limit', String(Math.min(10, count)));
    url.searchParams.set('namespace', '0');
    url.searchParams.set('format', 'json');
    const response = await this.fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': 'Atlas-vNext/0.1 (+wikipedia opensearch)' },
      signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Wikipedia HTTP ${response.status}`);
    const payload = (await readBoundedJson(response)) as unknown;
    if (!Array.isArray(payload) || payload.length < 4) return [];
    const titles = Array.isArray(payload[1]) ? payload[1] : [];
    const snippets = Array.isArray(payload[2]) ? payload[2] : [];
    const urls = Array.isArray(payload[3]) ? payload[3] : [];
    const now = new Date().toISOString();
    return titles.flatMap((title, index) => {
      const href = urls[index];
      if (typeof title !== 'string' || typeof href !== 'string') return [];
      const canonical = canonicalUrl(href);
      if (!canonical) return [];
      return [
        {
          engine: this.id,
          title,
          url: href,
          canonicalUrl: canonical,
          snippet: typeof snippets[index] === 'string' ? snippets[index] : '',
          rank: index + 1,
          retrievedAt: now,
          source: 'en.wikipedia.org',
        },
      ];
    });
  }
}

export class NodeFederatedSearch implements FederatedSearchPort {
  constructor(
    private readonly engines: SearchEngine[],
    private readonly timeoutMs: number = SEARCH_TIMEOUT_MS,
  ) {}

  async search(input: { query: string; count?: number; signal?: AbortSignal }): Promise<SearchReport> {
    const query = input.query.trim();
    if (!query) throw new Error('Search query is required.');
    if (query.length > MAX_QUERY_CHARS || query.split(/\s+/).filter(Boolean).length > MAX_QUERY_WORDS) {
      throw new Error('Search query must be at most 400 characters and 50 words.');
    }
    const count = Math.min(20, Math.max(1, input.count ?? 8));
    const retrievedAt = new Date().toISOString();
    const lists: SearchHit[][] = [];
    const errors: SearchReport['errors'] = [];
    const engines: string[] = [];
    const signal = mergeAbort(input.signal, this.timeoutMs);
    await Promise.all(
      this.engines.map(async (engine) => {
        engines.push(engine.id);
        try {
          const hits = await withTimeout(engine.search(query, count, signal), this.timeoutMs);
          lists.push(hits);
        } catch (err) {
          errors.push({ engine: engine.id, message: err instanceof Error ? err.message : String(err) });
        }
      }),
    );
    const hits = fuseHits(lists.map(dedupeHits), count);
    return { query, hits, engines, errors, retrievedAt };
  }
}

export function searchEnginesFromEnv(
  env: Record<string, string | undefined>,
  mode: 'live' | 'mock',
  fetchImpl: typeof fetch = fetch,
): SearchEngine[] {
  if (mode === 'mock') {
    return [new FixtureSearchEngine('brave'), new FixtureSearchEngine('searxng')];
  }
  const engines: SearchEngine[] = [];
  const brave = env.BRAVE_SEARCH_API_KEY?.trim();
  if (brave) engines.push(new BraveSearchEngine(brave, fetchImpl));
  const searx = env.SEARXNG_BASE_URL?.trim();
  if (searx) engines.push(new SearxngSearchEngine(searx, env.SEARXNG_API_KEY?.trim(), fetchImpl));
  engines.push(new WikipediaSearchEngine(fetchImpl));
  return engines;
}

function mergeAbort(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  if (signal.aborted) return signal;
  return AbortSignal.any([signal, timeout]);
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`search timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error(`Search response exceeds ${MAX_RESPONSE_BYTES} bytes.`);
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(text) as unknown;
}
