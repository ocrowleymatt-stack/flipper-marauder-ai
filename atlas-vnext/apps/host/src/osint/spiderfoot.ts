import type { PublicLookupResult } from '@atlas-vnext/contracts';

/**
 * Optional specialist adapter. Absence is NOT CONFIGURED, never a fake PASS.
 * SpiderFoot is not Atlas research and is not invoked unless a base URL is set.
 */
export async function probeSpiderfoot(
  baseUrl: string | null | undefined,
  target: string,
  signal?: AbortSignal,
): Promise<PublicLookupResult | null> {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return {
      source: 'spiderfoot',
      probe: 'spiderfoot',
      summary: 'SpiderFoot is not configured.',
      confidence: 'possible',
      status: 'unknown',
      epistemicKind: 'hypothesis',
      evidence: JSON.stringify({ configured: false, target }),
      observedAt: new Date().toISOString(),
    };
  }
  try {
    const url = new URL('ping', trimmed.endsWith('/') ? trimmed : `${trimmed}/`);
    const response = await fetch(url, { method: 'GET', signal, redirect: 'error' });
    if (!response.ok) {
      return {
        source: 'spiderfoot',
        probe: 'spiderfoot',
        summary: `SpiderFoot ping HTTP ${response.status}`,
        confidence: 'possible',
        status: 'error',
        httpStatus: response.status,
        epistemicKind: 'observation',
        evidence: JSON.stringify({ configured: true, status: response.status }),
        observedAt: new Date().toISOString(),
      };
    }
    return {
      source: 'spiderfoot',
      probe: 'spiderfoot',
      summary: 'SpiderFoot instance reachable; scan start is not auto-fired from this Wave 2 ping.',
      confidence: 'likely',
      status: 'confirmed',
      httpStatus: response.status,
      epistemicKind: 'observation',
      evidence: JSON.stringify({ configured: true, ping: true }),
      observedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      source: 'spiderfoot',
      probe: 'spiderfoot',
      summary: 'SpiderFoot configured but unreachable.',
      confidence: 'possible',
      status: 'error',
      epistemicKind: 'observation',
      evidence: err instanceof Error ? err.message : String(err),
      observedAt: new Date().toISOString(),
    };
  }
}
