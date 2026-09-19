import type { OsintTargetKind } from '@atlas-vnext/contracts';

export interface ParsedOsintTarget {
  kind: OsintTargetKind;
  value: string;
  username?: string;
  email?: string;
  domain?: string;
  variants: string[];
}

const EMAIL = /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const DOMAIN = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;

export function looksLikeIpv6Literal(value: string): boolean {
  if (!value.includes(':')) return false;
  if (!/^[0-9a-f:.]+$/i.test(value)) return false;
  return (value.match(/:/g)?.length ?? 0) >= 2;
}

export function parseOsintTarget(raw: string, kind?: OsintTargetKind): ParsedOsintTarget {
  const value = raw.trim();
  if (!value) return { kind: kind ?? 'other', value: '', variants: [] };
  if (kind && kind !== 'other' && kind !== 'person') {
    return {
      kind,
      value,
      username: kind === 'username' ? value.replace(/^@/, '') : undefined,
      email: kind === 'email' ? value : undefined,
      domain: kind === 'domain' ? value : undefined,
      variants: usernameVariants(kind === 'username' ? value : ''),
    };
  }
  if (/^https?:\/\//i.test(value)) return { kind: 'url', value, variants: [] };
  if (EMAIL.test(value) && !value.includes(' ')) {
    const email = value.match(EMAIL)![0]!;
    return { kind: 'email', value: email, email, domain: email.split('@')[1], variants: [] };
  }
  if (IPV4.test(value) || looksLikeIpv6Literal(value)) return { kind: 'ip', value, variants: [] };
  if (DOMAIN.test(value) && !value.includes(' ')) return { kind: 'domain', value: value.toLowerCase(), domain: value.toLowerCase(), variants: [] };
  if (/^@?[A-Za-z0-9_.-]{2,32}$/.test(value) && !value.includes(' ')) {
    const username = value.replace(/^@/, '');
    return { kind: kind === 'person' ? 'person' : 'username', value: username, username, variants: usernameVariants(username) };
  }
  const handle = value.match(/(?:^|\s)@([A-Za-z0-9_]{2,32})\b/);
  if (handle) {
    const username = handle[1]!;
    return { kind: 'username', value: username, username, variants: usernameVariants(username) };
  }
  return { kind: kind ?? 'person', value, variants: usernameVariants(value) };
}

export function usernameVariants(input: string): string[] {
  const cleaned = input.replace(/^@/, '').trim();
  if (!cleaned) return [];
  const words = cleaned.split(/[\s._-]+/).filter((part) => part.length > 0);
  const out = new Set<string>();
  out.add(cleaned);
  out.add(cleaned.toLowerCase());
  if (words.length >= 2) {
    const first = words[0]!.toLowerCase();
    const last = words[words.length - 1]!.toLowerCase();
    out.add(`${first}${last}`);
    out.add(`${first}_${last}`);
    out.add(`${first}.${last}`);
  }
  return [...out].filter((item) => /^[A-Za-z0-9._-]{2,32}$/.test(item)).slice(0, 4);
}

export function looksLikeOsintQuestion(text: string): boolean {
  const q = text.trim().toLowerCase();
  if (!q) return false;
  if (/\b(osint|sherlock)\b/.test(q)) return true;
  if (/\bwho\(\)/.test(q)) return true;
  if (/\b(username|account)\s+(scan|enum|enumeration|presence)\b/.test(q)) return true;
  if (/\bdigital footprint\b/.test(q)) return true;
  if (/\benumerate\s+(usernames?|accounts?|presence)\b/.test(q)) return true;
  if (/\b(run|do|start)\s+(an?\s+)?(osint|username scan|footprint)\b/.test(q)) return true;
  if (/\b(spiderfoot|big.?brother)\b/.test(q)) return true;
  return false;
}
