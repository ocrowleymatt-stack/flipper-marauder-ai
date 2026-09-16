/**
 * Low-cardinality platform metrics. Label values must be bounded enums
 * (route class, outcome, provider name, error class) — never request/tenant/
 * conversation/run/file IDs.
 */

export type MetricLabels = Record<string, string>;

const ALLOWED_LABEL_KEYS = new Set([
  'kind',
  'route_class',
  'outcome',
  'provider',
  'code',
  'component',
  'surface',
]);

const MAX_LABEL_VALUE = 64;

export interface MetricSnapshot {
  counters: Record<string, number>;
  histograms: Record<string, { count: number; sumMs: number; maxMs: number }>;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, { count: number; sumMs: number; maxMs: number }>();

  inc(name: string, labels: MetricLabels = {}, amount = 1): void {
    const key = seriesKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + amount);
  }

  observeMs(name: string, ms: number, labels: MetricLabels = {}): void {
    const key = seriesKey(name, labels);
    const current = this.histograms.get(key) ?? { count: 0, sumMs: 0, maxMs: 0 };
    current.count += 1;
    current.sumMs += Math.max(0, ms);
    current.maxMs = Math.max(current.maxMs, Math.max(0, ms));
    this.histograms.set(key, current);
  }

  snapshot(): MetricSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      histograms: Object.fromEntries(
        [...this.histograms.entries()].map(([key, value]) => [key, { ...value }]),
      ),
    };
  }
}

export const platformMetrics = new MetricsRegistry();

function seriesKey(name: string, labels: MetricLabels): string {
  const parts = [name];
  for (const key of Object.keys(labels).sort()) {
    if (!ALLOWED_LABEL_KEYS.has(key)) continue;
    const value = String(labels[key] ?? '').slice(0, MAX_LABEL_VALUE);
    if (!value) continue;
    parts.push(`${key}=${value}`);
  }
  return parts.join(',');
}

export function classifyRoute(pathname: string): string {
  if (pathname.startsWith('/api/health')) return 'health';
  if (pathname.startsWith('/api/metrics')) return 'metrics';
  if (pathname.startsWith('/api/session')) return 'auth';
  if (pathname.startsWith('/api/projects') && pathname.includes('/files')) return 'upload';
  if (pathname.startsWith('/api/files')) return 'files';
  if (pathname.startsWith('/api/context')) return 'retrieval';
  if (pathname.startsWith('/api/documents') || pathname.includes('/documents')) return 'documents';
  if (pathname.startsWith('/api/tools') || pathname.startsWith('/api/approvals')) return 'tools';
  if (pathname.includes('/messages') || pathname.startsWith('/api/executions')) return 'runs';
  if (pathname.startsWith('/api/conversations')) return 'conversations';
  if (pathname.startsWith('/api/projects')) return 'projects';
  if (pathname.startsWith('/api/dungeons')) return 'dungeons';
  return 'other';
}
