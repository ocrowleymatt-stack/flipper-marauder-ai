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
  'research',
  'dungeon',
] as const;
export type RuntimeProfileId = (typeof RUNTIME_PROFILES)[number];

export const LEASE_STATES = ['acquired', 'released', 'expired'] as const;
export type LeaseState = (typeof LEASE_STATES)[number];

export const RUNTIME_ACTIVITIES = ['none', 'model_download', 'checkpoint'] as const;
export type RuntimeActivity = (typeof RUNTIME_ACTIVITIES)[number];

export const WAITING_REASONS = ['pod_starting', 'pod_warming', 'pod_busy', 'profile_change'] as const;
export type WaitingReason = (typeof WAITING_REASONS)[number];

export interface RuntimeGpuRequirements {
  minVramGb: number;
  kind: 'any' | 'nvidia';
}

export interface RuntimeProfile {
  id: RuntimeProfileId;
  label: string;
  capabilities: readonly string[];
  image: string | null;
  runtime: string;
  modelRequirements: readonly string[];
  gpuRequirements: RuntimeGpuRequirements;
  startupBehaviour: 'on_demand';
  shutdownBehaviour: 'idle_timeout';
  compatibleWith: readonly RuntimeProfileId[];
  requiresImageChange: boolean;
  /**
   * Share the GPU with another lease only when the runtime is proven to
   * support it. Default is exclusive; do not assume concurrency.
   */
  allowsSharedConcurrency: boolean;
}

const SHARED_GPU: RuntimeGpuRequirements = { minVramGb: 16, kind: 'nvidia' };

export const RUNTIME_PROFILE_CATALOGUE: Record<RuntimeProfileId, RuntimeProfile> = {
  llm: {
    id: 'llm',
    label: 'LLM',
    capabilities: ['text', 'tools', 'chat'],
    image: null,
    runtime: 'openai-compatible',
    modelRequirements: ['llm'],
    gpuRequirements: SHARED_GPU,
    startupBehaviour: 'on_demand',
    shutdownBehaviour: 'idle_timeout',
    compatibleWith: ['llm', 'reasoning_code'],
    requiresImageChange: false,
    allowsSharedConcurrency: false,
  },
  reasoning_code: {
    id: 'reasoning_code',
    label: 'Reasoning / code',
    capabilities: ['text', 'tools', 'code', 'reasoning'],
    image: null,
    runtime: 'openai-compatible',
    modelRequirements: ['llm', 'code'],
    gpuRequirements: SHARED_GPU,
    startupBehaviour: 'on_demand',
    shutdownBehaviour: 'idle_timeout',
    compatibleWith: ['llm', 'reasoning_code'],
    requiresImageChange: false,
    allowsSharedConcurrency: false,
  },
  embeddings: {
    id: 'embeddings',
    label: 'Embeddings',
    capabilities: ['embeddings'],
    image: null,
    runtime: 'openai-compatible',
    modelRequirements: ['embedding'],
    gpuRequirements: SHARED_GPU,
    startupBehaviour: 'on_demand',
    shutdownBehaviour: 'idle_timeout',
    compatibleWith: ['embeddings'],
    requiresImageChange: true,
    allowsSharedConcurrency: false,
  },
  image: {
    id: 'image',
    label: 'Image',
    capabilities: ['image'],
    image: null,
    runtime: 'image-worker',
    modelRequirements: ['diffusion'],
    gpuRequirements: SHARED_GPU,
    startupBehaviour: 'on_demand',
    shutdownBehaviour: 'idle_timeout',
    compatibleWith: ['image'],
    requiresImageChange: true,
    allowsSharedConcurrency: false,
  },
  transcription: {
    id: 'transcription',
    label: 'Transcription',
    capabilities: ['audio', 'transcription'],
    image: null,
    runtime: 'whisper',
    modelRequirements: ['whisper'],
    gpuRequirements: SHARED_GPU,
    startupBehaviour: 'on_demand',
    shutdownBehaviour: 'idle_timeout',
    compatibleWith: ['transcription'],
    requiresImageChange: true,
    allowsSharedConcurrency: false,
  },
  research: {
    id: 'research',
    label: 'Research',
    capabilities: ['text', 'retrieval'],
    image: null,
    runtime: 'openai-compatible',
    modelRequirements: ['llm'],
    gpuRequirements: SHARED_GPU,
    startupBehaviour: 'on_demand',
    shutdownBehaviour: 'idle_timeout',
    compatibleWith: ['research', 'llm'],
    requiresImageChange: false,
    allowsSharedConcurrency: false,
  },
  dungeon: {
    id: 'dungeon',
    label: 'Future dungeons',
    capabilities: ['dungeon'],
    image: null,
    runtime: 'openai-compatible',
    modelRequirements: [],
    gpuRequirements: SHARED_GPU,
    startupBehaviour: 'on_demand',
    shutdownBehaviour: 'idle_timeout',
    compatibleWith: ['dungeon'],
    requiresImageChange: true,
    allowsSharedConcurrency: false,
  },
};

