import { isIP, BlockList } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

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

export type AddressLookup = (hostname: string) => Promise<Array<{ address: string }>>;

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

export async function assertPublicHttpDestination(
  raw: string,
  resolve: AddressLookup = defaultLookup,
): Promise<URL> {
  const parsed = parsePublicHttpUrl(raw);
  const hostname = parsed.hostname.replace(/\.$/, '');
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new PrivateDestinationError();
    return parsed;
  }
  const records = await resolve(hostname);
  if (!records.length) throw new PrivateDestinationError();
  for (const record of records) {
    if (isPrivateIp(record.address)) throw new PrivateDestinationError();
  }
  return parsed;
}

export async function fetchPublicHttp(input: {
  fetch: typeof fetch;
  url: string;
  init?: RequestInit;
  maxRedirects?: number;
  maxBytes?: number;
  lookup?: AddressLookup;
}): Promise<{ url: string; status: number; body: string; headers: Headers }> {
  const maxRedirects = input.maxRedirects ?? 5;
  const maxBytes = input.maxBytes ?? 8_192;
  let current = input.url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertPublicHttpDestination(current, input.lookup ?? defaultLookup);
    const response = await input.fetch(current, {
      ...input.init,
      redirect: 'manual',
    });
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

async function defaultLookup(hostname: string): Promise<Array<{ address: string }>> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function mappedIpv4(address: string): string | null {
  const match = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  return match?.[1] ?? null;
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
