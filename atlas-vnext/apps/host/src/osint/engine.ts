import { createHash } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import tls from 'node:tls';
import type {
  FederatedSearchPort,
  OsintObservationStatus,
  OsintTargetKind,
  PublicLookupResult,
  SourceInspectPort,
} from '@atlas-vnext/contracts';
import type { PublicLookupPort } from '@atlas-vnext/dungeon-osint';
import { assertPublicHttpUrl, isPrivateAddress } from '@atlas-vnext/search';
import { OSINT_BOUNDS, USERNAME_SITES, resolveSiteUrl, type UsernameSite } from './catalog.ts';
import { parseOsintTarget, usernameVariants } from './who-parse.ts';
import { correlateObservations } from './correlate.ts';
import { probeSpiderfoot } from './spiderfoot.ts';

export interface OsintEngineDeps {
  inspect: SourceInspectPort;
  search?: FederatedSearchPort;
  spiderfootUrl?: string | null;
  now?: () => string;
  sites?: UsernameSite[];
  bounds?: Partial<typeof OSINT_BOUNDS>;
}

const SOFT_404 = [
  /page not found/i,
  /user not found/i,
  /doesn't exist/i,
  /does not exist/i,
  /no such user/i,
  /sorry, nobody on reddit goes by that name/i,
  /sorry, this page/i,
  /hasn't been claimed/i,
  /wikipedia does not have a user page/i,
];

export class NodePublicLookup implements PublicLookupPort {
  private readonly bounds: typeof OSINT_BOUNDS;
  constructor(private readonly deps: OsintEngineDeps) {
    if (!deps.inspect) throw new Error('OSINT collector requires Wave 1 source inspect.');
    this.bounds = { ...OSINT_BOUNDS, ...deps.bounds };
  }

  async lookup(input: { kind: OsintTargetKind; value: string; signal?: AbortSignal }): Promise<PublicLookupResult[]> {
    const parsed = parseOsintTarget(input.value, input.kind);
    if (!parsed.value) return [];
    const now = this.deps.now?.() ?? new Date().toISOString();
    if (parsed.kind === 'url') {
      try {
        assertPublicHttpUrl(parsed.value);
      } catch (err) {
        return [
          blockedTarget(parsed.value, now, 'url.validate', err instanceof Error ? err.message : String(err)),
        ];
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.bounds.overallTimeoutMs);
    const onAbort = () => controller.abort();
    input.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const hits: PublicLookupResult[] = [];
      if (parsed.kind === 'ip') {
        hits.push(...(await this.lookupIp(parsed.value, now)));
      } else if (parsed.kind === 'url') {
        hits.push(await this.inspectUrl(parsed.value, 'url.inspect', now, controller.signal));
      } else if (parsed.kind === 'domain' || parsed.kind === 'organisation') {
        hits.push(...(await this.lookupDomain(parsed.domain ?? parsed.value, now, controller.signal)));
      } else if (parsed.kind === 'email') {
        hits.push(...(await this.lookupEmail(parsed.email ?? parsed.value, now, controller.signal)));
      } else {
        const variants = (parsed.variants.length ? parsed.variants : usernameVariants(parsed.value)).slice(
          0,
          this.bounds.maxVariants,
        );
        const unique = [...new Set(variants.length ? variants : [parsed.value.replace(/^@/, '')])];
        for (const handle of unique) {
          if (controller.signal.aborted) break;
          hits.push(...(await this.lookupUsername(handle, now, controller.signal)));
        }
        if (parsed.kind === 'person' && this.deps.search && !controller.signal.aborted) {
          hits.push(...(await this.searchMentions(parsed.value, now, controller.signal)));
        }
      }
      if (!hits.some((hit) => hit.status === 'blocked' && (hit.probe === 'ip.validate' || hit.probe === 'url.validate'))) {
        const spider = await probeSpiderfoot(this.deps.spiderfootUrl, parsed.value, controller.signal);
        if (spider) hits.push(spider);
      }
      hits.push(...correlateObservations(hits, now));
      return dedupeHits(hits);
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
    }
  }

  private async lookupUsername(username: string, now: string, signal: AbortSignal): Promise<PublicLookupResult[]> {
    const sites = (this.deps.sites ?? USERNAME_SITES).slice(0, this.bounds.maxSites);
    return mapPool(sites, this.bounds.parallelism, async (site) => {
      const url = resolveSiteUrl(site, username);
      return this.inspectPresence(url, `username.${site.id}`, site.site, now, signal, site.soft404);
    });
  }

