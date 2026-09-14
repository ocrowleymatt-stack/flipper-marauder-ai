import type {
  Conversation,
  ConversationSnapshot,
  ConversationStreamEvent,
  ExecutionAttempt,
  ExecutionRecord,
  ExecutionStatus,
  Message,
  ProvenanceRecord,
  RouteDecision,
  StructuredFailure,
  TokenUsage,
} from '@atlas-vnext/contracts';
import type { EventBus } from '@atlas-vnext/events';
import type { IdFactory } from './ids.ts';
import { UuidIdFactory } from './ids.ts';
import type {
  CapabilityRouter,
  ConversationClock,
  ConversationRepository,
  ExecutionRepository,
  MessageRepository,
  ModelExecutor,
  ProvenanceWriter,
} from './ports.ts';
import { assertExecutionTransition } from './transitions.ts';

const DEFAULT_TITLE = 'New conversation';
const TITLE_LIMIT = 72;

export interface ConversationRuntimeDeps {
  conversations: ConversationRepository;
  messages: MessageRepository;
  executions: ExecutionRepository;
  events: EventBus;
  router: CapabilityRouter;
  executor: ModelExecutor;
  provenance: ProvenanceWriter;
  ids?: IdFactory;
  clock?: ConversationClock;
  availableRuntimes?: string[];
  /** Local-only Private routing. Default `any` does not change existing callers. */
  privacy?: 'any' | 'local_only';
}

export class ConversationRuntime {
  private readonly ids: IdFactory;
  private readonly clock: ConversationClock;
  private readonly inflight = new Map<string, AbortController>();

  constructor(private readonly deps: ConversationRuntimeDeps) {
    this.ids = deps.ids ?? new UuidIdFactory();
    this.clock = deps.clock ?? { now: () => new Date().toISOString() };
  }

  async createConversation(input: { title?: string; projectId?: string | null } = {}): Promise<Conversation> {
    const conversation = await this.deps.conversations.create({
      title: sanitiseTitle(input.title) ?? DEFAULT_TITLE,
      projectId: input.projectId ?? null,
    });
    await this.publish(conversation.id, 'conversation.created', { conversationId: conversation.id });
    return conversation;
  }

  async listConversations(): Promise<Conversation[]> {
    return this.deps.conversations.list();
  }

  async getSnapshot(conversationId: string): Promise<ConversationSnapshot | null> {
    const conversation = await this.deps.conversations.get(conversationId);
    if (!conversation) return null;
    const [messages, executions] = await Promise.all([
      this.deps.messages.list(conversationId),
      this.deps.executions.listByConversation(conversationId),
    ]);
    return { conversation, messages, executions };
  }

  async recoverInFlight(reason = 'Process restarted before the execution finished.'): Promise<ExecutionRecord[]> {
    const inflight = await this.deps.executions.listInFlight();
    const recovered: ExecutionRecord[] = [];
    for (const execution of inflight) {
      const failed = await this.transition(execution, 'failed', {
        failureReason: failure('interrupted', reason, true),
      });
      await this.publish(failed.conversationId, 'execution.failed', {
        executionId: failed.id,
        code: 'interrupted',
      });
      recovered.push(failed);
    }
    return recovered;
  }

  async cancel(executionId: string): Promise<ExecutionRecord> {
    const execution = await this.deps.executions.get(executionId);
    if (!execution) {
      throw new Error(`Execution ${executionId} not found.`);
    }
    if (execution.status === 'completed' || execution.status === 'failed' || execution.status === 'cancelled') {
      return execution;
    }
    const controller = this.inflight.get(executionId);
    if (controller) {
      controller.abort();
      return execution;
    }
    const cancelled = await this.transition(execution, 'cancelled', {
      failureReason: failure('cancelled', 'Execution cancelled.', false, this.clock.now()),
    });
    await this.publish(cancelled.conversationId, 'execution.cancelled', { executionId: cancelled.id });
    return cancelled;
  }

