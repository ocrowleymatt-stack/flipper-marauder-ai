import { sanitizeText } from './sanitize.ts';

export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  stream: AsyncIterable<Uint8Array>;
}

export interface HttpTransport {
  send(request: HttpRequest): Promise<HttpResponse>;
}

export class FetchTransport implements HttpTransport {
  constructor(private readonly defaultTimeoutMs = 60_000) {}

  async send(request: HttpRequest): Promise<HttpResponse> {
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms.`)), timeoutMs);
    const onOuterAbort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener('abort', onOuterAbort, { once: true });
    if (request.signal?.aborted) {
      controller.abort(request.signal.reason);
    }
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      const body = response.body;
      return {
        status: response.status,
        headers,
        stream: body ? iterableFromReadable(body) : emptyStream(),
      };
    } catch (err) {
      const message = sanitizeText(err instanceof Error ? err.message : String(err));
      throw new Error(message);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}

export class ScriptedTransport implements HttpTransport {
  constructor(private readonly handler: (request: HttpRequest) => HttpResponse | Promise<HttpResponse>) {}

  async send(request: HttpRequest): Promise<HttpResponse> {
    return this.handler(request);
  }
}

export function bytesFromString(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function responseFromText(
  status: number,
  text: string,
  headers: Record<string, string> = { 'content-type': 'application/json' },
): HttpResponse {
  return {
    status,
    headers,
    stream: (async function* () {
      yield bytesFromString(text);
    })(),
  };
}

export async function readAllText(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of stream) {
    out += decoder.decode(chunk, { stream: true });
  }
  out += decoder.decode();
  return out;
}

export async function* iterableFromReadable(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function* emptyStream(): AsyncGenerator<Uint8Array> {
  // no bytes
}
