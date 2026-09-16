import { resolve as dnsResolve } from 'node:dns/promises';
import type { OsintTargetKind, PublicLookupResult } from '@atlas-vnext/contracts';
import type { PublicLookupPort } from '@atlas-vnext/dungeon-osint';

/**
 * Host-owned public lookup. Sockets stay out of the OSINT dungeon package.
 * Bounded, read-only, and never a TheBigBrother vendor.
 */
export class NodePublicLookup implements PublicLookupPort {
  async lookup(input: { kind: OsintTargetKind; value: string; signal?: AbortSignal }): Promise<PublicLookupResult[]> {
    const value = input.value.trim();
    if (!value) return [];
    const out: PublicLookupResult[] = [];
    if (input.kind === 'domain' || input.kind === 'organisation' || looksLikeDomain(value)) {
      out.push(...(await lookupDomain(value)));
    }
    if (input.kind === 'email' || value.includes('@')) {
      const domain = value.split('@')[1] ?? value;
      out.push({
        source: 'syntax.email',
        summary: `Email-shaped identifier on ${domain}`,
        confidence: 'possible',
        evidence: `local-syntax:${value.replace(/^(.).*(@.*)$/, '$1***$2')}`,
      });
      if (looksLikeDomain(domain)) out.push(...(await lookupDomain(domain)));
    }
    if (input.kind === 'username' || input.kind === 'person') {
      out.push({
        source: 'pattern.username',
        summary: `Username pattern recorded for ${value}`,
        confidence: 'possible',
        evidence: `atlas:osint:username:${value.toLowerCase()}`,
      });
    }
    if (input.kind === 'ip') {
      out.push({
        source: 'syntax.ip',
        summary: `IP-shaped target ${value}`,
        confidence: 'possible',
        evidence: `atlas:osint:ip:${value}`,
      });
    }
    if (out.length === 0) {
      out.push({
        source: 'atlas.osint',
        summary: `Recorded target ${value} with no public resolution`,
        confidence: 'possible',
        evidence: `atlas:osint:raw:${input.kind}:${value}`,
      });
    }
    return out;
  }
}

async function lookupDomain(domain: string): Promise<PublicLookupResult[]> {
  const out: PublicLookupResult[] = [];
  try {
    const addresses = await dnsResolve(domain);
    out.push({
      source: 'dns.a',
      summary: `${domain} resolves to ${addresses.slice(0, 4).join(', ')}`,
      confidence: 'confirmed',
      evidence: JSON.stringify({ domain, addresses: addresses.slice(0, 8) }),
    });
  } catch (err) {
    out.push({
      source: 'dns.a',
      summary: `${domain} did not resolve`,
      confidence: 'possible',
      evidence: JSON.stringify({ domain, error: err instanceof Error ? err.message : String(err) }),
    });
  }
  return out;
}

function looksLikeDomain(value: string): boolean {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value);
}
