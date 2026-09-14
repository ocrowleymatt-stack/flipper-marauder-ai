import type {
  Conversation,
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
  }): Promise<Message>;
  list(conversationId: string): Promise<Message[]>;
  save(message: Message): Promise<Message>;
}

export interface ExecutionRepository {
  create(record: ExecutionRecord): Promise<ExecutionRecord>;
  get(id: string): Promise<ExecutionRecord | null>;
  listByConversation(conversationId: string): Promise<ExecutionRecord[]>;
  save(record: ExecutionRecord): Promise<ExecutionRecord>;
  listInFlight(): Promise<ExecutionRecord[]>;
}

export interface ProvenanceWriter {
  record(entry: ProvenanceRecord): Promise<void>;
  forJob(jobId: string): Promise<ProvenanceRecord[]>;
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
      signal?: AbortSignal;
      traceId?: string;
    },
    observer?: {
      onAttempt(attempt: Pick<ExecutionAttempt, 'index' | 'provider' | 'model' | 'outcome' | 'error' | 'emittedVisibleOutput'>): void;
      onSelected?(selection: { provider: string; model: string }): void;
    },
  ): AsyncGenerator<StreamChunk>;
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