  private async lookupDomain(domain: string, now: string, signal: AbortSignal): Promise<PublicLookupResult[]> {
    const host = domain.replace(/^https?:\/\//, '').split('/')[0]!.toLowerCase();
    const out: PublicLookupResult[] = [];
    const records = await resolvePublicDns(host, now);
    out.push(...records.hits);
    if (records.publicAddresses.length) {
      const cert = await readPublicCertificate(host, records.publicAddresses[0]!, now);
      if (cert) out.push(cert);
      out.push(await this.inspectUrl(`https://${host}/`, 'domain.web', now, signal));
      out.push(
        await this.inspectUrl(
          `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(host)}&output=json&limit=5`,
          'domain.wayback',
          now,
          signal,
        ),
      );
    }
    return out;
  }

  private async lookupEmail(email: string, now: string, signal: AbortSignal): Promise<PublicLookupResult[]> {
    const domain = email.split('@')[1]?.toLowerCase() ?? '';
    const out: PublicLookupResult[] = [];
    if (domain) {
      try {
        const mx = await dns.resolveMx(domain);
        const hosts = mx
          .sort((a, b) => a.priority - b.priority)
          .slice(0, 6)
          .map((row) => row.exchange);
        out.push(
          observation({
            source: 'dns.mx',
            probe: 'email.mx',
            summary: `${domain} publishes MX ${hosts.join(', ') || '(none)'}`,
            confidence: hosts.length ? 'confirmed' : 'possible',
            status: hosts.length ? 'confirmed' : 'negative',
            evidence: JSON.stringify({ domain, mx: hosts }),
            observedAt: now,
          }),
        );
      } catch (err) {
        out.push(
          observation({
            source: 'dns.mx',
            probe: 'email.mx',
            summary: `${domain} MX lookup failed`,
            confidence: 'possible',
            status: 'error',
            evidence: JSON.stringify({ domain, error: err instanceof Error ? err.message : String(err) }),
            observedAt: now,
          }),
        );
      }
      out.push(...(await this.lookupDomain(domain, now, signal)));
    }
    const hash = createHash('md5').update(email.trim().toLowerCase()).digest('hex');
    out.push(
      await this.inspectPresence(
        `https://www.gravatar.com/avatar/${hash}?d=404`,
        'email.gravatar',
        'Gravatar',
        now,
        signal,
      ),
    );
    return out;
  }

  private async lookupIp(value: string, now: string): Promise<PublicLookupResult[]> {
    if (isPrivateAddress(value) || isIP(value) === 0) {
      return [
        blockedTarget(value, now, 'ip.validate', JSON.stringify({ value, private: isPrivateAddress(value) })),
      ];
    }
    try {
      const names = await dns.reverse(value);
      return [
        observation({
          source: 'dns.ptr',
          probe: 'ip.ptr',
          summary: names.length ? `${value} reverse DNS ${names.join(', ')}` : `${value} has no PTR`,
          confidence: names.length ? 'confirmed' : 'possible',
          status: names.length ? 'confirmed' : 'negative',
          evidence: JSON.stringify({ ip: value, names }),
          observedAt: now,
        }),
      ];
    } catch (err) {
      return [
        observation({
          source: 'dns.ptr',
          probe: 'ip.ptr',
          summary: `${value} reverse DNS failed`,
          confidence: 'possible',
          status: 'error',
          evidence: JSON.stringify({ ip: value, error: err instanceof Error ? err.message : String(err) }),
          observedAt: now,
        }),
      ];
    }
  }

  private async searchMentions(query: string, now: string, signal: AbortSignal): Promise<PublicLookupResult[]> {
    if (!this.deps.search) return [];
    try {
      const report = await this.deps.search.search({ query, count: this.bounds.maxSearchHits, signal });
      const out: PublicLookupResult[] = [];
      for (const hit of report.hits.slice(0, this.bounds.maxSearchHits)) {
        out.push(await this.inspectUrl(hit.url, `search.${hit.engine}`, now, signal));
      }
      for (const err of report.errors) {
        out.push(
          observation({
            source: err.engine,
            probe: 'search.error',
            summary: `Search engine ${err.engine} failed`,
            confidence: 'possible',
            status: 'error',
            evidence: err.message,
            observedAt: now,
          }),
        );
      }
      return out;
    } catch (err) {
      return [
        observation({
          source: 'search',
          probe: 'search.error',
          summary: 'Federated search failed',
          confidence: 'possible',
          status: 'error',
          evidence: err instanceof Error ? err.message : String(err),
          observedAt: now,
        }),
      ];
    }
  }

  private async inspectUrl(url: string, probe: string, now: string, signal: AbortSignal): Promise<PublicLookupResult> {
    try {
      const page = await this.deps.inspect.inspect({ url, signal });
      const text = page.text.replace(/\s+/g, ' ').trim().slice(0, 800);
      const ok = page.ok && Boolean(text);
      return observation({
        source: probe,
        probe,
        url: page.finalUrl || url,
        canonicalUrl: page.finalUrl || url,
        summary: ok ? `${probe} ${page.status} ${text.slice(0, 160)}` : `${probe} HTTP ${page.status}`,
        confidence: ok ? 'confirmed' : 'possible',
        status: ok ? 'confirmed' : classifyHttp(page.status),
        httpStatus: page.status,
        contentHash: page.contentHash,
        evidence: JSON.stringify({
          url,
          finalUrl: page.finalUrl,
          status: page.status,
          hash: page.contentHash,
          text: text.slice(0, 400),
        }),
        observedAt: now,
      });
    } catch (err) {
      return observation({
        source: probe,
        probe,
        url,
        summary: `${probe} failed: ${err instanceof Error ? err.message : String(err)}`,
        confidence: 'possible',
        status: /private|reserved|not permitted|local-network/i.test(err instanceof Error ? err.message : String(err))
          ? 'blocked'
          : 'error',
        evidence: err instanceof Error ? err.message : String(err),
        observedAt: now,
      });
    }
  }

  private async inspectPresence(
    url: string,
    probe: string,
    site: string,
    now: string,
    signal: AbortSignal,
    extraSoft?: string[],
  ): Promise<PublicLookupResult> {
    try {
      const page = await this.deps.inspect.inspect({ url, signal });
      const text = page.text.replace(/\s+/g, ' ').toLowerCase();
      if (page.status === 429) {
        return observation({
          source: site,
          probe,
          url,
          summary: `${site} rate-limited the presence check`,
          confidence: 'possible',
          status: 'rate_limited',
          httpStatus: 429,
          contentHash: page.contentHash,
          evidence: JSON.stringify({ url, status: 429 }),
          observedAt: now,
        });
      }
      if (page.status === 403 || page.status === 401) {
        return observation({
          source: site,
          probe,
          url,
          summary: `${site} blocked the presence check (HTTP ${page.status})`,
          confidence: 'possible',
          status: 'blocked',
          httpStatus: page.status,
          evidence: JSON.stringify({ url, status: page.status }),
          observedAt: now,
        });
      }
      const soft = extraSoft?.some((item) => text.includes(item.toLowerCase())) || SOFT_404.some((re) => re.test(text));
      const present = page.ok && page.status === 200 && !soft && text.length > 0;
      return observation({
        source: site,
        probe,
        url: page.finalUrl || url,
        canonicalUrl: page.finalUrl || url,
        summary: present ? `${site} profile observed at ${page.finalUrl || url}` : `${site} did not show a public profile`,
        confidence: present ? 'confirmed' : 'possible',
        status: present ? 'confirmed' : page.status === 404 || soft ? 'negative' : classifyHttp(page.status),
        httpStatus: page.status,
        contentHash: page.contentHash,
        evidence: JSON.stringify({
          url,
          finalUrl: page.finalUrl,
          status: page.status,
          hash: page.contentHash,
          soft404: soft,
          snippet: page.text.replace(/\s+/g, ' ').trim().slice(0, 400),
        }),
        observedAt: now,
        epistemicKind: 'observation',
      });
    } catch (err) {
      return observation({
        source: site,
        probe,
        url,
        summary: `${site} probe failed`,
        confidence: 'possible',
        status: /private|reserved|not permitted|local-network/i.test(err instanceof Error ? err.message : String(err))
          ? 'blocked'
          : 'error',
        evidence: err instanceof Error ? err.message : String(err),
        observedAt: now,
      });
    }
  }
}

async function resolvePublicDns(
  host: string,
  now: string,
): Promise<{ publicAddresses: string[]; hits: PublicLookupResult[] }> {
  const publicAddresses: string[] = [];
  const hits: PublicLookupResult[] = [];
  const kinds: Array<['dns.a' | 'dns.aaaa' | 'dns.ns' | 'dns.txt', () => Promise<string[]>]> = [
    ['dns.a', async () => dns.resolve4(host)],
    ['dns.aaaa', async () => dns.resolve6(host)],
    ['dns.ns', async () => dns.resolveNs(host)],
    ['dns.txt', async () => (await dns.resolveTxt(host)).map((row) => row.join(''))],
  ];
  for (const [source, fn] of kinds) {
    try {
      const values = await fn();
      const usable = values.filter((item) => (source === 'dns.a' || source === 'dns.aaaa' ? !isPrivateAddress(item) : true));
      const blocked = values.filter((item) => (source === 'dns.a' || source === 'dns.aaaa' ? isPrivateAddress(item) : false));
      if (source === 'dns.a' || source === 'dns.aaaa') publicAddresses.push(...usable);
      hits.push(
        observation({
          source,
          probe: source,
          summary: usable.length
            ? `${host} ${source} ${usable.slice(0, 6).join(', ')}`
            : blocked.length
              ? `${host} ${source} resolved only to private/reserved addresses`
              : `${host} ${source} empty`,
          confidence: usable.length ? 'confirmed' : 'possible',
          status: usable.length ? 'confirmed' : blocked.length ? 'blocked' : 'negative',
          evidence: JSON.stringify({ host, values: values.slice(0, 12), blocked: blocked.slice(0, 8) }),
          observedAt: now,
        }),
      );
    } catch (err) {
      hits.push(
        observation({
          source,
          probe: source,
          summary: `${host} ${source} lookup failed`,
          confidence: 'possible',
          status: 'error',
          evidence: JSON.stringify({ host, error: err instanceof Error ? err.message : String(err) }),
          observedAt: now,
        }),
      );
    }
  }
  return { publicAddresses, hits };
}

function readPublicCertificate(hostname: string, address: string, now: string): Promise<PublicLookupResult | null> {
  if (isPrivateAddress(address)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: address, port: 443, servername: hostname, rejectUnauthorized: false, timeout: 8000 },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || Object.keys(cert).length === 0) {
          resolve(null);
          return;
        }
        const subject = certificateCommonName(cert.subject);
        const issuer = certificateCommonName(cert.issuer);
        resolve(
          observation({
            source: 'tls.cert',
            probe: 'domain.tls',
            summary: `${hostname} certificate ${subject} issued by ${issuer}`,
            confidence: 'confirmed',
            status: 'confirmed',
            evidence: JSON.stringify({
              hostname,
              address,
              subject: cert.subject,
              issuer: cert.issuer,
              valid_from: cert.valid_from,
              valid_to: cert.valid_to,
            }),
            observedAt: now,
          }),
        );
      },
    );
    socket.on('error', () => resolve(null));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(null);
    });
  });
}

