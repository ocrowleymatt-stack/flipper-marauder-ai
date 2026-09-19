import type {
  Conversation,
  ConversationHistoryTurn,
  ConversationSnapshot,
  ExecutionAttempt,
  ExecutionRecord,
  Message,
  ProvenanceRecord,
  RouteDecision,
  StreamChunk,
} from '@atlas-vnext/contracts';

export interface UnitOfWork {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export interface ConversationRepository {
  /** `projectId` is a workspace-id alias until first-class Project objects exist. */
  create(input: { title: string; projectId: string | null; idempotencyKey?: string }): Promise<Conversation>;
  get(id: string): Promise<Conversation | null>;
  list(): Promise<Conversation[]>;
  save(conversation: Conversation): Promise<Conversation>;
}

export interface MessageRepository {
  append(input: {
    conversationId: string;
    role: Message['role'];
    content: string;
    executionId: string | null;
    idempotencyKey?: string;
  }): Promise<Message>;
  list(conversationId: string): Promise<Message[]>;
  save(message: Message): Promise<Message>;
}

export interface ExecutionRepository {
  /** Chat-turn records. Resumable long-running work uses `jobs`, not executions. */
  create(record: ExecutionRecord): Promise<ExecutionRecord>;
  get(id: string): Promise<ExecutionRecord | null>;
  listByConversation(conversationId: string): Promise<ExecutionRecord[]>;
  save(record: ExecutionRecord): Promise<ExecutionRecord>;
  listInFlight(): Promise<ExecutionRecord[]>;
}

export interface ProvenanceWriter {
  record(entry: ProvenanceRecord): Promise<void>;
  forJob(jobId: string): Promise<ProvenanceRecord[]>;
  forArtefact(artefactId: string): Promise<ProvenanceRecord[]>;
}

export interface CapabilityRouter {
  resolve(
    target: string,
    request?: {
      contextTokens?: number;
      privacy?: 'any' | 'local_only';
      availableRuntimes?: string[];
      traceId?: string;
      requireTools?: boolean;
      requireVision?: boolean;
      requireReasoning?: boolean;
      requireCode?: boolean;
    },
  ): RouteDecision;
}

export interface ModelExecutor {
  execute(
    decision: RouteDecision,
    context: {
      prompt: string;
      systemPrompt?: string;
      history?: ConversationHistoryTurn[];
      signal?: AbortSignal;
      traceId?: string;
      priorToolResults?: Array<{
        callId: string;
        toolId: string;
        arguments?: Record<string, unknown>;
        status: string;
        resultRef?: string | null;
        output?: unknown;
        round?: number;
      }>;
      tools?: Array<{
        id: string;
        description: string;
        inputSchema: Record<string, unknown>;
      }>;
      attemptIndexBase?: number;
      visibleOutputAlready?: boolean;
    },
    observer?: {
      onAttempt(attempt: Pick<ExecutionAttempt, 'index' | 'provider' | 'model' | 'outcome' | 'error' | 'emittedVisibleOutput'>): void;
      onSelected?(selection: { provider: string; model: string }): void;
    },
  ): AsyncIterable<StreamChunk>;
}

export interface ToolOrchestrator {
  listCallable?(input: {
    tenantId: string;
    principalId: string;
    workspaceId?: string | null;
  }): Promise<
    Array<{
      id: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }>
  >;
  handleCall(input: {
    tenantId: string;
    principalId: string;
    workspaceId?: string | null;
    conversationId: string;
    executionId: string;
    provider?: string | null;
    model?: string | null;
    call: import('@atlas-vnext/contracts').ToolCallRequest;
    signal?: AbortSignal;
  }): Promise<{
    invocationId: string;
    toolId: string;
    status: string;
    reason?: string;
    resultRef?: string | null;
    output?: unknown;
  }>;
}

export interface ConversationClock {
  now(): string;
}

export interface ConversationStores {
  conversations: ConversationRepository;
  messages: MessageRepository;
  executions: ExecutionRepository;
}

export type { ConversationSnapshot };
