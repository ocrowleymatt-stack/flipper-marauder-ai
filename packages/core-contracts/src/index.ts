// ============================================================================
// 1. Identity, Auth & Capability-Based Access Control
// ============================================================================

export type ResourceClassification = 'public' | 'internal' | 'confidential' | 'restricted';
export type EnvironmentTier = 'development' | 'staging' | 'production';

export interface UserIdentity {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly groups: readonly string[];
  readonly roles: readonly string[];
}

export interface ApiTokenClaims {
  readonly tokenId: string;
  readonly prefix: string;
  readonly name: string;
  readonly userId: string;
  readonly capabilities: readonly string[];
  readonly expiresAt?: string;
}

export interface SecurityContext {
  readonly user?: UserIdentity;
  readonly token?: ApiTokenClaims;
  readonly environment: EnvironmentTier;
  readonly clientIp?: string;
  readonly correlationId: string;
}

export type PolicyEffect = 'allow' | 'deny';

export interface PolicyEvaluationRequest {
  readonly actorId: string;
  readonly roles: readonly string[];
  readonly capability: string;
  readonly action: string;
  readonly environment: EnvironmentTier;
  readonly resourceClassification?: ResourceClassification;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly matchedRuleIds: readonly string[];
  readonly decisiveRuleId?: string;
  readonly reason: string;
}

// ============================================================================
// 2. Cryptographic Provenance & Tamper-Evident Ledger
// ============================================================================

export type AuditAction =
  | 'auth.login'
  | 'auth.logout'
  | 'auth.token_created'
  | 'auth.token_revoked'
  | 'policy.evaluated'
  | 'job.created'
  | 'job.started'
  | 'job.stage_transition'
  | 'job.completed'
  | 'job.failed'
  | 'job.cancelled'
  | 'project.created'
  | 'project.version_committed'
  | 'storage.blob_written'
  | 'dungeon.executed';

export interface AuditEntryInput {
  readonly actorId: string;
  readonly action: AuditAction;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly occurredAt: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AuditEntry extends AuditEntryInput {
  readonly sequence: number;
  readonly previousHash: string;
  readonly hash: string;
}

export interface LedgerVerificationResult {
  readonly valid: boolean;
  readonly brokenAt?: number;
  readonly totalEntries: number;
}

export interface JobProvenance {
  readonly jobId: string;
  readonly correlationId: string;
  readonly actorId: string;
  readonly inputDigest: string;
  readonly outputDigest?: string;
  readonly modelsInvoked: readonly string[];
  readonly toolsInvoked: readonly string[];
  readonly executionDurationMs: number;
  readonly completedAt: string;
}

// ============================================================================
// 3. Content-Addressed Storage (CAS)
// ============================================================================

export interface StorageDescriptor {
  readonly hash: string; // SHA-256
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly createdAt: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface IContentAddressedStorage {
  put(data: Buffer | Uint8Array | string, mimeType?: string, metadata?: Record<string, unknown>): Promise<StorageDescriptor>;
  get(hash: string): Promise<Buffer | null>;
  has(hash: string): Promise<boolean>;
  verifyIntegrity(hash: string): Promise<boolean>;
}

// ============================================================================
// 4. Durable Projects & State Transitions
// ============================================================================

export interface ProjectRecord {
  readonly id: string;
  readonly userId: string;
  readonly projectKey: string;
  readonly title: string;
  readonly mode: string;
  readonly currentRevision: number;
  readonly stateChecksum: string;
  readonly stateBlobHash: string; // CAS reference
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectRevision {
  readonly projectId: string;
  readonly revision: number;
  readonly parentRevision: number | null;
  readonly actorId: string;
  readonly checksum: string;
  readonly blobHash: string;
  readonly commitMessage?: string;
  readonly createdAt: string;
}

// ============================================================================
// 5. Durable Jobs & Event-Driven Progress
// ============================================================================

export type JobStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'partial'
  | 'needs_review';

export interface JobStage {
  readonly id: string;
  readonly label: string;
  readonly status: JobStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly progressPercent: number;
  readonly detail?: string;
}

export interface DurableJob {
  readonly id: string;
  readonly userId: string;
  readonly projectId?: string;
  readonly type: string;
  readonly status: JobStatus;
  readonly currentStage?: string;
  readonly stages: readonly JobStage[];
  readonly inputHash: string; // CAS reference to input payload
  readonly resultHash?: string; // CAS reference to result payload
  readonly error?: string;
  readonly retryCount: number;
  readonly leaseOwner?: string;
  readonly leaseUntil?: string;
  readonly idempotencyKey?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface JobProgressEvent {
  readonly jobId: string;
  readonly stageId: string;
  readonly progressPercent: number;
  readonly status: JobStatus;
  readonly message?: string;
  readonly timestamp: string;
}

export interface IProgressBroadcaster {
  subscribe(channel: string, listener: (event: JobProgressEvent) => void): () => void;
  publish(event: JobProgressEvent): void;
}

// ============================================================================
// 6. Nexus Router Contracts
// ============================================================================

export type AiProviderType = 'host' | 'ollama' | 'gemini' | 'grok' | 'openai' | 'claude' | 'venice';

export interface RoutePromptOptions {
  readonly requestedModel?: string;
  readonly primaryProvider?: AiProviderType;
  readonly fallbackAllowed?: boolean;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly jsonMode?: boolean;
  readonly timeoutMs?: number;
}

export interface ProviderCallResult {
  readonly text: string;
  readonly provider: AiProviderType;
  readonly model: string;
  readonly latencyMs: number;
  readonly tokenUsage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
  };
}

export interface INexusRouter {
  routePrompt(prompt: string, options?: RoutePromptOptions): Promise<ProviderCallResult>;
  getProviderHealth(): Promise<Readonly<Record<AiProviderType, { available: boolean; latencyMs?: number }>>>;
}

// ============================================================================
// 7. Execution Broker Contracts
// ============================================================================

export interface JobExecutionTask {
  readonly jobId: string;
  readonly type: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly context: SecurityContext;
}

export interface IExecutionBroker {
  submitJob(task: JobExecutionTask): Promise<DurableJob>;
  getJob(jobId: string): Promise<DurableJob | null>;
  cancelJob(jobId: string, actorId: string): Promise<boolean>;
  claimLease(workerId: string, maxBatchSize?: number): Promise<readonly DurableJob[]>;
  renewLease(jobId: string, workerId: string, leaseDurationMs: number): Promise<boolean>;
  releaseLease(jobId: string, workerId: string): Promise<void>;
}

// ============================================================================
// 8. Plugin-Style Dungeons
// ============================================================================

export interface DungeonManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly capabilitiesProvided: readonly string[];
  readonly requiredPermissions: readonly string[];
}

export interface DungeonExecutionContext {
  readonly jobId: string;
  readonly securityContext: SecurityContext;
  readonly storage: IContentAddressedStorage;
  readonly router: INexusRouter;
  readonly reportProgress: (percent: number, message?: string) => Promise<void>;
}

export interface IDungeonPlugin {
  readonly manifest: DungeonManifest;
  execute(taskType: string, payload: Readonly<Record<string, unknown>>, context: DungeonExecutionContext): Promise<Record<string, unknown>>;
  healthCheck(): Promise<{ ok: boolean; message?: string }>;
}
