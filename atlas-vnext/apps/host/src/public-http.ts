import { isIP, BlockList } from 'node:net';
import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookupAsync } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

export class PrivateDestinationError extends Error {
  readonly code = 'private_destination';

  constructor() {
    super('Refusing non-public HTTP destination.');
    this.name = 'PrivateDestinationError';
  }
}

export class ResponseLimitError extends Error {
  readonly code = 'payload_too_large';

  constructor() {
    super('Response exceeded the configured byte limit.');
    this.name = 'ResponseLimitError';
  }
}

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type AddressLookup = (hostname: string) => Promise<Array<{ address: string; family?: number }>>;
export type PublicHttpTransport = (input: {
  url: string;
  init?: RequestInit;
  addresses: ResolvedAddress[];
}) => Promise<Response>;

const BLOCKED = new BlockList();
BLOCKED.addSubnet('0.0.0.0', 8, 'ipv4');
BLOCKED.addSubnet('10.0.0.0', 8, 'ipv4');
BLOCKED.addSubnet('100.64.0.0', 10, 'ipv4');
BLOCKED.addSubnet('127.0.0.0', 8, 'ipv4');
BLOCKED.addSubnet('169.254.0.0', 16, 'ipv4');
BLOCKED.addSubnet('172.16.0.0', 12, 'ipv4');
BLOCKED.addSubnet('192.168.0.0', 16, 'ipv4');
BLOCKED.addSubnet('198.18.0.0', 15, 'ipv4');
BLOCKED.addSubnet('224.0.0.0', 4, 'ipv4');
BLOCKED.addSubnet('240.0.0.0', 4, 'ipv4');
BLOCKED.addAddress('255.255.255.255', 'ipv4');
BLOCKED.addAddress('::', 'ipv6');
BLOCKED.addAddress('::1', 'ipv6');
BLOCKED.addSubnet('fc00::', 7, 'ipv6');
BLOCKED.addSubnet('fe80::', 10, 'ipv6');
BLOCKED.addSubnet('ff00::', 8, 'ipv6');

const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'kubernetes',
  'kubernetes.default',
  'kubernetes.default.svc',
  'host.docker.internal',
  'gateway.docker.internal',
]);

export function isPrivateIp(address: string): boolean {
  const trimmed = address.trim().toLowerCase();
  if (!trimmed) return true;
  const mapped = mappedIpv4(trimmed);
  if (mapped) return isPrivateIp(mapped);
  const encoded = encodedIpv4(trimmed);
  if (encoded) return isPrivateIp(encoded);
  const kind = isIP(trimmed);
  if (kind === 4) return BLOCKED.check(trimmed, 'ipv4');
  if (kind === 6) return BLOCKED.check(trimmed, 'ipv6');
  return true;
}

export function parsePublicHttpUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (!trimmed || /[\s\\]/.test(trimmed)) throw new PrivateDestinationError();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new PrivateDestinationError();
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new PrivateDestinationError();
  if (parsed.username || parsed.password) throw new PrivateDestinationError();
  const hostname = parsed.hostname.replace(/\.$/, '').toLowerCase();
  if (!hostname) throw new PrivateDestinationError();
  if (BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new PrivateDestinationError();
  }
  if (isIP(hostname) && isPrivateIp(hostname)) throw new PrivateDestinationError();
  return parsed;
}

export async function resolvePublicHttpDestination(
  raw: string,
  resolve: AddressLookup = defaultLookup,
): Promise<{ url: URL; addresses: ResolvedAddress[] }> {
  const parsed = parsePublicHttpUrl(raw);
  const hostname = parsed.hostname.replace(/\.$/, '');
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new PrivateDestinationError();
    return { url: parsed, addresses: [toResolved(hostname)] };
  }
  const records = await resolve(hostname);
  if (!records.length) throw new PrivateDestinationError();
  const addresses: ResolvedAddress[] = [];
  for (const record of records) {
    if (isPrivateIp(record.address)) throw new PrivateDestinationError();
    addresses.push(toResolved(record.address, record.family));
  }
  return { url: parsed, addresses };
}

export async function assertPublicHttpDestination(
  raw: string,
  resolve: AddressLookup = defaultLookup,
): Promise<URL> {
  return (await resolvePublicHttpDestination(raw, resolve)).url;
}

export async function fetchPublicHttp(input: {
  fetch?: typeof fetch;
  url: string;
  init?: RequestInit;
  maxRedirects?: number;
  maxBytes?: number;
  lookup?: AddressLookup;
  transport?: PublicHttpTransport;
  pin?: boolean;
}): Promise<{ url: string; status: number; body: string; headers: Headers }> {
  const maxRedirects = input.maxRedirects ?? 5;
  const maxBytes = input.maxBytes ?? 8_192;
  const lookup = input.lookup ?? defaultLookup;
  const pin = input.pin ?? (input.fetch === undefined || input.fetch === globalThis.fetch);
  let current = input.url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const resolved = await resolvePublicHttpDestination(current, lookup);
    const init: RequestInit = { ...input.init, redirect: 'manual' };
    const response = input.transport
      ? await input.transport({ url: current, init, addresses: resolved.addresses })
      : pin
        ? await pinnedHttpTransport({ url: current, init, addresses: resolved.addresses })
        : await (input.fetch ?? fetch)(current, init);
    if (isRedirect(response.status)) {
      const location = response.headers.get('location');
      if (!location || hop === maxRedirects) throw new PrivateDestinationError();
      current = new URL(location, current).toString();
      continue;
    }
    const length = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(length) && length > maxBytes) throw new ResponseLimitError();
    const body = await readCapped(response, maxBytes);
    return { url: response.url || current, status: response.status, body, headers: response.headers };
  }
  throw new PrivateDestinationError();
}

