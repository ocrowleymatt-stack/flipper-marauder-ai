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
  const byHandle = new Map<string, Map<string, PublicLookupResult>>();
  for (const hit of confirmedSites) {
    const handle = handleFromUsernameHit(hit);
    const platform = hit.source;
    if (!handle || !platform) continue;
    const platforms = byHandle.get(handle) ?? new Map<string, PublicLookupResult>();
    if (!platforms.has(platform)) platforms.set(platform, hit);
    byHandle.set(handle, platforms);
  }
  for (const [handle, platforms] of byHandle) {
    if (platforms.size < 2) continue;
    const members = [...platforms.values()];
    out.push({
      source: 'correlation.username',
      probe: 'correlation',
      summary: `Same username observed on ${platforms.size} platforms: ${members.map((item) => item.source).join(', ')}`,
      confidence: 'likely',
      status: 'likely',
      epistemicKind: 'correlation',
      evidence: JSON.stringify({
        kind: 'correlation',
        handle,
        identifiers: members.map((item) => ({ source: item.source, url: item.url, hash: item.contentHash })),
      }),
      observedAt: now,
    });
  }
  for (const [host, list] of byHost) {
    if (list.length < 2) continue;
    out.push({
      source: 'correlation.host',
      probe: 'correlation',
      summary: `Multiple observations share host ${host}`,
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

function handleFromUsernameHit(hit: PublicLookupResult): string | null {
  const url = hit.url ?? hit.canonicalUrl;
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname).replace(/\/+$/, '');
    const queryId = parsed.searchParams.get('id');
    if (queryId?.trim()) return queryId.replace(/^@/, '').toLowerCase();
    const last = path.split('/').filter(Boolean).at(-1);
    if (!last) return null;
    return last.replace(/^~/, '').replace(/^@/, '').replace(/^user:/i, '').toLowerCase();
  } catch {
    return null;
  }
}