function certificateCommonName(value: tls.PeerCertificate['subject'] | tls.PeerCertificate['issuer'] | undefined): string {
  if (!value || typeof value !== 'object') return 'unknown';
  if ('CN' in value && typeof value.CN === 'string' && value.CN.trim()) return value.CN;
  return 'unknown';
}

function classifyHttp(status: number): OsintObservationStatus {
  if (status === 404) return 'negative';
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'blocked';
  if (status >= 500 || status === 0) return 'error';
  return 'unknown';
}

function observation(
  input: Omit<PublicLookupResult, 'epistemicKind'> & { epistemicKind?: PublicLookupResult['epistemicKind'] },
): PublicLookupResult {
  return { epistemicKind: 'observation', ...input };
}

function blockedTarget(value: string, now: string, probe: 'ip.validate' | 'url.validate', evidence: string): PublicLookupResult {
  return observation({
    source: 'ssrf',
    probe,
    summary: 'Private, reserved, or local-network targets are not scanned.',
    confidence: 'possible',
    status: 'blocked',
    evidence,
    observedAt: now,
  });
}

function dedupeHits(hits: PublicLookupResult[]): PublicLookupResult[] {
  const seen = new Set<string>();
  const out: PublicLookupResult[] = [];
  for (const hit of hits) {
    const key = `${hit.probe ?? hit.source}|${hit.url ?? hit.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

async function mapPool<T, R>(items: T[], parallelism: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(parallelism, items.length) || 0 }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      out[current] = await fn(items[current]!);
    }
  });
  await Promise.all(workers);
  return out;
}
