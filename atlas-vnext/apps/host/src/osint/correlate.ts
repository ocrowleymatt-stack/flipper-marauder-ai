import type { PublicLookupResult } from '@atlas-vnext/contracts';

export interface OsintCorrelation {
  source: string;
  summary: string;
  confidence: 'confirmed' | 'likely' | 'possible';
  evidence: string;
  epistemicKind: 'correlation';
  status: 'likely';
  probe: 'correlation';
  observedAt: string;
}

export function correlateObservations(hits: PublicLookupResult[], now = new Date().toISOString()): OsintCorrelation[] {
  const observations = hits.filter(
    (hit) => (hit.epistemicKind ?? 'observation') === 'observation' && (hit.status === 'confirmed' || hit.status === 'likely'),
  );
  const byHost = new Map<string, PublicLookupResult[]>();
  for (const hit of observations) {
    const host = hostOf(hit.url ?? '');
    if (!host || host === 'unknown') continue;
    const list = byHost.get(host) ?? [];
    list.push(hit);
    byHost.set(host, list);
  }
  const confirmedSites = observations.filter((hit) => hit.probe?.startsWith('username.') && hit.status === 'confirmed');
  const out: OsintCorrelation[] = [];
  if (confirmedSites.length >= 2) {
    out.push({
      source: 'correlation.username',
      probe: 'correlation',
      summary: `Same username observed on ${confirmedSites.length} platforms: ${confirmedSites.map((item) => item.source).join(', ')}`,
      confidence: 'likely',
      status: 'likely',
      epistemicKind: 'correlation',
      evidence: JSON.stringify({
        kind: 'correlation',
        identifiers: confirmedSites.map((item) => ({ source: item.source, url: item.url, hash: item.contentHash })),
      }),
      observedAt: now,
    });
  }
  for (const [host, list] of byHost) {
    if (list.length < 2) continue;
    out.push({
      source: 'correlation.host',
      probe: 'correlation',
      summary: `Multiple independent observations share host ${host}`,
      confidence: 'likely',
      status: 'likely',
      epistemicKind: 'correlation',
      evidence: JSON.stringify({ kind: 'correlation', host, count: list.length, probes: list.map((item) => item.probe) }),
      observedAt: now,
    });
  }
  return out;
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return 'unknown';
  }
}
