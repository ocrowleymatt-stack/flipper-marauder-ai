import type { FederatedSearchPort } from '@atlas-vnext/dungeon-research';
import {
  defaultAdapters,
  type ToolAdapter,
  type ToolAdapterContext,
  type ToolAdapterResult,
} from '@atlas-vnext/tools';
import { fetchPublicHttp } from './public-http.ts';

const UA = 'Atlas-vNext/0.1 (+https://atlas.ocrowley.com)';
const TOOL_BODY_BYTES = 8_192;

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
      const page = await fetchPublicHttp({
        fetch: fetchImpl,
        url,
        init: {
          method: 'GET',
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]),
          headers: { 'user-agent': UA, accept: 'application/json,text/plain,*/*' },
        },
        maxBytes: TOOL_BODY_BYTES,
      });
      let body: unknown = page.body;
      try {
        body = JSON.parse(page.body);
      } catch {
        // Keep capped text.
      }
      return { output: { url: page.url, status: page.status, body, mock: false } };
    },
  };
}

async function fetchPage(
  fetchImpl: typeof fetch,
  url: string,
  ctx: ToolAdapterContext,
  timeoutMs: number,
): Promise<ToolAdapterResult> {
  const page = await fetchPublicHttp({
    fetch: fetchImpl,
    url,
    init: {
      method: 'GET',
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]),
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    },
    maxBytes: TOOL_BODY_BYTES,
  });
  const title = page.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, ' ').trim() ?? page.url;
  const body = page.body.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8_000);
  return { output: { url: page.url, title, body, status: page.status, mock: false } };
}
