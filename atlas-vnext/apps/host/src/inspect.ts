import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import type { InspectedSource, SourceInspectPort } from '@atlas-vnext/contracts';
import { assertPublicHttpUrl, isPrivateAddress, unwrapHostname } from '@atlas-vnext/search';

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const ALLOWED_TYPES = /^(text\/|application\/(json|xml|javascript|xhtml)|application\/.*\+xml)/i;

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type InspectTransport = (input: {
  url: string;
  init: RequestInit;
  addresses: ResolvedAddress[];
}) => Promise<Response>;

export interface InspectDeps {
  fetchImpl?: typeof fetch;
  lookupImpl?: (hostname: string, options: { all: true; verbatim?: boolean }) => Promise<Array<{ address: string; family: number }>>;
  transport?: InspectTransport;
  now?: () => string;
}

export class FixtureInspect implements SourceInspectPort {
  async inspect(input: { url: string }): Promise<InspectedSource> {
    const url = input.url;
    const text = `Independent source at ${url}. Established public facts are cited; remaining uncertainty is noted.`;
    return {
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      ok: true,
      contentType: 'text/html',
      text,
      contentHash: createHash('sha256').update(text).digest('hex'),
      fetchedAt: new Date().toISOString(),
      truncated: false,
    };
  }
}

export class NodeSourceInspect implements SourceInspectPort {
  constructor(private readonly deps: InspectDeps = {}) {}

  async inspect(input: { url: string; signal?: AbortSignal }): Promise<InspectedSource> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const lookupImpl = this.deps.lookupImpl ?? lookup;
    const pin = this.deps.transport != null || this.deps.fetchImpl === undefined || this.deps.fetchImpl === globalThis.fetch;
    let current = assertPublicHttpUrl(input.url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    input.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const addresses = await assertResolvedPublic(current, lookupImpl);
        const init: RequestInit = {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'user-agent': 'Atlas-vNext/0.1 (+source inspect)', accept: 'text/html,application/xhtml+xml,text/plain,application/json' },
        };
        const response = this.deps.transport
          ? await this.deps.transport({ url: current.toString(), init, addresses })
          : pin
            ? await pinnedHttpTransport({ url: current.toString(), init, addresses })
            : await fetchImpl(current, init);
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) throw new Error('Redirect without Location.');
          current = assertPublicHttpUrl(new URL(location, current).toString());
          continue;
        }
        const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
        if (response.ok && !ALLOWED_TYPES.test(contentType.split(';')[0] ?? '')) {
          throw new Error(`Unsupported content type ${contentType}.`);
        }
        const { text, truncated } = await readBoundedText(response);
        const fetchedAt = this.deps.now?.() ?? new Date().toISOString();
        return {
          requestedUrl: input.url,
          finalUrl: current.toString(),
          status: response.status,
          ok: response.ok,
          contentType,
          text,
          contentHash: createHash('sha256').update(text).digest('hex'),
          fetchedAt,
          truncated,
        };
      }
      throw new Error('Too many redirects.');
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
    }
  }
}

async function assertResolvedPublic(
  url: URL,
  lookupImpl: (hostname: string, options: { all: true; verbatim?: boolean }) => Promise<Array<{ address: string; family: number }>>,
): Promise<ResolvedAddress[]> {
  const hostname = unwrapHostname(url.hostname);
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('Private or reserved network addresses are not permitted.');
    const family = isIP(hostname) === 6 ? 6 : 4;
    return [{ address: hostname, family }];
  }
  let resolved;
  try {
    resolved = await lookupImpl(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('Hostname could not be resolved.');
  }
  if (!resolved.length || resolved.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('Host resolves to a private or reserved network address.');
  }
  return resolved.map((row) => ({
    address: row.address,
    family: row.family === 6 ? 6 : 4,
  }));
}

export function pinnedLookup(addresses: ResolvedAddress[]): NonNullable<https.RequestOptions['lookup']> {
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
    (cb as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(null, first.address, first.family);
  }) as NonNullable<https.RequestOptions['lookup']>;
}

async function pinnedHttpTransport(input: {
  url: string;
  init: RequestInit;
  addresses: ResolvedAddress[];
}): Promise<Response> {
  const parsed = new URL(input.url);
  const lib = parsed.protocol === 'https:' ? https : http;
  const method = String(input.init.method ?? 'GET').toUpperCase();
  const headers = new Headers(input.init.headers);
  if (!headers.has('host')) headers.set('host', parsed.host);
  const headerRecord: http.OutgoingHttpHeaders = {};
  headers.forEach((value, key) => {
    headerRecord[key] = value;
  });
  const signal = input.init.signal ?? undefined;
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: unwrapHostname(parsed.hostname),
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: headerRecord,
        servername: parsed.protocol === 'https:' && !isIP(unwrapHostname(parsed.hostname)) ? parsed.hostname : undefined,
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
    req.end();
  });
}

async function readBoundedText(response: Response): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        truncated = true;
        await reader.cancel();
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return { text, truncated };
}