export interface RunPodLease {
  id: string;
  jobId: string;
  workloadType: string;
  profile: RuntimeProfileId;
  requestedModel: string | null;
  acquiredAt: string;
  expiresAt: string;
  heartbeatAt: string;
  state: LeaseState;
  traceId: string;
  exclusive: boolean;
  releasedAt: string | null;
}

export interface QueuedRuntimeJob {
  id: string;
  profile: RuntimeProfileId;
  workloadType: string;
  requestedModel: string | null;
  traceId: string | null;
  enqueuedAt: string;
  status: 'waiting_runtime';
  waitingReason: WaitingReason;
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
  costPerHr: number | null;
  startupFailure: string | null;
  healthFailure: string | null;
  activity: RuntimeActivity;
  keepWarmUntil: string | null;
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
  workloadType?: string;
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
  scaleOutDisabled: true;
  keepWarmUntil: string | null;
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
  /** Must refuse. Atlas never POST-creates extra paid pods. */
  createPod(spec?: unknown): Promise<RunPodPod>;
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
    costPerHr: null,
    startupFailure: null,
    healthFailure: null,
    activity: 'none',
    keepWarmUntil: null,
    updatedAt: nowIso,
  };
}

export function profileForModel(model: string): RuntimeProfileId {
  const lower = model.toLowerCase();
  if (/(embed)/.test(lower)) return 'embeddings';
  if (/(image|sdxl|flux|imagine)/.test(lower)) return 'image';
  if (/(whisper|transcri)/.test(lower)) return 'transcription';
  if (/(reason|code|coder)/.test(lower)) return 'reasoning_code';
  if (/(research)/.test(lower)) return 'research';
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
  if (status.includes('STOPPED') || status.includes('EXITED') || status.includes('TERMINATED')) return false;
  return status.includes('RUNNING');
}

export function podIsActive(pod: RunPodPod | null | undefined): boolean {
  if (!pod) return false;
  const status = `${pod.desiredStatus} ${pod.lastStatus ?? ''}`.toUpperCase();
  if (status.includes('STOPPED') || status.includes('EXITED') || status.includes('TERMINATED')) return false;
  return status.includes('RUNNING') || status.includes('START') || status.includes('WARM');
}

export function normalizeQueuedJob(raw: Partial<QueuedRuntimeJob> & { id: string }): QueuedRuntimeJob {
  return {
    id: raw.id,
    profile: raw.profile ?? 'llm',
    workloadType: raw.workloadType ?? 'inference',
    requestedModel: raw.requestedModel ?? null,
    traceId: raw.traceId ?? null,
    enqueuedAt: raw.enqueuedAt ?? new Date(0).toISOString(),
    status: 'waiting_runtime',
    waitingReason: raw.waitingReason ?? 'pod_busy',
  };
}

export function normalizeLease(raw: Partial<RunPodLease> & { id: string; jobId: string }): RunPodLease {
  const acquiredAt = raw.acquiredAt ?? new Date(0).toISOString();
  return {
    id: raw.id,
    jobId: raw.jobId,
    workloadType: raw.workloadType ?? 'inference',
    profile: raw.profile ?? 'llm',
    requestedModel: raw.requestedModel ?? null,
    acquiredAt,
    expiresAt: raw.expiresAt ?? acquiredAt,
    heartbeatAt: raw.heartbeatAt ?? acquiredAt,
    state: raw.state ?? (raw.releasedAt ? 'released' : 'acquired'),
    traceId: raw.traceId ?? raw.jobId,
    exclusive: raw.exclusive !== false,
    releasedAt: raw.releasedAt ?? null,
  };
}

export function normalizeRuntime(raw: Partial<RunPodRuntime>, fallbackPodId: string | null, nowIso: string): RunPodRuntime {
  const base = emptyRuntime(nowIso, raw.podId ?? fallbackPodId);
  return {
    ...base,
    ...raw,
    podId: raw.podId ?? fallbackPodId,
    queue: (raw.queue ?? []).map((item) => normalizeQueuedJob(item)),
    lease: raw.lease ? normalizeLease(raw.lease) : null,
    activity: raw.activity ?? 'none',
    keepWarmUntil: raw.keepWarmUntil ?? null,
    costPerHr: raw.costPerHr ?? null,
  };
}

export const SCALE_OUT_DISABLED_REASON = 'Scale-out disabled. RUNPOD_MAX_ACTIVE_PODS is clamped to 1.';
export const CREATE_POD_REFUSED_REASON = 'Refusing to create a RunPod; Atlas uses one existing shared pod.';
