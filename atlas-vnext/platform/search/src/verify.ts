import type { ContradictionRecord, ResearchFinding } from '@atlas-vnext/contracts';

const PAIRS: Array<[RegExp, RegExp, string]> = [
  [/\b(invented|created|founded)\b/i, /\b(did not invent|wasn't invented|not invented)\b/i, 'attribution'],
  [/\b(first)\b/i, /\b(not the first|earlier than)\b/i, 'priority'],
  [/\b(confirmed|established|settled)\b/i, /\b(disputed|uncertain|controversial|unknown)\b/i, 'certainty'],
];

export function detectContradictions(findings: ResearchFinding[]): ContradictionRecord[] {
  const out: ContradictionRecord[] = [];
  for (let i = 0; i < findings.length; i += 1) {
    for (let j = i + 1; j < findings.length; j += 1) {
      const left = findings[i]!;
      const right = findings[j]!;
      if (left.host === right.host) continue;
      const blobL = `${left.title} ${left.summary} ${left.quote ?? ''}`;
      const blobR = `${right.title} ${right.summary} ${right.quote ?? ''}`;
      for (const [a, b, topic] of PAIRS) {
        if ((a.test(blobL) && b.test(blobR)) || (b.test(blobL) && a.test(blobR))) {
          out.push({ topic, left: left.url, right: right.url });
        }
      }
    }
  }
  return out.slice(0, 8);
}

export function strongestFinding(findings: ResearchFinding[]): ResearchFinding | null {
  if (findings.length === 0) return null;
  const rank = (item: ResearchFinding) =>
    (item.confidence === 'confirmed' ? 3 : item.confidence === 'likely' ? 2 : 1) +
    Math.min(2, item.summary.length / 180);
  return [...findings].sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

export function looksLikeResearchRequest(text: string): boolean {
  const t = text.trim();
  if (t.length < 28) return false;
  if (/\b(what did i say|those findings|what were we researching|dog'?s name)\b/i.test(t)) return false;
  if (/\busing multiple independent\b/i.test(t)) return true;
  if (/\bresearch\b/i.test(t) && /\b(history|sources|web|thorough|investigate|independent)\b/i.test(t)) return true;
  if (/^research\b/i.test(t) && t.split(/\s+/).length >= 5) return true;
  return false;
}
