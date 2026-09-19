import type { FederatedSearchPort } from '@atlas-vnext/dungeon-research';
import {
  defaultAdapters,
  type ToolAdapter,
  type ToolAdapterContext,
  type ToolAdapterResult,
} from '@atlas-vnext/tools';

const UA = 'Atlas-vNext/0.1 (+https://atlas.ocrowley.com)';

export function productionToolAdapters(input: {
  search: FederatedSearchPort;
  fetch?: typeof fetch;
  timeoutMs?: number;
  liveNetwork?: boolean;
}): ToolAdapter[] {
  const fetchImpl = input.fetch ?? fetch;
  const timeoutMs = input.timeoutMs ?? 8_000;
  const liveById = new Map<string, ToolAdapter>([['retrieval.readonly', webSearchAdapter(input.search)]]);
  if (input.liveNetwork !== false) {
    liveById.set('browser.navigate', liveBrowserAdapter(fetchImpl, timeoutMs));
    liveById.set('api.read', liveApiReadAdapter(fetchImpl, timeoutMs));
  }
  return defaultAdapters().map((adapter) => liveById.get(adapter.id) ?? adapter);
}

function webSearchAdapter(search: FederatedSearchPort): ToolAdapter {
  return {
    id: 'retrieval.readonly',
    async execute(input): Promise<ToolAdapterResult> {
      const query = String(input.query ?? '').trim();
      const report = await search.search({ queries: query ? [query] : [], mode: 'search' });
      return {
        output: {
          query,
          engines: report.engines,
          hits: report.hits.map((hit) => ({
            id: hit.canonicalUrl,
            title: hit.title,
            snippet: hit.snippet,
            url: hit.canonicalUrl,
            source: hit.engine,
            sourceType: hit.sourceType,
          })),
          coverage: report.coverage,
        },
      };
    },
  };
}

function liveBrowserAdapter(fetchImpl: typeof fetch, timeoutMs: number): ToolAdapter {
  return {
    id: 'browser.navigate',
    async execute(input, ctx): Promise<ToolAdapterResult> {
      return fetchPage(fetchImpl, String(input.url ?? ''), ctx, timeoutMs);
    },
  };
}

function liveApiReadAdapter(fetchImpl: typeof fetch, timeoutMs: number): ToolAdapter {
  return {
    id: 'api.read',
    async execute(input, ctx): Promise<ToolAdapterResult> {
      const url = String(input.url ?? '');
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        signal: ctx.signal,
        headers: { 'user-agent': UA, accept: 'application/json,text/plain,*/*' },
      });
      const text = await response.text();
      let body: unknown = text.slice(0, 8_000);
      try {
        body = JSON.parse(text);
      } catch {
        // Keep text.
      }
      void timeoutMs;
      return { output: { url, status: response.status, body, mock: false } };
    },
  };
}

async function fetchPage(
  fetchImpl: typeof fetch,
  url: string,
  ctx: ToolAdapterContext,
  timeoutMs: number,
): Promise<ToolAdapterResult> {
  void timeoutMs;
  const response = await fetchImpl(url, {
    method: 'GET',
    redirect: 'follow',
    signal: ctx.signal,
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
  });
  const raw = await response.text();
  const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, ' ').trim() ?? url;
  const body = raw.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8_000);
  return { output: { url: response.url || url, title, body, status: response.status, mock: false } };
}

function abortAfter(timeoutMs: number): AbortSignal {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), timeoutMs);
  return ctrl.signal;
}
