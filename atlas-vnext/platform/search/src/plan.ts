const STOP = new Set([
  'the',
  'a',
  'an',
  'of',
  'and',
  'or',
  'to',
  'in',
  'on',
  'for',
  'with',
  'using',
  'multiple',
  'independent',
  'sources',
  'research',
  'thoroughly',
  'tell',
  'me',
  'what',
  'is',
  'are',
]);

export function termsOf(objective: string): string[] {
  return objective
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP.has(word))
    .slice(0, 12);
}

export function planQueries(objective: string): string[] {
  const q = objective.trim().replace(/\s+/g, ' ').slice(0, 400);
  if (!q) return [];
  const unique = new Set<string>([q]);
  unique.add(`${q} primary sources`);
  unique.add(`${q} timeline`);
  unique.add(`${q} controversy OR disputed OR criticism`);
  return [...unique].slice(0, 5);
}

export function coverageScore(objective: string, hosts: string[], snippets: string[]): {
  independentHosts: number;
  termHits: number;
  terms: string[];
  adequate: boolean;
} {
  const terms = termsOf(objective);
  const blob = snippets.join(' ').toLowerCase();
  const termHits = terms.filter((term) => blob.includes(term)).length;
  const independentHosts = new Set(hosts.filter(Boolean)).size;
  const adequate = independentHosts >= 2 && (terms.length === 0 || termHits >= Math.min(2, terms.length));
  return { independentHosts, termHits, terms, adequate };
}
