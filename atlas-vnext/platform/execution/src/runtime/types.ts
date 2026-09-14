export const RUNTIME_STATES = [
  'stopped',
  'starting',
  'warming',
  'ready',
  'leased',
  'busy',
  'idle',
  'stopping',
  'failed',
] as const;
export type RuntimeState = (typeof RUNTIME_STATES)[number];

export const RUNTIME_PROFILES = [
  'llm',
  'reasoning_code',
  'embeddings',
  'image',
  'transcription',
  'dungeon',
] as const;
export type RuntimeProfileId = (typeof RUNTIME_PROFILES)[number];

export interface RuntimeProfile {
  id: RuntimeProfileId;
  label: string;
  compatibleWith: readonly RuntimeProfileId[];
  requiresImageChange: boolean;
}

export const RUNTIME_PROFILE_CATALOGUE: Record<RuntimeProfileId, RuntimeProfile> = {
  llm: {
    id: 'llm',
    label: 'LLM',
    compatibleWith: ['llm', 'reasoning_code'],
    requiresImageChange: false,
  },
  reasoning_code: {
    id: 'reasoning_code',
    label: 'Reasoning / code',
    compatibleWith: ['llm', 'reasoning_code'],
    requiresImageChange: false,
  },
  embeddings: {
    id: 'embeddings',
    label: 'Embeddings',
    compatibleWith: ['embeddings'],
    requiresImageChange: true,
  },
  image: {
    id: 'image',
    label: 'Image',
    compatibleWith: ['image'],
    requiresImageChange: true,
  },
  transcription: {
    id: 'transcription',
    label: 'Transcription',
    compatibleWith: ['transcription'],
    requiresImageChange: true,
  },
  dungeon: {
    id: 'dungeon',
    label: 'Future dungeons',
    compatibleWith: ['dungeon'],
    requiresImageChange: true,
  },
};

export interface RunPodLease {
  id: string;
  jobId: string;
  profile: RuntimeProfileId;
  acquiredAt: string;
  releasedAt: string | null;
}

export interface QueuedRuntimeJob {
  id: string;
  profile: RuntimeProfileId;
  enqueuedAt: string;
  status: 'waiting_runtime';
}

export interface RunPodRuntime {
  id: string;
  podId: string | null;
  state: RuntimeState;
  profile: RuntimeProfileId | null;
  lease: RunPodLease | null;
  queue: QueuedRuntimeJob[];
  idleSince: string | null;
  stopReason: string | null;
  lastError: string | null;
  startedAt: string | null;
  readyAt: string | null;
  stoppingAt: string | null;
  stoppedAt: string | null;
  durationMs: number | null;
  costUsd: number | null;
  startupFailure: string | null;
  healthFailure: string | null;
  updatedAt: string;
}

export interface RuntimeEvent {
  at: string;
  type: string;
  podId: string | null;
  state: RuntimeState;
  profile: RuntimeProfileId | null;
  jobId?: string;
  leaseId?: string;
  queuedJobs?: number;
  idleSince?: string | null;
  stopReason?: string | null;
  durationMs?: number | null;
  costUsd?: number | null;
  detail?: string;
}

export interface RuntimeSnapshot {
  runtime: RunPodRuntime;
  maxActivePods: number;
  idleShutdownSeconds: number;
  events: RuntimeEvent[];
}

export interface RuntimeClock {
  now(): number;
  iso(at?: number): string;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export class SystemRuntimeClock implements RuntimeClock {
  now(): number {
    return Date.now();
  }

  iso(at = this.now()): string {
    return new Date(at).toISOString();
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Execution aborted.'));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('Execution aborted.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

export interface RunPodPod {
  id: string;
  desiredStatus: string;
  lastStatus?: string;
  uptimeSeconds?: number;
  costPerHr?: number;
  image?: string;
}

export interface RunPodClient {
  getPod(id: string): Promise<RunPodPod | null>;
  listPods(): Promise<RunPodPod[]>;
  startPod(id: string): Promise<RunPodPod>;
  stopPod(id: string): Promise<RunPodPod>;
}

export interface RuntimeStateStore {
  load(): Promise<RunPodRuntime | null>;
  save(runtime: RunPodRuntime): Promise<void>;
}

export function emptyRuntime(nowIso: string, podId: string | null = null): RunPodRuntime {
  return {
    id: 'runpod-primary',
    podId,
    state: 'stopped',
    profile: null,
    lease: null,
    queue: [],
    idleSince: null,
    stopReason: null,
    lastError: null,
    startedAt: null,
    readyAt: null,
    stoppingAt: null,
    stoppedAt: null,
    durationMs: null,
    costUsd: null,
    startupFailure: null,
    healthFailure: null,
    updatedAt: nowIso,
  };
}

export function profileForModel(model: string): RuntimeProfileId {
  const lower = model.toLowerCase();
  if (/(embed)/.test(lower)) return 'embeddings';
  if (/(image|sdxl|flux|imagine)/.test(lower)) return 'image';
  if (/(whisper|transcri)/.test(lower)) return 'transcription';
  if (/(reason|code|coder)/.test(lower)) return 'reasoning_code';
  if (/(dungeon)/.test(lower)) return 'dungeon';
  return 'llm';
}

export function profilesCompatible(current: RuntimeProfileId | null, next: RuntimeProfileId): boolean {
  if (!current) return true;
  return RUNTIME_PROFILE_CATALOGUE[current].compatibleWith.includes(next);
}

export function podIsRunning(pod: RunPodPod | null | undefined): boolean {
  if (!pod) return false;
  const status = `${pod.desiredStatus} ${pod.lastStatus ?? ''}`.toUpperCase();
  return status.includes('RUNNING') || status.includes('EXITED') === false && status.includes('START');
}

export function podIsActive(pod: RunPodPod | null | undefined): boolean {
  if (!pod) return false;
  const status = `${pod.desiredStatus} ${pod.lastStatus ?? ''}`.toUpperCase();
  if (status.includes('STOPPED') || status.includes('EXITED') || status.includes('TERMINATED')) return false;
  return status.includes('RUNNING') || status.includes('START') || status.includes('WARM');
}
