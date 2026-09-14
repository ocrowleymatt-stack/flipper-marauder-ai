import type {
  Conversation,
  ExecutionRecord,
  Message,
  ProvenanceRecord,
} from '@atlas-vnext/contracts';
import type { IdFactory } from './ids.ts';
import { UuidIdFactory } from './ids.ts';
import type {
  ConversationRepository,
  ExecutionRepository,
  MessageRepository,
  ProvenanceWriter,
} from './ports.ts';

export interface MemoryHandle {
  conversations: ConversationRepository;
  messages: MessageRepository;
  executions: ExecutionRepository;
  provenance: ProvenanceWriter;
}

export function memoryStores(ids?: IdFactory, now?: () => string): MemoryHandle {
  const conversations = new Map<string, Conversation>();
  const messages = new Map<string, Message[]>();
  const executions = new Map<string, ExecutionRecord>();
  const provenance: ProvenanceRecord[] = [];
  const factory = ids ?? new UuidIdFactory();
  const clock = now ?? (() => new Date().toISOString());

  const conversationRepo: ConversationRepository = {
    async create(input) {
      const id = factory.id('conversation');
      const timestamp = clock();
      const conversation: Conversation = {
        id,
        urn: factory.urn('conversation', id),
        title: input.title,
        projectId: input.projectId,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      conversations.set(id, conversation);
      messages.set(id, []);
      return conversation;
    },
    async get(id) {
      return conversations.get(id) ?? null;
    },
    async list() {
      return [...conversations.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async save(conversation) {
      conversations.set(conversation.id, conversation);
      return conversation;
    },
  };

  const messageRepo: MessageRepository = {
    async append(input) {
      const existing = messages.get(input.conversationId) ?? [];
      const sequence = existing.length === 0 ? 0 : Math.max(...existing.map((item) => item.sequence)) + 1;
      const id = factory.id('message');
      const timestamp = clock();
      const message: Message = {
        id,
        urn: factory.urn('message', id),
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        sequence,
        executionId: input.executionId,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      existing.push(message);
      messages.set(input.conversationId, existing);
      return message;
    },
    async list(conversationId) {
      return [...(messages.get(conversationId) ?? [])].sort((a, b) => a.sequence - b.sequence);
    },
    async save(message) {
      const existing = messages.get(message.conversationId) ?? [];
      const index = existing.findIndex((item) => item.id === message.id);
      if (index === -1) existing.push(message);
      else existing[index] = message;
      existing.sort((a, b) => a.sequence - b.sequence);
      messages.set(message.conversationId, existing);
      return message;
    },
  };

  const executionRepo: ExecutionRepository = {
    async create(record) {
      executions.set(record.id, record);
      return record;
    },
    async get(id) {
      return executions.get(id) ?? null;
    },
    async listByConversation(conversationId) {
      return [...executions.values()]
        .filter((item) => item.conversationId === conversationId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async save(record) {
      executions.set(record.id, record);
      return record;
    },
    async listInFlight() {
      return [...executions.values()].filter((item) => item.status === 'queued' || item.status === 'running');
    },
  };

  const provenanceWriter: ProvenanceWriter = {
    async record(entry) {
      provenance.push(entry);
    },
    async forJob(jobId) {
      return provenance.filter((entry) => entry.jobId === jobId);
    },
  };

  return {
    conversations: conversationRepo,
    messages: messageRepo,
    executions: executionRepo,
    provenance: provenanceWriter,
  };
}
