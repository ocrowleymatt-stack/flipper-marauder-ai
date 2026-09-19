import {
  DEFAULT_OPERATIONAL_LIMITS,
  type Conversation,
  type ConversationHistoryTurn,
  type ConversationSnapshot,
  type ConversationStreamEvent,
  type ExecutionAttempt,
  type ExecutionRecord,
  type ExecutionStatus,
  type Message,
  type ProvenanceRecord,
  type RouteDecision,
  type StructuredFailure,
  type TokenUsage,
  type ToolCallRequest,
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
  ToolOrchestrator,
  UnitOfWork,
} from './ports.ts';
import { iterateUntilAborted } from './async-iterator.ts';
import { assertExecutionTransition } from './transitions.ts';
import { compileConversationHistory } from './history.ts';

/** Base UTF-8 size for the first stream persist checkpoint. Later checkpoints double. */
export const STREAM_PERSIST_CHECKPOINT_BYTES = 8 * 1024;
/** Hard ceiling on tool-using model rounds per `sendMessage` when callers omit `maxToolRounds`. */
export const DEFAULT_MAX_TOOL_ROUNDS = 8;

/**
 * Next persist threshold after `persistedBytes`. Thresholds grow geometrically
 * (8 KiB, 16 KiB, 32 KiB, …) so cumulative saved payload stays O(n) while crash
 * recovery still has a checkpointed prefix.
 */
export function nextStreamPersistCheckpoint(
  persistedBytes: number,
  baseBytes = STREAM_PERSIST_CHECKPOINT_BYTES,
): number {
  if (persistedBytes < baseBytes) return baseBytes;
  let next = baseBytes;
  while (next <= persistedBytes) {
    const doubled = next * 2;
    if (!Number.isFinite(doubled) || doubled <= next) return Number.MAX_SAFE_INTEGER;
    next = doubled;
  }
  return next;
}

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
  /** Optional transactional boundary for conversation/message/execution writes. */
  unitOfWork?: UnitOfWork;
  toolOrchestrator?: ToolOrchestrator;
  principalId?: string;
  maxConcurrentExecutions?: number;
  /** UTF-8 byte ceiling for provider-generated user-visible output. */
  maxGeneratedBytes?: number;
  /** Hard ceiling on tool-using model rounds per sendMessage. */
  maxToolRounds?: number;
  /** Overall execution deadline; abort is propagated to iterators and in-flight tool waits. */
  executionDeadlineMs?: number;
  /**
   * Optional product work (research, dungeons) that can claim a user turn and
   * return durable assistant text to this conversation. Injected by the host.
   */
  workHandler?: ConversationWorkHandler;
}

export interface ConversationWorkHandler {
  (input: {
    conversationId: string;
    content: string;
    projectId: string | null;
    tenantId?: string;
    signal?: AbortSignal;
  }): Promise<{ handled: boolean; text?: string } | void>;
}

export class GeneratedOutputLimitError extends Error {
  readonly code = 'payload_too_large';

  constructor(
    readonly acceptedBytes: number,
    readonly limitBytes: number,
  ) {
    super('generated exceeds the configured limit.');
    this.name = 'GeneratedOutputLimitError';
  }
}

export class ConversationRuntime {
  private readonly ids: IdFactory;
  private readonly clock: ConversationClock;
  private readonly inflight = new Map<string, AbortController>();
  private workHandler: ConversationWorkHandler | undefined;

  constructor(private readonly deps: ConversationRuntimeDeps) {
    this.ids = deps.ids ?? new UuidIdFactory();
    this.clock = deps.clock ?? { now: () => new Date().toISOString() };
    this.workHandler = deps.workHandler;
  }

  setWorkHandler(handler: ConversationWorkHandler | undefined): void {
    this.workHandler = handler;
  }

  private generatedByteLimit(): number {
    return this.deps.maxGeneratedBytes ?? DEFAULT_OPERATIONAL_LIMITS.maxGeneratedBytes;
  }

