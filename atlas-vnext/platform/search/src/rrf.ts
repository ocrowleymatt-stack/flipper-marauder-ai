import type { SearchHit } from '@atlas-vnext/contracts';
import { canonicalUrl, classifySourceType } from './canonical.ts';

export const RRF_K = 60;

export interface RankedEngineHit {
  engine: string;
  rank: number;
  title: string;
  url: string;
  snippet: string;
  retrievedAt?: string;
}

export function fuseEngineHits(input: RankedEngineHit[], max = 50): SearchHit[] {
  const buckets = new Map<
    string,
    {
      title: string;
      url: string;
      snippet: string;
      engines: Set<string>;
      score: number;
      bestRank: number;
      retrievedAt: string;
    }
  >();
  const now = new Date().toISOString();
  for (const hit of input) {
    const canonical = canonicalUrl(hit.url);
    if (!canonical) continue;
    const existing = buckets.get(canonical);
    const contrib = 1 / (RRF_K + Math.max(1, hit.rank));
    if (!existing) {
      buckets.set(canonical, {
        title: hit.title.trim() || canonical,
        url: hit.url,
        snippet: hit.snippet,
        engines: new Set([hit.engine]),
        score: contrib,
        bestRank: hit.rank,
        retrievedAt: hit.retrievedAt ?? now,
      });
      continue;
    }
    existing.score += contrib;
    existing.engines.add(hit.engine);
    if (hit.rank < existing.bestRank) existing.bestRank = hit.rank;
    if (hit.snippet.length > existing.snippet.length) existing.snippet = hit.snippet;
    if (hit.title.trim().length > existing.title.length) existing.title = hit.title.trim();
  }
  return [...buckets.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[1].bestRank - b[1].bestRank)
    .slice(0, max)
    .map(([canonical, item], index) => ({
      rank: index + 1,
      title: item.title,
      url: item.url,
      canonicalUrl: canonical,
      snippet: item.snippet,
      engine: [...item.engines].sort().join('+'),
      sourceType: classifySourceType(canonical),
      engineCount: item.engines.size,
      engines: [...item.engines].sort(),
      retrievedAt: item.retrievedAt,
    }));
}
