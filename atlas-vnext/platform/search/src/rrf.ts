import type { SearchHit } from '@atlas-vnext/contracts';
import { canonicalUrl } from './canonical.ts';

/** Reciprocal rank fusion constant used by Atlas Mountain search fusion. */
export const RRF_K = 60;

export function fuseHits(rankedLists: SearchHit[][], limit = 20): SearchHit[] {
  const scores = new Map<string, { hit: SearchHit; score: number }>();
  for (const list of rankedLists) {
    for (const hit of list) {
      const key = canonicalUrl(hit.url) ?? hit.url;
      const current = scores.get(key);
      const add = 1 / (RRF_K + hit.rank);
      if (!current) {
        scores.set(key, { hit: { ...hit, canonicalUrl: key }, score: add });
      } else {
        current.score += add;
        if (hit.snippet.length > current.hit.snippet.length) current.hit.snippet = hit.snippet;
      }
    }
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row, index) => ({ ...row.hit, rank: index + 1 }));
}

export function dedupeHits(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const hit of hits) {
    const key = canonicalUrl(hit.url) ?? hit.url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...hit, canonicalUrl: key });
  }
  return out;
}
