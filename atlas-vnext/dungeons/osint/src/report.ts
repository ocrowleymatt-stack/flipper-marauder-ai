import type { OsintTargetKind, PublicLookupResult } from '@atlas-vnext/contracts';

export function looksLikeOsintRequest(text: string): boolean {
  const q = text.trim().toLowerCase();
  if (!q) return false;
  if (/\bosint\b/.test(q)) return true;
  if (/\bwho\(\)/.test(q)) return true;
  if (/\b(username|account)\s+(scan|enum|enumeration|presence)\b/.test(q)) return true;
  if (/\bdigital footprint\b/.test(q)) return true;
  if (/\benumerate\s+(usernames?|accounts?|presence)\b/.test(q)) return true;
  if (/\b(run|do|start)\s+(an?\s+)?(osint|username scan|footprint)\b/.test(q)) return true;
  return false;
}

export function looksLikeOsintFollowup(text: string): boolean {
  const q = text.trim().toLowerCase();
  if (!q) return false;
  if (/\bstrongest\b/.test(q) && /\bfindings?\b|\bevidence\b|\bobservations?\b/.test(q)) return true;
  if (/\bwhich sources\b/.test(q) || /\bsources support\b/.test(q)) return true;
  if (/\bopen the (second|2nd|first|third|3rd|last)\b/.test(q)) return true;
  if (/\b(second|2nd|first|third) (one|finding|observation)\b/.test(q)) return true;
  return false;
}

export function composeOsintReport(input: {
  kind: OsintTargetKind;
  value: string;
  hits: PublicLookupResult[];
  failed?: boolean;
}): string {
  const observations = input.hits.filter((hit) => (hit.epistemicKind ?? 'observation') === 'observation');
  const confirmed = observations.filter((hit) => hit.status === 'confirmed' || hit.confidence === 'confirmed');
  const negatives = observations.filter((hit) => hit.status === 'negative');
  const errors = observations.filter((hit) => hit.status === 'error' || hit.status === 'blocked' || hit.status === 'rate_limited');
  const correlations = input.hits.filter((hit) => hit.epistemicKind === 'correlation');
  const best = strongestHit(confirmed);
  const lines = [
    `OSINT ${input.kind} scan of \`${input.value}\`.`,
    `Observations: ${confirmed.length} confirmed/public, ${negatives.length} negative, ${errors.length} blocked/error.`,
  ];
  if (best) {
    lines.push(`Strongest finding: ${best.summary}${best.url ? ` (${best.url})` : ''}`);
  }
  if (confirmed.length) {
    lines.push('Strongest public observations:');
    for (const hit of confirmed.slice(0, 8)) {
      lines.push(
        `- ${hit.source}: ${hit.summary}${hit.url ? ` (${hit.url})` : ''}${hit.contentHash ? ` hash=${hit.contentHash.slice(0, 12)}` : ''}`,
      );
    }
  } else {
    lines.push('No confirmed public presence was observed.');
  }
  if (negatives.length) {
    lines.push(`Negative presence checks: ${negatives.map((hit) => hit.source).join(', ')}.`);
  }
  if (errors.length) {
    lines.push(
      `Blocked/error/rate-limited sources (not treated as not-found): ${errors.map((hit) => `${hit.source}:${hit.status}`).join(', ')}.`,
    );
  }
  if (correlations.length) {
    lines.push('Correlations (not facts):');
    for (const hit of correlations) lines.push(`- ${hit.summary}`);
  }
  const spider = input.hits.find((hit) => hit.probe === 'spiderfoot');
  if (spider) lines.push(`Specialist engine: ${spider.summary}`);
  lines.push(
    input.failed
      ? 'Scan did not complete: Atlas did not treat empty or unprobed output as intelligence.'
      : 'This report is evidence-backed. Atlas did not treat provider success as completion.',
  );
  return lines.join('\n');
}

export function strongestHit(hits: PublicLookupResult[]): PublicLookupResult | null {
  const rank: Record<string, number> = { confirmed: 3, likely: 2, possible: 1 };
  const observations = hits.filter(
    (hit) =>
      (hit.epistemicKind ?? 'observation') === 'observation' &&
      (hit.status === 'confirmed' || hit.status === 'likely' || hit.confidence === 'confirmed'),
  );
  return [...observations].sort((a, b) => (rank[b.confidence] ?? 0) - (rank[a.confidence] ?? 0))[0] ?? null;
}
