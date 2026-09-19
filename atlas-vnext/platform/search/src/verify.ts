import type { ContradictionRecord, SearchCoverage, SearchHit } from '@atlas-vnext/contracts';

const STOP = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'is',
  'are',
  'was',
  'were',
  'be',
  'as',
  'by',
  'at',
  'from',
  'that',
  'this',
  'it',
  'its',
]);

const NEGATION = /\b(not|no|never|false|deny|denied|untrue|incorrect|refute|debunk|hoax)\b/i;
const AFFIRM = /\b(is|are|was|confirmed|true|official|verified)\b/i;

export function coverageOf(hits: SearchHit[], mode: 'search' | 'research' | 'deep' = 'research'): SearchCoverage {
  const engines = new Set(hits.flatMap((hit) => (hit.engines.length ? hit.engines : [hit.engine])));
  const primaryLike = hits.filter(
    (hit) => hit.sourceType === 'official' || hit.sourceType === 'academic' || hit.sourceType === 'encyclopedia',
  ).length;
  const score = Math.min(
    100,
    hits.length * (mode === 'deep' ? 4 : 8) + engines.size * 12 + primaryLike * 10,
  );
  const gaps: string[] = [];
  if (hits.length === 0) gaps.push('no_hits');
  if (engines.size < 2) gaps.push('single_engine');
  if (primaryLike === 0) gaps.push('no_primary_source');
  const target = mode === 'search' ? 70 : mode === 'deep' ? 92 : 82;
  if (score < target) gaps.push('coverage_below_stop');
  return { score, engineCount: engines.size, hitCount: hits.length, primaryLike, gaps };
}

export function planQueries(question: string, extra: string[] = []): string[] {
  const q = question.trim().replace(/\s+/g, ' ');
  if (!q) return extra;
  const out = [q];
  if (!/\b(source|primary|official)\b/i.test(q)) out.push(`${q} primary sources`);
  if (!/\b(critic|disput|controvers)\b/i.test(q)) out.push(`${q} controversy OR criticism OR disputed`);
  for (const item of extra) {
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed);
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const item of out) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item.slice(0, 400));
  }
  return unique.slice(0, 6);
}

export function tokensOf(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2 && !STOP.has(token)),
  );
}

export function detectContradictions(statements: Array<{ id: string; text: string }>): ContradictionRecord[] {
  const out: ContradictionRecord[] = [];
  for (let i = 0; i < statements.length; i += 1) {
    const a = statements[i]!;
    const aTokens = tokensOf(a.text);
    const aNeg = NEGATION.test(a.text);
    for (let j = i + 1; j < statements.length; j += 1) {
      const b = statements[j]!;
      const bTokens = tokensOf(b.text);
      const overlap = [...aTokens].filter((token) => bTokens.has(token)).length;
      if (overlap < 2) continue;
      const bNeg = NEGATION.test(b.text);
      if (aNeg !== bNeg && (AFFIRM.test(a.text) || AFFIRM.test(b.text))) {
        out.push({
          a: a.id,
          b: b.id,
          reason: 'Shared entities with opposing polarity.',
        });
      }
    }
  }
  return out;
}

export function strongestHit(hits: SearchHit[]): SearchHit | null {
  if (hits.length === 0) return null;
  const rank = (hit: SearchHit): number => {
    const type =
      hit.sourceType === 'official'
        ? 40
        : hit.sourceType === 'academic'
          ? 36
          : hit.sourceType === 'encyclopedia'
            ? 28
            : hit.sourceType === 'code'
              ? 16
              : 8;
    return type + hit.engineCount * 10 + Math.max(0, 20 - hit.rank);
  };
  return [...hits].sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

export function citationGrade(input: { snippet: string; url: string; inspected: boolean }): 'confirmed' | 'likely' | 'possible' | 'unknown' {
  if (!input.url) return 'unknown';
  if (input.inspected && input.snippet.trim().length > 80) return 'likely';
  if (input.inspected) return 'possible';
  if (input.snippet.trim().length > 40) return 'possible';
  return 'unknown';
}
