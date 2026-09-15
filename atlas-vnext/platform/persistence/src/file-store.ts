import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Conversation,
  ExecutionRecord,
  Message,
  ProvenanceRecord,
} from '@atlas-vnext/contracts';
import type {
  ConversationRepository,
  ExecutionRepository,
  IdFactory,
  MessageRepository,
  ProvenanceWriter,
} from '@atlas-vnext/conversation';
import { UuidIdFactory } from '@atlas-vnext/conversation';
import type { DomainEvent, EventBus, EventPublishInput, EventReplayCursor } from '@atlas-vnext/events';

export const PERSISTENCE_SCHEMA_VERSION = 1;

export interface DurableDocument {
  version: number;
  conversations: Conversation[];
  messages: Message[];
  executions: ExecutionRecord[];
  events: DomainEvent[];
  provenance: ProvenanceRecord[];
}

function emptyDocument(): DurableDocument {
  return {
    version: PERSISTENCE_SCHEMA_VERSION,
    conversations: [],
    messages: [],
    executions: [],
    events: [],
    provenance: [],
  };
}

/**
 * Atomic JSON document store. Same logical schema as the PostgreSQL metadata
 * target. A later SQLite/PG adapter can implement the same repositories.
 */
export class FileDocument {
  private document: DurableDocument;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    this.document = this.load();
  }

  snapshot(): DurableDocument {
    return structuredClone(this.document);
  }

  getDocument(): DurableDocument {
    return this.document;
  }

  async mutate(mutator: (document: DurableDocument) => void): Promise<void> {
    mutator(this.document);
    await this.flush();
  }

  private load(): DurableDocument {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as DurableDocument;
      if (parsed.version !== PERSISTENCE_SCHEMA_VERSION) {
        throw new Error(`Unsupported persistence schema version ${String(parsed.version)}`);
      }
      return {
        version: PERSISTENCE_SCHEMA_VERSION,
        conversations: parsed.conversations ?? [],
        messages: parsed.messages ?? [],
        executions: parsed.executions ?? [],
        events: parsed.events ?? [],
        provenance: parsed.provenance ?? [],
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || err instanceof SyntaxError) return emptyDocument();
      throw err;
    }
  }

  private async flush(): Promise<void> {
    this.writeQueue = this.writeQueue.then(() => {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.document, null, 2)}\n`, 'utf8');
      renameSync(tmp, this.filePath);
    });
    await this.writeQueue;
  }
}

export class DurableEventBus implements EventBus {
  private readonly listeners = new Map<string, Set<(event: DomainEvent) => void>>();

  constructor(
    private readonly document: FileDocument,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async publish(event: EventPublishInput): Promise<DomainEvent> {
    if (event.idempotencyKey) {
      const existing = this.document
        .getDocument()
        .events.find(
          (item) => item.idempotencyKey === event.idempotencyKey && (item.tenantId ?? null) === (event.tenantId ?? null),
        );
      if (existing) return existing;
    }
    const channelEvents = this.document.getDocument().events.filter((item) => item.channel === event.channel);
    const seq = channelEvents.reduce((max, item) => Math.max(max, item.seq ?? 0), 0) + 1;
    const recorded: DomainEvent = {
      eventId: event.eventId ?? `evt_${randomUUID()}`,
      timestamp: this.now(),
      channel: event.channel,
      type: event.type,
      payload: event.payload,
      seq,
      tenantId: event.tenantId,
      workspaceId: event.workspaceId ?? null,
      conversationId: event.conversationId ?? null,
      jobId: event.jobId ?? null,
      idempotencyKey: event.idempotencyKey ?? null,
    };
    await this.document.mutate((doc) => {
      doc.events.push(recorded);
    });
    for (const listener of this.listeners.get(recorded.channel) ?? []) listener(recorded);
    for (const listener of this.listeners.get('*') ?? []) listener(recorded);
    return recorded;
  }

  subscribe(channel: string, listener: (event: DomainEvent) => void): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener);
    return () => set?.delete(listener);
  }

  async history(channel: string): Promise<DomainEvent[]> {
    return this.replay(channel);
  }

  async replay(channel: string, after?: EventReplayCursor): Promise<DomainEvent[]> {
    const events = this.document.getDocument().events;
    let records = channel === '*' ? [...events] : events.filter((event) => event.channel === channel);
    let afterSeq = after?.seq;
    if (after?.eventId && afterSeq === undefined) {
      afterSeq = events.find((event) => event.eventId === after.eventId)?.seq;
    }
    if (typeof afterSeq === 'number') records = records.filter((event) => (event.seq ?? 0) > afterSeq);
    return records.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }
}

export class DurableConversationStore {
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
  readonly executions: ExecutionRepository;
  readonly provenance: ProvenanceWriter;
  readonly events: DurableEventBus;

  constructor(
    private readonly document: FileDocument,
    ids: IdFactory = new UuidIdFactory(),
    now: () => string = () => new Date().toISOString(),
  ) {
    this.events = new DurableEventBus(document, now);

    this.conversations = {
      create: async (input) => {
        const id = ids.id('conversation');
        const timestamp = now();
        const conversation: Conversation = {
          id,
          urn: ids.urn('conversation', id),
          title: input.title,
          projectId: input.projectId,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        await document.mutate((doc) => {
          doc.conversations.push(conversation);
        });
        return conversation;
      },
      get: async (id) => document.getDocument().conversations.find((item) => item.id === id) ?? null,
      list: async () =>
        [...document.getDocument().conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      save: async (conversation) => {
        await document.mutate((doc) => {
          const index = doc.conversations.findIndex((item) => item.id === conversation.id);
          if (index === -1) doc.conversations.push(conversation);
          else doc.conversations[index] = conversation;
        });
        return conversation;
      },
    };

    this.messages = {
      append: async (input) => {
        const existing = document.getDocument().messages.filter((item) => item.conversationId === input.conversationId);
        const sequence = existing.length === 0 ? 0 : Math.max(...existing.map((item) => item.sequence)) + 1;
        const id = ids.id('message');
        const timestamp = now();
        const message: Message = {
          id,
          urn: ids.urn('message', id),
          conversationId: input.conversationId,
          role: input.role,
          content: input.content,
          sequence,
          executionId: input.executionId,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        await document.mutate((doc) => {
          doc.messages.push(message);
        });
        return message;
      },
      list: async (conversationId) =>
        document
          .getDocument()
          .messages.filter((item) => item.conversationId === conversationId)
          .sort((a, b) => a.sequence - b.sequence),
      save: async (message) => {
        await document.mutate((doc) => {
          const index = doc.messages.findIndex((item) => item.id === message.id);
          if (index === -1) doc.messages.push(message);
          else doc.messages[index] = message;
        });
        return message;
      },
    };

    this.executions = {
      create: async (record) => {
        await document.mutate((doc) => {
          doc.executions.push(record);
        });
        return record;
      },
      get: async (id) => document.getDocument().executions.find((item) => item.id === id) ?? null,
      listByConversation: async (conversationId) =>
        document
          .getDocument()
          .executions.filter((item) => item.conversationId === conversationId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      save: async (record) => {
        await document.mutate((doc) => {
          const index = doc.executions.findIndex((item) => item.id === record.id);
          if (index === -1) doc.executions.push(record);
          else doc.executions[index] = record;
        });
        return record;
      },
      listInFlight: async () =>
        document.getDocument().executions.filter((item) => item.status === 'queued' || item.status === 'running'),
    };

    this.provenance = {
      record: async (entry) => {
        await document.mutate((doc) => {
          doc.provenance.push(entry);
        });
      },
      forJob: async (jobId) => document.getDocument().provenance.filter((entry) => entry.jobId === jobId),
      forArtefact: async (artefactId) =>
        document.getDocument().provenance.filter((entry) => entry.artefactId === artefactId),
    };
  }

  snapshot(): DurableDocument {
    return this.document.snapshot();
  }
}

export function openDurableStore(filePath: string): DurableConversationStore {
  return new DurableConversationStore(new FileDocument(filePath));
}
