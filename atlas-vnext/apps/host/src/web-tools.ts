import type { FederatedSearchPort, SourceInspectPort } from '@atlas-vnext/contracts';
import type { ToolAdapter, ToolAdapterResult } from '@atlas-vnext/tools';
import { defaultAdapters } from '@atlas-vnext/tools';

export function productionToolAdapters(input: {
  search: FederatedSearchPort;
  inspect: SourceInspectPort;
}): ToolAdapter[] {
  const base = defaultAdapters();
  const rest = base.filter((row) => row.id !== 'retrieval.readonly' && row.id !== 'browser.navigate' && row.id !== 'api.read');
  const retrieval: ToolAdapter = {
    id: 'retrieval.readonly',
    async execute(args): Promise<ToolAdapterResult> {
      const query = String(args.query ?? '').trim();
      const report = await input.search.search({ query, count: 8 });
      return {
        output: {
          hits: report.hits.map((hit) => ({
            id: hit.canonicalUrl,
            title: hit.title,
            snippet: hit.snippet,
            url: hit.url,
            engine: hit.engine,
          })),
          engines: report.engines,
          errors: report.errors,
        },
      };
    },
  };
  const browser: ToolAdapter = {
    id: 'browser.navigate',
    async execute(args): Promise<ToolAdapterResult> {
      const url = String(args.url ?? '');
      const page = await input.inspect.inspect({ url });
      const title = page.text.match(/<title[^>]*>([^<]+)/i)?.[1]?.trim() || page.finalUrl;
      return {
        output: {
          url: page.finalUrl,
          title,
          body: page.text.slice(0, 8_000),
          status: page.status,
          contentHash: page.contentHash,
        },
      };
    },
  };
  const api: ToolAdapter = {
    id: 'api.read',
    async execute(args): Promise<ToolAdapterResult> {
      const url = String(args.url ?? '');
      const page = await input.inspect.inspect({ url });
      return {
        output: {
          url: page.finalUrl,
          status: page.status,
          body: page.text.slice(0, 8_000),
          contentType: page.contentType,
        },
      };
    },
  };
  return [retrieval, browser, api, ...rest];
}