export type NodeLookup = NonNullable<https.RequestOptions['lookup']>;

export function pinnedLookup(addresses: ResolvedAddress[]): NodeLookup {
  return ((hostname: string, options: unknown, callback?: unknown) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' || options === undefined ? {} : options;
    if (typeof cb !== 'function') return;
    if (!addresses.length) {
      const err = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
      cb(err as NodeJS.ErrnoException, '', 4);
      return;
    }
    if (typeof opts === 'object' && opts && 'all' in opts && (opts as { all?: boolean }).all) {
      (cb as (err: NodeJS.ErrnoException | null, result: LookupAddress[]) => void)(
        null,
        addresses.map((row) => ({ address: row.address, family: row.family })),
      );
      return;
    }
    const first = addresses[0]!;
    (cb as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
      null,
      first.address,
      first.family,
    );
  }) as NodeLookup;
}

export async function pinnedHttpTransport(input: {
  url: string;
  init?: RequestInit;
  addresses: ResolvedAddress[];
}): Promise<Response> {
  const parsed = new URL(input.url);
  const lib = parsed.protocol === 'https:' ? https : http;
  const method = String(input.init?.method ?? 'GET').toUpperCase();
  const headers = new Headers(input.init?.headers);
  if (!headers.has('host')) headers.set('host', parsed.host);
  const headerRecord: http.OutgoingHttpHeaders = {};
  headers.forEach((value, key) => {
    headerRecord[key] = value;
  });
  const signal = input.init?.signal ?? undefined;
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: headerRecord,
        servername: parsed.protocol === 'https:' && !isIP(parsed.hostname) ? parsed.hostname : undefined,
        lookup: pinnedLookup(input.addresses),
      },
      (res) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(key, item);
          } else {
            responseHeaders.set(key, value);
          }
        }
        resolve(
          new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            headers: responseHeaders,
          }),
        );
      },
    );
    const onAbort = () => {
      req.destroy(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    const body = input.init?.body;
    if (typeof body === 'string') req.write(body);
    else if (body instanceof Uint8Array) req.write(body);
    req.end();
  });
}

async function defaultLookup(hostname: string): Promise<Array<{ address: string; family?: number }>> {
  return dnsLookupAsync(hostname, { all: true, verbatim: true });
}

function toResolved(address: string, family?: number): ResolvedAddress {
  const kind = family === 6 || family === 4 ? family : isIP(address);
  if (kind !== 4 && kind !== 6) throw new PrivateDestinationError();
  return { address, family: kind === 6 ? 6 : 4 };
}

function mappedIpv4(address: string): string | null {
  const match = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  return match?.[1] ?? null;
}

function encodedIpv4(address: string): string | null {
  const groups = ipv6Groups(address);
  if (!groups) return null;
  const octet = (group: number): [number, number] => [group >> 8, group & 0xff];
  if (groups[0] === 0x2002) {
    const [a, b] = octet(groups[1] ?? 0);
    const [c, d] = octet(groups[2] ?? 0);
    return `${a}.${b}.${c}.${d}`;
  }
  if (
    groups[0] === 0x64 &&
    groups[1] === 0xff9b &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0
  ) {
    const [a, b] = octet(groups[6] ?? 0);
    const [c, d] = octet(groups[7] ?? 0);
    return `${a}.${b}.${c}.${d}`;
  }
  return null;
}

function ipv6Groups(address: string): number[] | null {
  let addr = address.trim().toLowerCase();
  const zone = addr.indexOf('%');
  if (zone >= 0) addr = addr.slice(0, zone);
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  const dotted = addr.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const ipv4 = dotted[2];
    if (!ipv4) return null;
    const parts = ipv4.split('.').map((item) => Number(item));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((parts[0] ?? 0) << 8) | (parts[1] ?? 0);
    const lo = ((parts[2] ?? 0) << 8) | (parts[3] ?? 0);
    addr = `${dotted[1] ?? ''}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const parse = (value: string): number[] | null => {
    if (!value) return [];
    const parts = value.split(':');
    if (parts.some((part) => !part || /[^0-9a-f]/.test(part) || part.length > 4)) return null;
    const groups = parts.map((part) => parseInt(part, 16));
    if (groups.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
    return groups;
  };
  if (addr.includes('::')) {
    const pieces = addr.split('::');
    if (pieces.length !== 2) return null;
    const left = parse(pieces[0] ?? '');
    const right = parse(pieces[1] ?? '');
    if (!left || !right) return null;
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    return [...left, ...Array(fill).fill(0), ...right];
  }
  const groups = parse(addr);
  return groups?.length === 8 ? groups : null;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseLimitError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}
