import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { InspectedSource, SourceInspectPort } from '@atlas-vnext/contracts';
import { assertPublicHttpUrl, isPrivateAddress } from '@atlas-vnext/search';

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const ALLOWED_TYPES = /^(text\/|application\/(json|xml|javascript|xhtml)|application\/.*\+xml)/i;

export interface InspectDeps {
  fetchImpl?: typeof fetch;
  lookupImpl?: (hostname: string, options: { all: true; verbatim?: boolean }) => Promise<Array<{ address: string; family: number }>>;
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
    let current = assertPublicHttpUrl(input.url);
    await assertResolvedPublic(current, lookupImpl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    input.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const response = await fetchImpl(current, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'user-agent': 'Atlas-vNext/0.1 (+source inspect)', accept: 'text/html,application/xhtml+xml,text/plain,application/json' },
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) throw new Error('Redirect without Location.');
          current = assertPublicHttpUrl(new URL(location, current).toString());
          await assertResolvedPublic(current, lookupImpl);
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
): Promise<void> {
  if (isIP(url.hostname)) {
    if (isPrivateAddress(url.hostname)) throw new Error('Private or reserved network addresses are not permitted.');
    return;
  }
  let resolved;
  try {
    resolved = await lookupImpl(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('Hostname could not be resolved.');
  }
  if (!resolved.length || resolved.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('Host resolves to a private or reserved network address.');
  }
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