  async createConversation(input: { title?: string; projectId?: string | null } = {}): Promise<Conversation> {
    return this.transact(async () => {
      const conversation = await this.deps.conversations.create({
        title: sanitiseTitle(input.title) ?? DEFAULT_TITLE,
        projectId: input.projectId ?? null,
      });
      await this.publish(conversation.id, 'conversation.created', { conversationId: conversation.id }, `conversation:${conversation.id}:created`);
      return conversation;
    });
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

  async postNotice(conversationId: string, content: string): Promise<Message> {
    const conversation = await this.deps.conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found.`);
    }
    const message = await this.deps.messages.append({
      conversationId,
      role: 'assistant',
      content,
      executionId: null,
    });
    await this.publish(conversationId, 'message.appended', { messageId: message.id, role: 'assistant' });
    return message;
  }

  async getExecution(executionId: string): Promise<ExecutionRecord | null> {
    return this.deps.executions.get(executionId);
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
      }, `execution:${failed.id}:interrupted`);
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
    await this.publish(cancelled.conversationId, 'execution.cancelled', { executionId: cancelled.id }, `execution:${cancelled.id}:cancelled`);
    return cancelled;
  }

  async *sendMessage(
    conversationId: string,
    input: {
      content: string;
      capability?: string;
      privacy?: 'any' | 'local_only';
      systemPrompt?: string;
      contextTokens?: number;
      requireTools?: boolean;
      /** Product opt-in to advertise and execute tools. Distinct from Nexus `requireTools`. */
      allowTools?: boolean;
      requireReasoning?: boolean;
      requireVision?: boolean;
      requireCode?: boolean;
    },
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
    const maxConcurrent = this.deps.maxConcurrentExecutions;
    if (maxConcurrent) {
      const running = (await this.deps.executions.listInFlight()).length;
      if (running >= maxConcurrent || this.inflight.size >= maxConcurrent) {
        yield {
          type: 'error',
          failure: failure('rate_limit', 'Concurrent run limit reached.', true),
        };
        return;
      }
    }
    const started = await this.transact(async () => {
      const userMessage = await this.deps.messages.append({
        conversationId,
        role: 'user',
        content,
        executionId: null,
      });
      await this.touchConversation(conversation, content);
      await this.publish(conversationId, 'message.appended', { messageId: userMessage.id, role: 'user' });

      const executionId = this.ids.id('execution');
      const timestamp = this.clock.now();
      const created: ExecutionRecord = {
        id: executionId,
        urn: this.ids.urn('execution', executionId),
        conversationId,
        userMessageId: userMessage.id,
        assistantMessageId: null,
        tenantId: conversation.tenantId,
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
      const execution = await this.deps.executions.create(created);
      await this.publish(conversationId, 'execution.created', { executionId }, `execution:${executionId}:created`);
      return { userMessage, execution };
    });
    const userMessage = started.userMessage;
    let execution = started.execution;
    const executionId = execution.id;
    yield { type: 'message', message: userMessage };
    yield { type: 'execution', execution };

    const controller = new AbortController();
    this.inflight.set(executionId, controller);
    let abortKind: 'deadline' | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadlineMs = this.deps.executionDeadlineMs;
    if (deadlineMs && Number.isFinite(deadlineMs) && deadlineMs > 0) {
      deadlineTimer = setTimeout(() => {
        abortKind = 'deadline';
        controller.abort();
      }, deadlineMs);
    }

    let assistant: Message | null = null;
    let assembled = '';
    let generatedBytes = 0;
    let persistedGeneratedBytes = 0;
    let nextPersistAt = STREAM_PERSIST_CHECKPOINT_BYTES;
    let usage: TokenUsage | null = null;
    let roundUsage: TokenUsage | null = null;
    const commitRoundUsage = (): void => {
      if (!roundUsage) return;
      usage = addTokenUsage(usage, roundUsage);
      roundUsage = null;
    };
    let attempts: ExecutionAttempt[] = [];
    let visibleOutputEver = false;
    let startedMs = Date.now();
    let settled = false;

    try {
      if (controller.signal.aborted) {
        execution = await this.finishCancelled(execution, [], null);
        settled = true;
        yield { type: 'execution', execution };
        yield { type: 'done' };
        return;
      }
      execution = await this.transition(execution, 'running');
      yield { type: 'execution', execution };
      yield { type: 'execution.started', executionId, capability };

      const listed = await this.deps.messages.list(conversationId);
      const history: ConversationHistoryTurn[] = compileConversationHistory(listed, {
        excludeMessageId: userMessage.id,
      });

      if (this.workHandler) {
        const work = await this.workHandler({
          conversationId,
          content,
          projectId: conversation.projectId ?? null,
          tenantId: conversation.tenantId,
          signal: controller.signal,
        });
        if (work && work.handled) {
          const text = (work.text ?? 'Work completed.').trim() || 'Work completed.';
          assistant = await this.deps.messages.append({
            conversationId,
            role: 'assistant',
            content: text,
            executionId,
          });
          assembled = text;
          execution = await this.saveExecution({
            ...execution,
            assistantMessageId: assistant.id,
          });
          await this.publish(conversationId, 'message.appended', {
            messageId: assistant.id,
            role: 'assistant',
          });
          yield { type: 'message', message: assistant };
          yield { type: 'execution', execution };
          yield { type: 'assistant.delta', executionId, text };
          yield { type: 'message.delta', messageId: assistant.id, content: text };
          execution = await this.transition(
            { ...execution, latencyMs: Date.now() - startedMs },
            'completed',
          );
          settled = true;
          yield { type: 'assistant.completed', executionId, text };
          yield {
            type: 'execution.completed',
            executionId,
            provider: execution.selectedProvider,
            model: execution.selectedModel,
          };
          yield { type: 'execution', execution };
          yield { type: 'done' };
          return;
        }
      }

      let decision: RouteDecision;
      try {
        decision = this.deps.router.resolve(capability, {
          contextTokens: input.contextTokens ?? estimateTokens([input.systemPrompt, content].filter(Boolean).join('\n')),
          traceId: execution.id,
          availableRuntimes: this.deps.availableRuntimes,
          privacy: input.privacy ?? this.deps.privacy ?? 'any',
          requireTools: input.requireTools,
          requireReasoning: input.requireReasoning,
          requireVision: input.requireVision,
          requireCode: input.requireCode,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        execution = await this.transition(execution, 'failed', {
          failureReason: failure('routing_failed', message, false),
        });
        await this.publish(conversationId, 'execution.failed', { executionId, code: 'routing_failed' });
        settled = true;
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

      const persistAssembled = async (force = false): Promise<void> => {
        if (!assistant) return;
        if (generatedBytes === persistedGeneratedBytes) return;
        if (!force && generatedBytes < nextPersistAt) return;
        assistant = await this.deps.messages.save({
          ...assistant,
          content: assembled,
          updatedAt: this.clock.now(),
        });
        persistedGeneratedBytes = generatedBytes;
        nextPersistAt = nextStreamPersistCheckpoint(generatedBytes);
      };

      const acceptGenerated = (text: string): void => {
        const extra = utf8ByteLength(text);
        const limit = this.generatedByteLimit();
        if (generatedBytes + extra > limit) {
          throw new GeneratedOutputLimitError(generatedBytes, limit);
        }
        generatedBytes += extra;
      };

      const applyText = async (text: string): Promise<ConversationStreamEvent[]> => {
        acceptGenerated(text);
        assembled += text;
        const events: ConversationStreamEvent[] = [];
        if (!assistant) {
          const first = await this.transact(async () => {
            const message = await this.deps.messages.append({
              conversationId,
              role: 'assistant',
              content: assembled,
              executionId,
            });
            const nextExecution = await this.saveExecution({
              ...execution,
              assistantMessageId: message.id,
              attempts: [...attempts],
              selectedProvider: execution.selectedProvider,
              selectedModel: execution.selectedModel,
            });
            await this.publish(conversationId, 'message.appended', {
              messageId: message.id,
              role: 'assistant',
            });
            return { message, execution: nextExecution };
          });
          assistant = first.message;
          execution = first.execution;
          persistedGeneratedBytes = generatedBytes;
          nextPersistAt = nextStreamPersistCheckpoint(generatedBytes);
          events.push({ type: 'message', message: { ...assistant, content: '' } });
          events.push({ type: 'execution', execution });
        } else {
          await persistAssembled(false);
        }
        events.push({ type: 'assistant.delta', executionId, text });
        events.push({ type: 'message.delta', messageId: assistant.id, content: text });
        return events;
      };

      startedMs = Date.now();
      const pending: ConversationStreamEvent[] = [];
      const accumulatedToolResults: Array<{
        callId: string;
        toolId: string;
        arguments: Record<string, unknown>;
        status: string;
        resultRef?: string | null;
        output?: unknown;
        round: number;
      }> = [];
      const collectedToolCalls: ToolCallRequest[] = [];
      const maxToolRounds = this.deps.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
      let toolRounds = 0;
      const toolsEnabled = input.allowTools === true;
      const callableTools =
        toolsEnabled && this.deps.toolOrchestrator?.listCallable && conversation.tenantId
          ? await this.deps.toolOrchestrator.listCallable({
              tenantId: conversation.tenantId,
              principalId: this.deps.principalId ?? conversation.tenantId,
              workspaceId: conversation.workspaceId ?? conversation.projectId ?? null,
            })
          : undefined;

      const observer = {
        onAttempt: (
          attempt: Pick<ExecutionAttempt, 'index' | 'provider' | 'model' | 'outcome' | 'error' | 'emittedVisibleOutput'>,
        ) => {
          const at = this.clock.now();
          const existing = attempts.findIndex((item) => item.index === attempt.index);
          const priorVisible = existing === -1 ? false : attempts[existing]!.emittedVisibleOutput;
          const visible = priorVisible || attempt.emittedVisibleOutput;
          if (visible) visibleOutputEver = true;
          const record: ExecutionAttempt = {
            index: attempt.index,
            provider: attempt.provider,
            model: attempt.model,
            startedAt: existing === -1 ? at : attempts[existing]!.startedAt,
            endedAt: attempt.outcome === 'started' ? null : at,
            outcome: attempt.outcome,
            error: attempt.error,
            emittedVisibleOutput: visible,
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
              emittedVisibleOutput: visible,
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
        const hasVisibleOutput = (): boolean =>
          visibleOutputEver || assembled.length > 0 || attempts.some((attempt) => attempt.emittedVisibleOutput);

        const pinnedDecision = (): RouteDecision => {
          if (!hasVisibleOutput() || !execution.selectedProvider || !execution.selectedModel) {
            return decision;
          }
          const pinned = `${execution.selectedProvider}/${execution.selectedModel}`;
          return {
            ...decision,
            provider: execution.selectedProvider,
            model: execution.selectedModel,
            resolvedRouteId: pinned,
            candidateChain: [pinned],
          };
        };

        const settleAbort = async (): Promise<ConversationStreamEvent[]> => {
          await persistAssembled(true);
          if (abortKind === 'deadline') {
            const structured = failure('timeout', 'Execution deadline exceeded.', false);
            execution = await this.transition(
              { ...execution, attempts: [...attempts], usage, latencyMs: Date.now() - startedMs },
              'failed',
              { failureReason: structured },
            );
            await this.publish(
              conversationId,
              'execution.failed',
              { executionId, code: 'timeout', visibleOutput: hasVisibleOutput() },
              `execution:${executionId}:failed`,
            );
            settled = true;
            return [
              { type: 'execution', execution },
              { type: 'execution.failed', executionId, failure: structured },
              { type: 'error', failure: structured },
              { type: 'done' },
            ];
          }
          execution = await this.finishCancelled(execution, attempts, usage, Date.now() - startedMs);
          settled = true;
          return [
            { type: 'execution', execution },
            { type: 'done' },
          ];
        };

        const failStructured = async (
          code: string,
          message: string,
          retryable: boolean,
        ): Promise<ConversationStreamEvent[]> => {
          await persistAssembled(true);
          const structured = failure(code, message, retryable);
          execution = await this.transition(
            { ...execution, attempts: [...attempts], usage, latencyMs: Date.now() - startedMs },
            'failed',
            { failureReason: structured },
          );
          await this.publish(
            conversationId,
            'execution.failed',
            { executionId, code, visibleOutput: hasVisibleOutput() },
            `execution:${executionId}:failed`,
          );
          settled = true;
          return [
            { type: 'execution', execution },
            { type: 'execution.failed', executionId, failure: structured },
            { type: 'error', failure: structured },
            { type: 'done' },
          ];
        };

        const completeSuccessfully = async (): Promise<ConversationStreamEvent[]> => {
          await persistAssembled(true);
          execution = await this.transition(
            { ...execution, attempts: [...attempts], usage, latencyMs: Date.now() - startedMs },
            'completed',
          );
          const events: ConversationStreamEvent[] = [];
          if (assembled.length > 0) {
            events.push({ type: 'assistant.completed', executionId, text: assembled });
          }
          if (assistant && execution.selectedProvider && execution.selectedModel) {
            await this.recordProvenance(conversation, userMessage, assistant, execution, decision, collectedToolCalls);
          }
          await this.publish(
            conversationId,
            'execution.completed',
            {
              executionId,
              provider: execution.selectedProvider,
              model: execution.selectedModel,
            },
            `execution:${executionId}:completed`,
          );
          settled = true;
          events.push({
            type: 'execution.completed',
            executionId,
            provider: execution.selectedProvider,
            model: execution.selectedModel,
          });
          events.push({ type: 'execution', execution });
          events.push({ type: 'done' });
          return events;
        };

        for (;;) {
          const prior = accumulatedToolResults.length > 0 ? accumulatedToolResults : undefined;
          const routed = prior ? pinnedDecision() : decision;
          const roundTools: typeof accumulatedToolResults = [];
          let roundLimitHit = false;

          for await (const chunk of iterateUntilAborted(
            this.deps.executor.execute(
              routed,
              {
                prompt: content,
                systemPrompt: input.systemPrompt,
                history,
                signal: controller.signal,
                traceId: decision.traceId,
                priorToolResults: prior,
                tools: callableTools,
                attemptIndexBase: attempts.reduce((max, item) => Math.max(max, item.index), 0),
                visibleOutputAlready: hasVisibleOutput(),
              },
              observer,
            ),
            controller.signal,
          )) {
            for (const event of pending.splice(0)) yield event;
            if (chunk.type === 'usage') {
              roundUsage = chunk.usage;
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
              if (chunk.text.length > 0) visibleOutputEver = true;
              acceptGenerated(chunk.text);
              yield { type: 'reasoning.delta', executionId, text: chunk.text };
              continue;
            }
            if (chunk.type === 'tool_call') {
              if (!toolsEnabled) {
                continue;
              }
              yield { type: 'tool.requested', executionId, call: chunk.call };
              if (!this.deps.toolOrchestrator || !conversation.tenantId) {
                continue;
              }
              if (toolRounds >= maxToolRounds) {
                roundLimitHit = true;
                continue;
              }
              const handled = await this.deps.toolOrchestrator.handleCall({
                  tenantId: conversation.tenantId,
                  principalId: this.deps.principalId ?? conversation.tenantId,
                  workspaceId: conversation.workspaceId ?? conversation.projectId ?? null,
                  conversationId,
                  executionId,
                  provider: execution.selectedProvider,
                  model: execution.selectedModel,
                  call: chunk.call,
                  signal: controller.signal,
                });
              yield {
                type: 'tool.lifecycle',
                executionId,
                invocationId: handled.invocationId,
                toolId: handled.toolId,
                status: handled.status,
                reason: handled.reason,
              };
              if (handled.output !== undefined || handled.resultRef) {
                yield {
                  type: 'tool.result',
                  executionId,
                  invocationId: handled.invocationId,
                  toolId: handled.toolId,
                  resultRef: handled.resultRef ?? null,
                  output: handled.output,
                };
              }
              roundTools.push({
                callId: chunk.call.id,
                toolId: handled.toolId,
                arguments: chunk.call.arguments,
                status: handled.status,
                resultRef: handled.resultRef ?? null,
                output: handled.output,
                round: toolRounds,
              });
              collectedToolCalls.push(chunk.call);
              continue;
            }
            if (chunk.type !== 'text' || chunk.text.length === 0) {
              continue;
            }
            visibleOutputEver = true;
            for (const event of await applyText(chunk.text)) yield event;
          }
          for (const event of pending.splice(0)) yield event;
          commitRoundUsage();

          if (controller.signal.aborted) {
            for (const event of await settleAbort()) yield event;
            return;
          }

          if (roundLimitHit) {
            for (const event of await failStructured(
              'tool_round_limit',
              'Tool-round limit reached before a final model response.',
              false,
            )) {
              yield event;
            }
            return;
          }

          if (roundTools.length === 0) {
            break;
          }

          const blocking = roundTools.filter(
            (row) => row.status !== 'succeeded' && row.status !== 'awaiting_approval',
          );
          if (blocking.length > 0) {
            const first = blocking[0]!;
            for (const event of await failStructured(
              toolFailureCode(first.status),
              `Tool ${first.toolId} ended in ${first.status}.`,
              false,
            )) {
              yield event;
            }
            return;
          }

          if (roundTools.some((row) => row.status === 'awaiting_approval')) {
            for (const event of await completeSuccessfully()) yield event;
            return;
          }

          toolRounds += 1;
          accumulatedToolResults.push(...roundTools);
        }

        if (controller.signal.aborted) {
          for (const event of await settleAbort()) yield event;
          return;
        }

        for (const event of await completeSuccessfully()) yield event;
      } catch (err) {
        commitRoundUsage();
        for (const event of pending.splice(0)) yield event;
        const limited = err instanceof GeneratedOutputLimitError;
        if (limited && !controller.signal.aborted) {
          controller.abort();
        }
        await persistAssembled(true);
        const deadlineHit = abortKind === 'deadline';
        const aborted = controller.signal.aborted && !limited && !deadlineHit;
        const message = err instanceof Error ? err.message : String(err);
        const visible = visibleOutputEver || attempts.some((attempt) => attempt.emittedVisibleOutput) || assembled.length > 0;
        const status: ExecutionStatus = aborted ? 'cancelled' : 'failed';
        const code = deadlineHit
          ? 'timeout'
          : aborted
            ? 'cancelled'
            : limited
              ? 'payload_too_large'
              : visible
                ? 'partial_stream_failure'
                : 'provider_error';
        const structured = failure(code, message, !limited && !visible && !aborted && !deadlineHit);
        execution = await this.transition(
          { ...execution, attempts: [...attempts], usage, latencyMs: Date.now() - startedMs },
          status,
          { failureReason: structured },
        );
        await this.publish(conversationId, status === 'cancelled' ? 'execution.cancelled' : 'execution.failed', {
          executionId,
          code,
          visibleOutput: visible,
        }, `execution:${executionId}:${status}`);
        settled = true;
        yield { type: 'execution', execution };
        if (status === 'failed') {
          yield { type: 'execution.failed', executionId, failure: structured };
          yield { type: 'error', failure: execution.failureReason ?? structured };
        }
        yield { type: 'done' };
      }
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      try {
        commitRoundUsage();
        if (!settled) {
          const pendingAssistant = assistant;
          if (pendingAssistant !== null) {
            assistant = await this.deps.messages.save({
              ...(pendingAssistant as Message),
              content: assembled,
              updatedAt: this.clock.now(),
            });
          }
        }
        if (!settled && (execution.status === 'queued' || execution.status === 'running')) {
          execution = await this.finishCancelled(execution, attempts, usage, Date.now() - startedMs);
        }
      } catch {
        // Teardown must still drop inflight even if a late persist fails.
      }
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
    toolCalls: ToolCallRequest[] = [],
  ): Promise<void> {
    // Chat-turn provenance stub only. First-class artefacts live in artefact_metadata
    // and are not required to be messages. Using the assistant message id as artefactId
    // does not make messages the artefact store.
    const entry: ProvenanceRecord = {
      artefactId: assistant.id,
      projectId: conversation.projectId ?? conversation.id,
      sourceInputs: [userMessage.id],
      inputManifestHash: null,
      provider: execution.selectedProvider ?? decision.provider,
      model: execution.selectedModel ?? decision.model,
      toolCalls,
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
    idempotencyKey?: string,
  ): Promise<void> {
    await this.deps.events.publish({
      channel: conversationChannel(conversationId),
      type,
      payload,
      conversationId,
      idempotencyKey,
    });
  }

  private transact<T>(fn: () => Promise<T>): Promise<T> {
    return this.deps.unitOfWork ? this.deps.unitOfWork.run(fn) : fn();
  }
}

export function conversationChannel(conversationId: string): string {
  return `conversation:${conversationId}`;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
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

function addTokenUsage(acc: TokenUsage | null, next: TokenUsage): TokenUsage {
  if (!acc) {
    return {
      inputTokens: next.inputTokens,
      outputTokens: next.outputTokens,
      totalTokens: next.totalTokens,
    };
  }
  return {
    inputTokens: acc.inputTokens + next.inputTokens,
    outputTokens: acc.outputTokens + next.outputTokens,
    totalTokens: acc.totalTokens + next.totalTokens,
  };
}

function failure(code: string, message: string, retryable: boolean, at?: string): StructuredFailure {
  return { code, message, retryable, at: at ?? new Date().toISOString() };
}

function toolFailureCode(status: string): string {
  if (status === 'denied') return 'tool_denied';
  if (status === 'uncertain') return 'tool_uncertain';
  if (status === 'cancelled') return 'cancelled';
  return 'tool_failed';
}