  async *sendMessage(
    conversationId: string,
    input: { content: string; capability?: string; privacy?: 'any' | 'local_only' },
  ): AsyncGenerator<ConversationStreamEvent> {
    const content = input.content.trim();
    if (!content) {
      yield { type: 'error', failure: failure('empty_prompt', 'Message cannot be empty.', false) };
      return;
    }

    const conversation = await this.deps.conversations.get(conversationId);
    if (!conversation) {
      yield { type: 'error', failure: failure('not_found', `Conversation ${conversationId} not found.`, false) };
      return;
    }

    const capability = input.capability?.trim() || 'nexus/fast';
    const userMessage = await this.deps.messages.append({
      conversationId,
      role: 'user',
      content,
      executionId: null,
    });
    await this.touchConversation(conversation, content);
    await this.publish(conversationId, 'message.appended', { messageId: userMessage.id, role: 'user' });
    yield { type: 'message', message: userMessage };

    const executionId = this.ids.id('execution');
    const timestamp = this.clock.now();
    let execution: ExecutionRecord = {
      id: executionId,
      urn: this.ids.urn('execution', executionId),
      conversationId,
      userMessageId: userMessage.id,
      assistantMessageId: null,
      status: 'queued',
      capability,
      route: null,
      selectedProvider: null,
      selectedModel: null,
      attempts: [],
      usage: null,
      failureReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      completedAt: null,
    };
    execution = await this.deps.executions.create(execution);
    await this.publish(conversationId, 'execution.created', { executionId });
    yield { type: 'execution', execution };

    const controller = new AbortController();
    this.inflight.set(executionId, controller);

    try {
      if (controller.signal.aborted) {
        execution = await this.finishCancelled(execution, [], null);
        yield { type: 'execution', execution };
        yield { type: 'done' };
        return;
      }
      execution = await this.transition(execution, 'running');
      yield { type: 'execution', execution };
      yield { type: 'execution.started', executionId, capability };

      let decision: RouteDecision;
      try {
        decision = this.deps.router.resolve(capability, {
          contextTokens: estimateTokens(content),
          traceId: execution.id,
          availableRuntimes: this.deps.availableRuntimes,
          privacy: input.privacy ?? this.deps.privacy ?? 'any',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        execution = await this.transition(execution, 'failed', {
          failureReason: failure('routing_failed', message, false),
        });
        await this.publish(conversationId, 'execution.failed', { executionId, code: 'routing_failed' });
        yield { type: 'execution', execution };
        yield { type: 'execution.failed', executionId, failure: execution.failureReason ?? failure('routing_failed', message, false) };
        yield { type: 'error', failure: execution.failureReason ?? failure('routing_failed', message, false) };
        return;
      }

      execution = await this.saveExecution({
        ...execution,
        route: decision,
        selectedProvider: decision.provider,
        selectedModel: decision.model,
      });
      await this.publish(conversationId, 'execution.routed', {
        executionId,
        provider: decision.provider,
        model: decision.model,
        target: decision.target,
      });
      yield { type: 'execution', execution };

      let assistant: Message | null = null;
      let assembled = '';
      let usage: TokenUsage | null = null;
      const attempts: ExecutionAttempt[] = [];
      const startedMs = Date.now();
      const pending: ConversationStreamEvent[] = [];

      const observer = {
        onAttempt: (
          attempt: Pick<ExecutionAttempt, 'index' | 'provider' | 'model' | 'outcome' | 'error' | 'emittedVisibleOutput'>,
        ) => {
          const at = this.clock.now();
          const existing = attempts.findIndex((item) => item.index === attempt.index);
          const record: ExecutionAttempt = {
            index: attempt.index,
            provider: attempt.provider,
            model: attempt.model,
            startedAt: existing === -1 ? at : attempts[existing]!.startedAt,
            endedAt: attempt.outcome === 'started' ? null : at,
            outcome: attempt.outcome,
            error: attempt.error,
            emittedVisibleOutput: attempt.emittedVisibleOutput,
          };
          if (existing === -1) attempts.push(record);
          else attempts[existing] = record;
          if (attempt.outcome === 'started') {
            pending.push({
              type: 'attempt.started',
              executionId,
              index: attempt.index,
              provider: attempt.provider,
              model: attempt.model,
            });
          } else if (attempt.outcome === 'failed' && attempt.error) {
            pending.push({
              type: 'attempt.failed',
              executionId,
              index: attempt.index,
              provider: attempt.provider,
              model: attempt.model,
              failure: attempt.error,
              emittedVisibleOutput: attempt.emittedVisibleOutput,
            });
            pending.push({
              type: 'provider.failed',
              executionId,
              provider: attempt.provider,
              model: attempt.model,
              failure: attempt.error,
            });
          } else if (attempt.outcome === 'succeeded' || attempt.outcome === 'skipped' || attempt.outcome === 'cancelled') {
            pending.push({
              type: 'attempt.completed',
              executionId,
              index: attempt.index,
              provider: attempt.provider,
              model: attempt.model,
              outcome: attempt.outcome,
            });
          }
        },
        onSelected: (selection: { provider: string; model: string }) => {
          execution.selectedProvider = selection.provider;
          execution.selectedModel = selection.model;
        },
      };

      try {
        for await (const chunk of this.deps.executor.execute(
          decision,
          { prompt: content, signal: controller.signal, traceId: decision.traceId },
          observer,
        )) {
          for (const event of pending.splice(0)) yield event;
          if (chunk.type === 'usage') {
            usage = chunk.usage;
            yield { type: 'usage', executionId, usage: chunk.usage };
            continue;
          }
          if (chunk.type === 'warning') {
            yield {
              type: 'provider.warning',
              executionId,
              provider: chunk.provider ?? execution.selectedProvider ?? decision.provider,
              message: chunk.message,
            };
            continue;
          }
          if (chunk.type === 'reasoning') {
            yield { type: 'reasoning.delta', executionId, text: chunk.text };
            continue;
          }
          if (chunk.type === 'tool_call') {
            yield { type: 'tool.requested', executionId, call: chunk.call };
            continue;
          }
          if (chunk.type !== 'text' || chunk.text.length === 0) {
            continue;
          }
          assembled += chunk.text;
          if (!assistant) {
            assistant = await this.deps.messages.append({
              conversationId,
              role: 'assistant',
              content: assembled,
              executionId,
            });
            execution = await this.saveExecution({
              ...execution,
              assistantMessageId: assistant.id,
              attempts: [...attempts],
              selectedProvider: execution.selectedProvider,
              selectedModel: execution.selectedModel,
            });
            await this.publish(conversationId, 'message.appended', {
              messageId: assistant.id,
              role: 'assistant',
            });
            yield { type: 'message', message: assistant };
            yield { type: 'execution', execution };
          } else {
            assistant = await this.deps.messages.save({
              ...assistant,
              content: assembled,
              updatedAt: this.clock.now(),
            });
          }
          yield { type: 'assistant.delta', executionId, text: assembled };
          yield { type: 'message.delta', messageId: assistant.id, content: assembled };
        }
        for (const event of pending.splice(0)) yield event;

        if (controller.signal.aborted) {
          execution = await this.finishCancelled(execution, attempts, usage, Date.now() - startedMs);
          yield { type: 'execution', execution };
          yield { type: 'done' };
          return;
        }

        execution = await this.transition(
          { ...execution, attempts: [...attempts], usage, latencyMs: Date.now() - startedMs },
          'completed',
        );
        if (assembled.length > 0) {
          yield { type: 'assistant.completed', executionId, text: assembled };
        }
        if (assistant && execution.selectedProvider && execution.selectedModel) {
          await this.recordProvenance(conversation, userMessage, assistant, execution, decision);
        }
        await this.publish(conversationId, 'execution.completed', {
          executionId,
          provider: execution.selectedProvider,
          model: execution.selectedModel,
        });
        yield {
          type: 'execution.completed',
          executionId,
          provider: execution.selectedProvider,
          model: execution.selectedModel,
        };
        yield { type: 'execution', execution };
        yield { type: 'done' };
      } catch (err) {
        for (const event of pending.splice(0)) yield event;
        const aborted = controller.signal.aborted;
        const message = err instanceof Error ? err.message : String(err);
        const visible = attempts.some((attempt) => attempt.emittedVisibleOutput) || assembled.length > 0;
        const status: ExecutionStatus = aborted ? 'cancelled' : 'failed';
        const code = aborted ? 'cancelled' : visible ? 'partial_stream_failure' : 'provider_error';
        const structured = failure(code, message, !visible && !aborted);
        execution = await this.transition(
          { ...execution, attempts: [...attempts], usage, latencyMs: Date.now() - startedMs },
          status,
          { failureReason: structured },
        );
        await this.publish(conversationId, status === 'cancelled' ? 'execution.cancelled' : 'execution.failed', {
          executionId,
          code,
          visibleOutput: visible,
        });
        yield { type: 'execution', execution };
        if (status === 'failed') {
          yield { type: 'execution.failed', executionId, failure: structured };
          yield { type: 'error', failure: execution.failureReason ?? structured };
        }
        yield { type: 'done' };
      }
    } finally {
      this.inflight.delete(executionId);
    }
  }

  private async finishCancelled(
    execution: ExecutionRecord,
    attempts: ExecutionAttempt[],
    usage: TokenUsage | null,
    latencyMs?: number,
  ): Promise<ExecutionRecord> {
    return this.transition(
      { ...execution, attempts: [...attempts], usage, latencyMs: latencyMs ?? execution.latencyMs },
      'cancelled',
      { failureReason: failure('cancelled', 'Execution cancelled.', false) },
    );
  }

  private async recordProvenance(
    conversation: Conversation,
    userMessage: Message,
    assistant: Message,
    execution: ExecutionRecord,
    decision: RouteDecision,
  ): Promise<void> {
    const entry: ProvenanceRecord = {
      artefactId: assistant.id,
      projectId: conversation.projectId ?? conversation.id,
      sourceInputs: [userMessage.id],
      inputManifestHash: null,
      provider: execution.selectedProvider ?? decision.provider,
      model: execution.selectedModel ?? decision.model,
      toolCalls: [],
      jobId: execution.id,
      timestamp: this.clock.now(),
      traceId: decision.traceId,
      capability: execution.capability,
      usage: execution.usage,
      locality: decision.locality,
      latencyMs: execution.latencyMs ?? null,
      selectedRouteId: decision.resolvedRouteId,
      attemptOutcomes: execution.attempts.map((attempt) => ({
        provider: attempt.provider,
        model: attempt.model,
        outcome: attempt.outcome,
        emittedVisibleOutput: attempt.emittedVisibleOutput,
      })),
    };
    await this.deps.provenance.record(entry);
  }

  private async touchConversation(conversation: Conversation, firstUserText: string): Promise<void> {
    const titled =
      conversation.title === DEFAULT_TITLE ? titleFromPrompt(firstUserText) : conversation.title;
    await this.deps.conversations.save({
      ...conversation,
      title: titled,
      updatedAt: this.clock.now(),
    });
  }

  private async transition(
    execution: ExecutionRecord,
    to: ExecutionStatus,
    patch: Partial<ExecutionRecord> = {},
  ): Promise<ExecutionRecord> {
    if (execution.status !== to) {
      assertExecutionTransition(execution.status, to);
    }
    const timestamp = this.clock.now();
    const next: ExecutionRecord = {
      ...execution,
      ...patch,
      status: to,
      updatedAt: timestamp,
      startedAt: to === 'running' ? (execution.startedAt ?? timestamp) : (patch.startedAt ?? execution.startedAt),
      completedAt:
        to === 'completed' || to === 'failed' || to === 'cancelled'
          ? timestamp
          : (patch.completedAt ?? execution.completedAt),
    };
    return this.deps.executions.save(next);
  }

  private async saveExecution(execution: ExecutionRecord): Promise<ExecutionRecord> {
    const next = { ...execution, updatedAt: this.clock.now() };
    return this.deps.executions.save(next);
  }

  private async publish(
    conversationId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.events.publish({
      channel: conversationChannel(conversationId),
      type,
      payload,
    });
  }
}

export function conversationChannel(conversationId: string): string {
  return `conversation:${conversationId}`;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function titleFromPrompt(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= TITLE_LIMIT) return compact;
  return `${compact.slice(0, TITLE_LIMIT - 1).trimEnd()}…`;
}

function sanitiseTitle(title: string | undefined): string | null {
  const trimmed = title?.trim();
  return trimmed ? trimmed : null;
}

function failure(code: string, message: string, retryable: boolean, at?: string): StructuredFailure {
  return { code, message, retryable, at: at ?? new Date().toISOString() };
}
