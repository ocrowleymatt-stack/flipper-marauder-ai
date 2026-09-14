import { randomUUID } from 'node:crypto';
import { ProviderHttpError, httpFailure } from '../errors.ts';
import { readAllText, type HttpTransport } from '../transport.ts';
import type { SecretStore } from '../secrets.ts';
import { CREATE_POD_REFUSED_REASON, type RunPodClient, type RunPodPod } from './types.ts';

export class HttpRunPodClient implements RunPodClient {
  constructor(
    private readonly options: {
      transport: HttpTransport;
      secrets: SecretStore;
      baseUrl: string;
      timeoutMs: number;
      secretName?: string;
    },
  ) {}

  async getPod(id: string): Promise<RunPodPod | null> {
    const response = await this.request('GET', `/pods/${encodeURIComponent(id)}`);
    if (response.status === 404) return null;
    if (response.status >= 400) {
      throw new ProviderHttpError(httpFailure('runpod', response.status, response.body));
    }
    return parsePod(JSON.parse(response.body));
  }

  async listPods(): Promise<RunPodPod[]> {
    const response = await this.request('GET', '/pods');
    if (response.status >= 400) {
      throw new ProviderHttpError(httpFailure('runpod', response.status, response.body));
    }
    const parsed = JSON.parse(response.body) as { pods?: unknown[]; data?: unknown[] } | unknown[];
    const rows = Array.isArray(parsed) ? parsed : (parsed.pods ?? parsed.data ?? []);
    return rows.map((row) => parsePod(row));
  }

  async startPod(id: string): Promise<RunPodPod> {
    const response = await this.request('POST', `/pods/${encodeURIComponent(id)}/start`);
    if (response.status >= 400) {
      throw new ProviderHttpError(httpFailure('runpod', response.status, response.body));
    }
    if (!response.body.trim()) return { id, desiredStatus: 'RUNNING' };
    return parsePod(JSON.parse(response.body));
  }

  async stopPod(id: string): Promise<RunPodPod> {
    const response = await this.request('POST', `/pods/${encodeURIComponent(id)}/stop`);
    if (response.status >= 400) {
      throw new ProviderHttpError(httpFailure('runpod', response.status, response.body));
    }
    if (!response.body.trim()) return { id, desiredStatus: 'EXITED' };
    return parsePod(JSON.parse(response.body));
  }

  async createPod(_spec?: unknown): Promise<RunPodPod> {
    throw new Error(CREATE_POD_REFUSED_REASON);
  }

  private async request(method: 'GET' | 'POST', path: string): Promise<{ status: number; body: string }> {
    const apiKey = this.options.secrets.get(this.options.secretName ?? 'RUNPOD_API_KEY');
    if (!apiKey) throw new Error('runpod is unavailable: missing credentials.');
    const response = await this.options.transport.send({
      url: `${this.options.baseUrl}${path}`,
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      timeoutMs: this.options.timeoutMs,
    });
    return { status: response.status, body: await readAllText(response.stream) };
  }
}

function parsePod(raw: unknown): RunPodPod {
  const row = (raw ?? {}) as Record<string, unknown>;
  const runtime = (row.runtime ?? {}) as Record<string, unknown>;
  return {
    id: String(row.id ?? row.podId ?? randomUUID()),
    desiredStatus: String(row.desiredStatus ?? row.desired_status ?? row.status ?? 'UNKNOWN'),
    lastStatus: row.lastStatusChange ? String(row.lastStatusChange) : undefined,
    uptimeSeconds: typeof runtime.uptimeInSeconds === 'number' ? runtime.uptimeInSeconds : undefined,
    costPerHr: typeof row.costPerHr === 'number' ? row.costPerHr : typeof row.costPerHr === 'string' ? Number(row.costPerHr) : undefined,
    image: typeof row.imageName === 'string' ? row.imageName : typeof row.image === 'string' ? row.image : undefined,
  };
}

export class MemoryRunPodClient implements RunPodClient {
  readonly pods = new Map<string, RunPodPod>();
  startCalls: string[] = [];
  stopCalls: string[] = [];
  createCalls = 0;
  /** When false, startPod leaves the pod STARTING until `promote()`. */
  promoteOnStart = true;

  seed(pod: RunPodPod): void {
    this.pods.set(pod.id, { ...pod });
  }

  promote(id: string): void {
    const existing = this.pods.get(id);
    if (!existing) return;
    this.pods.set(id, { ...existing, desiredStatus: 'RUNNING' });
  }

  async getPod(id: string): Promise<RunPodPod | null> {
    const pod = this.pods.get(id);
    return pod ? { ...pod } : null;
  }

  async listPods(): Promise<RunPodPod[]> {
    return [...this.pods.values()].map((pod) => ({ ...pod }));
  }

  async startPod(id: string): Promise<RunPodPod> {
    this.startCalls.push(id);
    const existing = this.pods.get(id);
    if (!existing) throw new Error(`Unknown RunPod ${id}`);
    const next = { ...existing, desiredStatus: this.promoteOnStart ? 'RUNNING' : 'STARTING' };
    this.pods.set(id, next);
    return { ...next };
  }

  async stopPod(id: string): Promise<RunPodPod> {
    this.stopCalls.push(id);
    const existing = this.pods.get(id);
    if (!existing) throw new Error(`Unknown RunPod ${id}`);
    const next = { ...existing, desiredStatus: 'EXITED' };
    this.pods.set(id, next);
    return { ...next };
  }

  async createPod(_spec?: unknown): Promise<RunPodPod> {
    this.createCalls += 1;
    throw new Error(CREATE_POD_REFUSED_REASON);
  }
}
