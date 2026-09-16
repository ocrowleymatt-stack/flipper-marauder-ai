import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_OPERATIONAL_LIMITS,
  type OperationalLimits,
  type ToolApproval,
  type ToolDefinition,
  type ToolInvocation,
  type ToolInvocationStatus,
  type ToolProvenance,
} from '@atlas-vnext/contracts';
import type { EventBus } from '@atlas-vnext/events';
import type { DurableJobEngine } from '@atlas-vnext/jobs';
import { logPlatform } from '@atlas-vnext/observability';
import { AuthorityDeniedError, AuthorityEngine } from '@atlas-vnext/permissions';
import { defaultAdapters, type CommandRunner, type ToolAdapter, type ToolAdapterResult } from './adapters.ts';
import { DuplicateSideEffectError, IncompleteToolCallError, ToolCancelUnconfirmedError, ToolError, UnknownToolError, createAbortError, isAbortError } from './errors.ts';
import { sha256Stable } from './hash.ts';
import { ToolRegistry } from './registry.ts';
import { assertObjectSchema, validateAgainstSchema, type JsonSchema } from './schema.ts';
import type { ToolActor, ToolApprovalStore, ToolInvocationStore } from './store.ts';
import { assertToolTransition, isTerminalToolStatus } from './transitions.ts';

export interface ToolEngineOptions {
  registry: ToolRegistry;
  invocations: ToolInvocationStore;
  approvals: ToolApprovalStore;
  authority: AuthorityEngine;
  adapters?: ToolAdapter[];
  jobs?: DurableJobEngine;
  events?: EventBus;
  limits?: OperationalLimits;
  jailRoot?: string;
  clock?: () => string;
  env?: Record<string, string | undefined>;
  commandRunner?: CommandRunner;
  secretNames?: string[];
  pluginEnabled?: (pluginId: string) => boolean;
}

export interface InvokeRequest {
  toolId: string;
  arguments: Record<string, unknown>;
  callId?: string;
  idempotencyKey?: string;
  conversationId?: string | null;
  executionId?: string | null;
  pluginId?: string | null;
  provider?: string | null;
  model?: string | null;
}

export interface InvokeOptions {
  signal?: AbortSignal;
}

export interface CallableToolDefinition {
  id: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface InvokeResult {
  invocation: ToolInvocation;
  output?: Record<string, unknown>;
  provenance: ToolProvenance;
}

export type ToolRisk = 'read' | 'write' | 'external' | 'admin';

export interface ToolPresentation {
  id: string;
  toolId: string;
  title: string;
  description: string;
  status: ToolInvocationStatus;
  arguments: Record<string, unknown>;
  argumentSummary: string;
  resource: string | null;
  conversationId: string | null;
  executionId: string | null;
  workspaceId: string | null;
  sideEffectClass: ToolInvocation['sideEffectClass'];
  approvalPolicy: string;
  requiredCapabilities: string[];
  risk: ToolRisk;
  awaitingApproval: boolean;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  approval: {
    id: string;
    decision: string;
    decidedBy: string | null;
    decidedAt: string | null;
    reason: string | null;
  } | null;
}

export class ToolEngine {
  private readonly adapters = new Map<string, ToolAdapter>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly limits: OperationalLimits;
  private readonly clock: () => string;
  private readonly jailRoot: string;
  private accepting = true;
  private inFlight = 0;
  private readonly quotaHits = new Map<string, number[]>();
  private readonly approvalMutex = new Map<string, Promise<void>>();

  constructor(private readonly options: ToolEngineOptions) {
    this.limits = options.limits ?? DEFAULT_OPERATIONAL_LIMITS;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.jailRoot = options.jailRoot ?? join(tmpdir(), 'atlas-tool-jail');
    for (const adapter of options.adapters ?? defaultAdapters(options.commandRunner)) {
      this.adapters.set(adapter.id, adapter);
    }
  }

  stopAccepting(): void {
    this.accepting = false;
  }

  /** Occupied concurrency slots, including children that have not yet exited. */
  inFlightCount(): number {
    return this.inFlight;
  }

  async invoke(actor: ToolActor, request: InvokeRequest, options: InvokeOptions = {}): Promise<InvokeResult> {
    this.assertAccepting();
    this.assertActor(actor);
    if (!isPlainObject(request.arguments) || !request.toolId?.trim()) {
      throw new IncompleteToolCallError();
    }
    const argBytes = Buffer.byteLength(JSON.stringify(request.arguments));
    if (argBytes > this.limits.maxToolArgBytes) {
      throw new ToolError('payload_too_large', 'Fail-closed: tool arguments exceed the configured limit.', false);
    }
    const definition = this.lookupTool(request.toolId, request.pluginId);
    const argumentHash = sha256Stable(request.arguments);
    const idempotencyKey = request.idempotencyKey ?? (definition.idempotency === 'none' ? null : `${definition.id}:${argumentHash}`);

    if (idempotencyKey) {
      const existing = await this.options.invocations.findByIdempotency(actor.tenantId, idempotencyKey);
      if (existing) return this.reuse(existing);
    }

    if (needsApproval(definition)) {
      return this.withApprovalMutex(actor.tenantId, () =>
        this.invokeNew(actor, request, definition, argumentHash, idempotencyKey, options.signal),
      );
    }
    return this.invokeNew(actor, request, definition, argumentHash, idempotencyKey, options.signal);
  }

  listCallable(actor: ToolActor): CallableToolDefinition[] {
    this.assertActor(actor);
    const out: CallableToolDefinition[] = [];
    for (const definition of this.options.registry.list()) {
      if (definition.pluginId) {
        const enabled = this.options.pluginEnabled?.(definition.pluginId) ?? true;
        if (!enabled) continue;
      }
      const allowed = definition.requiredCapabilities.every((capability) => {
        const verdict = this.options.authority.decide({
          principal: {
            principalId: actor.principalId,
            kind: 'user',
            tenantId: actor.tenantId,
            workspaceId: actor.workspaceId ?? null,
          },
          capability,
          resource: {
            type: 'tool',
            id: definition.id,
            tenantId: actor.tenantId,
            workspaceId: actor.workspaceId ?? null,
          },
          fromPlugin: Boolean(definition.pluginId),
        });
        return verdict.decision === 'ALLOW';
      });
      if (!allowed) continue;
      out.push({
        id: definition.id,
        description: definition.description,
        inputSchema: definition.inputSchema,
      });
    }
    return out;
  }

  private async invokeNew(
    actor: ToolActor,
    request: InvokeRequest,
    definition: ToolDefinition,
    argumentHash: string,
    idempotencyKey: string | null,
    signal?: AbortSignal,
  ): Promise<InvokeResult> {
    this.assertNotAborted(signal);
    if (needsApproval(definition)) {
      const pending = await this.countActivePendingApprovals(actor.tenantId);
      if (pending >= this.limits.maxPendingApprovals) {
        throw new ToolError('rate_limit', 'Fail-closed: pending approval ceiling reached.', true);
      }
    }

    let invocation = await this.createProposed(actor, request, definition, argumentHash, idempotencyKey);
    try {
      this.assertNotAborted(signal);
      invocation = await this.validate(invocation, definition);
      this.assertNotAborted(signal);
      invocation = await this.authorise(actor, invocation, definition);
      if (invocation.status === 'failed' || invocation.status === 'denied' || invocation.status === 'cancelled') {
        return { invocation, provenance: this.provenance(invocation) };
      }
      if (needsApproval(definition) && invocation.status === 'authorised') {
        const pending = await this.countActivePendingApprovals(actor.tenantId);
        if (pending >= this.limits.maxPendingApprovals) {
          const failed = await this.transition(invocation, 'failed', {
            failureReason: failure('rate_limit', 'Fail-closed: pending approval ceiling reached.', true),
          });
          invocation = failed;
          throw new ToolError('rate_limit', 'Fail-closed: pending approval ceiling reached.', true);
        }
        invocation = await this.suspendForApproval(invocation);
        return { invocation, provenance: this.provenance(invocation) };
      }
      return this.executeAuthorised(actor, invocation, definition, signal);
    } catch (err) {
      if (isAbortError(err) && !isTerminalToolStatus(invocation.status)) {
        return this.terminaliseAbort(invocation, definition);
      }
      throw err;
    }
  }

  async approve(actor: ToolActor, invocationId: string, decision: 'approved' | 'denied', reason?: string): Promise<InvokeResult> {
    this.assertActor(actor);
    const invocation = await this.loadOwned(actor, invocationId);
    if (invocation.status !== 'awaiting_approval') {
      throw new ToolError('not_awaiting_approval', `Invocation ${invocationId} is ${invocation.status}.`, false);
    }
    const approval = await this.options.approvals.getByInvocation(actor.tenantId, invocationId);
    if (!approval) throw new ToolError('approval_missing', 'Fail-closed: approval record missing.', false);
    if (approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now()) {
      const denied = await this.transition(invocation, 'denied', {
        failureReason: failure('approval_expired', 'Approval expired.', false),
      });
      return { invocation: denied, provenance: this.provenance(denied) };
    }
    const nonce = sha256Stable({ invocationId, tenantId: actor.tenantId, approvalId: approval.id });
    if (nonce !== approval.nonceHash) {
      throw new ToolError('approval_forged', 'Fail-closed: approval binding mismatch.', false);
    }
    const decided: ToolApproval = {
      ...approval,
      decision,
      decidedBy: actor.principalId,
      reason: reason ?? null,
      decidedAt: this.clock(),
    };
    await this.options.approvals.save(decided);
    logPlatform('tool.approval', {
      invocationId,
      tenantId: actor.tenantId,
      principalId: actor.principalId,
      decision,
    });
    if (decision === 'denied') {
      const denied = await this.transition(invocation, 'denied', {
        failureReason: failure('denied', 'Approval denied.', false),
        approvalId: decided.id,
      });
      return { invocation: denied, provenance: this.provenance(denied) };
    }
    const queued = await this.transition(
      { ...invocation, approvalId: decided.id },
      'queued',
    );
    const definition = this.options.registry.get(queued.toolId);
    return this.executeAuthorised(actor, queued, definition);
  }

  async cancel(actor: ToolActor, invocationId: string): Promise<ToolInvocation> {
    this.assertActor(actor);
    const invocation = await this.loadOwned(actor, invocationId);
    if (isTerminalToolStatus(invocation.status)) return invocation;
    const requested = await this.options.invocations.save(
      { ...invocation, cancelRequested: true, updatedAt: this.clock() },
      [invocation.status],
    );
    this.controllers.get(invocationId)?.abort();
    if (requested.status === 'queued' || requested.status === 'proposed' || requested.status === 'validated' || requested.status === 'authorised' || requested.status === 'awaiting_approval') {
      return this.transition(requested, 'cancelled', {
        cancelConfirmed: true,
        failureReason: failure('cancelled', 'Invocation cancelled.', false),
      });
    }
    const definition = this.options.registry.tryGet(requested.toolId);
    const adapter = definition ? this.adapters.get(definition.adapter) : undefined;
    if (adapter?.cancel) {
      const result = await adapter.cancel({
        actor,
        invocation: requested,
        definition: definition!,
        signal: new AbortController().signal,
        jailRoot: this.jailRoot,
        limits: this.limits,
        secretNames: this.options.secretNames ?? [],
        jobs: this.options.jobs,
        env: this.options.env,
        recordEffect: async () => 'recorded',
        lookupEffect: async () => null,
      });
      if (!result.confirmed) {
        throw new ToolCancelUnconfirmedError();
      }
      return this.transition(requested, 'cancelled', {
        cancelConfirmed: true,
        failureReason: failure('cancelled', 'Invocation cancelled.', false),
      });
    }
    throw new ToolCancelUnconfirmedError();
  }

  async get(actor: ToolActor, id: string): Promise<ToolInvocation | null> {
    this.assertActor(actor);
    return this.options.invocations.get(actor.tenantId, id);
  }

  async listByConversation(actor: ToolActor, conversationId: string): Promise<ToolPresentation[]> {
    this.assertActor(actor);
    const rows = await this.options.invocations.listByConversation(actor.tenantId, conversationId);
    return Promise.all(rows.map((row) => this.present(actor, row)));
  }

  async listAwaiting(actor: ToolActor): Promise<ToolPresentation[]> {
    this.assertActor(actor);
    const rows = await this.options.invocations.listByStatus(actor.tenantId, ['awaiting_approval']);
    return Promise.all(rows.map((row) => this.present(actor, row)));
  }

  async present(actor: ToolActor, invocation: ToolInvocation): Promise<ToolPresentation> {
    this.assertActor(actor);
    if (invocation.tenantId !== actor.tenantId) {
      throw new ToolError('permission_denied', 'Permission denied.', false);
    }
    const definition = this.options.registry.tryGet(invocation.toolId);
    const approval = await this.options.approvals.getByInvocation(actor.tenantId, invocation.id);
    return presentTool(invocation, definition, approval);
  }

  async presentById(actor: ToolActor, id: string): Promise<ToolPresentation | null> {
    const invocation = await this.get(actor, id);
    if (!invocation) return null;
    return this.present(actor, invocation);
  }

  outputFor(_id: string): Record<string, unknown> | undefined {
    return undefined;
  }

  async resultFor(actor: ToolActor, id: string): Promise<Record<string, unknown> | null> {
    return this.options.invocations.getResult(actor.tenantId, id);
  }

  async reconcile(): Promise<ToolInvocation[]> {
    const out: ToolInvocation[] = await this.expireStaleApprovals(null);
    const pending = await this.options.invocations.listByStatus(null, [
      'proposed',
      'validated',
      'authorised',
      'queued',
      'running',
    ]);
    for (const invocation of pending) {
      if (invocation.status === 'running') {
        if (invocation.sideEffectClass === 'uncertain_external') {
          out.push(
            await this.transition(invocation, 'uncertain', {
              failureReason: failure(
                'interrupted_uncertain',
                'Interrupted during an uncertain external side effect; not retried.',
                false,
              ),
            }),
          );
          continue;
        }
        if (invocation.cancelRequested && !invocation.cancelConfirmed) {
          out.push(invocation);
          continue;
        }
        out.push(
          await this.transition(invocation, 'failed', {
            failureReason: failure('interrupted', 'Process restarted before the tool finished.', true),
          }),
        );
        continue;
      }
      if (invocation.status === 'queued' || invocation.status === 'authorised' || invocation.status === 'validated' || invocation.status === 'proposed') {
        out.push(invocation);
      }
    }
    return out;
  }

  private async executeAuthorised(
    actor: ToolActor,
    invocation: ToolInvocation,
    definition: ToolDefinition,
    signal?: AbortSignal,
  ): Promise<InvokeResult> {
    if (this.inFlight >= this.limits.maxToolConcurrency) {
      throw new ToolError('tool_concurrency', 'Fail-closed: tool concurrency ceiling reached.', true);
    }
    this.assertTenantQuota(actor.tenantId);
    const adapter = this.adapters.get(definition.adapter);
    if (!adapter) {
      const failed = await this.transition(invocation, 'failed', {
        failureReason: failure('adapter_missing', `No adapter for ${definition.adapter}.`, false),
      });
      return { invocation: failed, provenance: this.provenance(failed) };
    }
    if (signal?.aborted) {
      return this.terminaliseAbort(invocation, definition);
    }
    let current = invocation.status === 'queued' ? invocation : await this.transition(invocation, 'queued');
    if (signal?.aborted) {
      return this.terminaliseAbort(current, definition);
    }
    const attemptId = `tat_${randomUUID()}`;
    current = await this.transition(
      { ...current, attemptId, attemptCount: current.attemptCount + 1 },
      'running',
    );
    const controller = new AbortController();
    const unlinkParent = linkAbort(signal, controller);
    this.controllers.set(current.id, controller);
    this.inFlight += 1;
    const timeoutMs = effectiveToolTimeoutMs(definition, this.limits);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let childOwnsOccupancy = false;
    let occupancyReleased = false;
    const releaseOccupancy = (): void => {
      if (occupancyReleased) return;
      occupancyReleased = true;
      this.inFlight -= 1;
    };
    try {
      const executePromise = adapter.execute(current.arguments, {
        actor,
        invocation: current,
        definition,
        signal: controller.signal,
        jailRoot: this.jailRoot,
        limits: this.limits,
        secretNames: this.options.secretNames ?? [],
        jobs: this.options.jobs,
        env: this.options.env,
        recordEffect: (key, value) => this.recordEffect(actor.tenantId, key, value, current),
        lookupEffect: async () => null,
      });
      childOwnsOccupancy = true;
      void executePromise.then(releaseOccupancy, releaseOccupancy);
      const raced = await awaitOrAbort(executePromise, controller.signal);
      if (raced.status === 'aborted' || controller.signal.aborted) {
        if (signal?.aborted) {
          return this.terminaliseAbort(current, definition);
        }
        return this.terminaliseTimeout(current, definition);
      }
      const result = raced.value;
      const succeeded = await this.transition(current, 'succeeded', {
        resultRef: result.resultRef ?? `toolres:${current.id}`,
        artefactIds: result.artefactIds ?? [],
        fileIds: result.fileIds ?? [],
        externalIds: result.externalIds ?? [],
        jobId: result.jobId ?? current.jobId,
        cancelConfirmed: current.cancelRequested ? true : current.cancelConfirmed,
      });
      await this.options.invocations.saveResult(actor.tenantId, succeeded.id, result.output);
      await this.emit(succeeded, 'tool.succeeded');
      return { invocation: succeeded, output: result.output, provenance: this.provenance(succeeded) };
    } catch (err) {
      if (err instanceof DuplicateSideEffectError) {
        const uncertain = await this.transition(current, 'uncertain', {
          failureReason: failure(err.code, err.message, false),
        });
        return { invocation: uncertain, provenance: this.provenance(uncertain) };
      }
      if (err instanceof ToolCancelUnconfirmedError || isAbortError(err) || controller.signal.aborted) {
        if (signal?.aborted) {
          return this.terminaliseAbort(current, definition);
        }
        return this.terminaliseTimeout(current, definition);
      }
      const message = err instanceof Error ? err.message : String(err);
      const failed = await this.transition(current, 'failed', {
        failureReason: failure(err instanceof ToolError ? err.code : 'tool_failed', message, false),
      });
      return { invocation: failed, provenance: this.provenance(failed) };
    } finally {
      unlinkParent();
      clearTimeout(timeout);
      this.controllers.delete(current.id);
      if (!childOwnsOccupancy) releaseOccupancy();
    }
  }

  private async terminaliseAbort(
    invocation: ToolInvocation,
    definition: ToolDefinition,
  ): Promise<InvokeResult> {
    if (isTerminalToolStatus(invocation.status)) {
      return { invocation, provenance: this.provenance(invocation) };
    }
    if (isMutatingRunning(definition, invocation)) {
      const uncertain = await this.transition(invocation, 'uncertain', {
        cancelRequested: true,
        cancelConfirmed: false,
        failureReason: failure(
          'interrupted_uncertain',
          'Cancellation interrupted a mutating tool; completion is uncertain and requires reconciliation.',
          false,
        ),
      });
      return { invocation: uncertain, provenance: this.provenance(uncertain) };
    }
    const cancelled = await this.transition(invocation, 'cancelled', {
      cancelRequested: true,
      cancelConfirmed: true,
      failureReason: failure('cancelled', 'Invocation cancelled.', false),
    });
    return { invocation: cancelled, provenance: this.provenance(cancelled) };
  }

  private async terminaliseTimeout(
    invocation: ToolInvocation,
    definition: ToolDefinition,
  ): Promise<InvokeResult> {
    if (isTerminalToolStatus(invocation.status)) {
      return { invocation, provenance: this.provenance(invocation) };
    }
    if (isMutatingRunning(definition, invocation)) {
      const uncertain = await this.transition(invocation, 'uncertain', {
        failureReason: failure(
          'interrupted_uncertain',
          'Tool execution timed out during a mutating side effect; completion is uncertain and requires reconciliation.',
          false,
        ),
      });
      return { invocation: uncertain, provenance: this.provenance(uncertain) };
    }
    const timedOut = await this.transition(invocation, 'failed', {
      failureReason: failure('timeout', 'Tool execution timed out.', false),
    });
    return { invocation: timedOut, provenance: this.provenance(timedOut) };
  }

  private async countActivePendingApprovals(tenantId: string): Promise<number> {
    await this.expireStaleApprovals(tenantId);
    const pending = await this.options.invocations.listByStatus(tenantId, ['awaiting_approval']);
    return pending.length;
  }

  private async expireStaleApprovals(tenantId: string | null): Promise<ToolInvocation[]> {
    const pending = await this.options.invocations.listByStatus(tenantId, ['awaiting_approval']);
    const expired: ToolInvocation[] = [];
    const now = Date.now();
    for (const invocation of pending) {
      const approval = await this.options.approvals.getByInvocation(invocation.tenantId, invocation.id);
      if (!approval?.expiresAt) continue;
      const expiresAt = Date.parse(approval.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt > now) continue;
      if (isTerminalToolStatus(invocation.status)) continue;
      expired.push(
        await this.transition(invocation, 'denied', {
          failureReason: failure('approval_expired', 'Approval expired.', false),
        }),
      );
    }
    return expired;
  }

  private assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw createAbortError();
  }

  private async recordEffect(
    tenantId: string,
    key: string,
    value: unknown,
    invocation: ToolInvocation,
  ): Promise<'recorded' | 'replayed'> {
    if (invocation.sideEffectClass === 'uncertain_external' && invocation.attemptCount > 1) {
      throw new DuplicateSideEffectError();
    }
    return this.options.invocations.saveEffect(tenantId, key, value);
  }

  private lookupTool(toolId: string, pluginId?: string | null): ToolDefinition {
    const definition = this.options.registry.tryGet(toolId);
    if (!definition) throw new UnknownToolError(toolId);
    if (definition.pluginId) {
      const enabled = this.options.pluginEnabled?.(definition.pluginId) ?? true;
      if (!enabled || (pluginId && pluginId !== definition.pluginId)) {
        throw new ToolError('plugin_disabled', `Fail-closed: plugin ${definition.pluginId} is disabled or unknown.`, false);
      }
    }
    return definition;
  }

  private async createProposed(
    actor: ToolActor,
    request: InvokeRequest,
    definition: ToolDefinition,
    argumentHash: string,
    idempotencyKey: string | null,
  ): Promise<ToolInvocation> {
    const now = this.clock();
    const record: ToolInvocation = {
      id: request.callId?.trim() || `tinv_${randomUUID()}`,
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId ?? null,
      principalId: actor.principalId,
      conversationId: request.conversationId ?? null,
      executionId: request.executionId ?? null,
      jobId: null,
      pluginId: definition.pluginId ?? request.pluginId ?? null,
      toolId: definition.id,
      toolVersion: definition.version,
      status: 'proposed',
      arguments: request.arguments,
      argumentHash,
      idempotencyKey,
      attemptId: null,
      attemptCount: 0,
      approvalId: null,
      resultRef: null,
      artefactIds: [],
      fileIds: [],
      externalIds: [],
      failureReason: null,
      cancelRequested: false,
      cancelConfirmed: false,
      sideEffectClass: definition.sideEffectClass,
      provider: request.provider ?? null,
      model: request.model ?? null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
    };
    const saved = await this.options.invocations.insert(record);
    await this.emit(saved, 'tool.proposed');
    return saved;
  }

  private async validate(invocation: ToolInvocation, definition: ToolDefinition): Promise<ToolInvocation> {
    try {
      assertObjectSchema(definition.inputSchema, 'inputSchema');
      validateAgainstSchema(definition.inputSchema as JsonSchema, invocation.arguments);
    } catch (err) {
      return this.transition(invocation, 'failed', {
        failureReason: failure('invalid_arguments', err instanceof Error ? err.message : String(err), false),
      });
    }
    const validated = await this.transition(invocation, 'validated');
    await this.emit(validated, 'tool.validated');
    return validated;
  }

  private async authorise(actor: ToolActor, invocation: ToolInvocation, definition: ToolDefinition): Promise<ToolInvocation> {
    if (invocation.status === 'failed') return invocation;
    for (const capability of definition.requiredCapabilities) {
      const verdict = this.options.authority.decide({
        principal: {
          principalId: actor.principalId,
          kind: 'user',
          tenantId: actor.tenantId,
          workspaceId: actor.workspaceId ?? null,
        },
        capability,
        resource: {
          type: 'tool',
          id: definition.id,
          tenantId: actor.tenantId,
          workspaceId: actor.workspaceId ?? null,
        },
        fromPlugin: Boolean(definition.pluginId),
      });
      if (verdict.decision !== 'ALLOW') {
        const denied = await this.transition(invocation, 'denied', {
          failureReason: failure(verdict.reasonCode ?? 'capability_missing', verdict.message, false),
        });
        await this.emit(denied, 'tool.denied');
        return denied;
      }
    }
    const authorised = await this.transition(invocation, 'authorised');
    await this.emit(authorised, 'tool.authorised');
    return authorised;
  }

  private async suspendForApproval(invocation: ToolInvocation): Promise<ToolInvocation> {
    const approvalId = `tap_${randomUUID()}`;
    const nonceHash = sha256Stable({ invocationId: invocation.id, tenantId: invocation.tenantId, approvalId });
    const approval: ToolApproval = {
      id: approvalId,
      invocationId: invocation.id,
      tenantId: invocation.tenantId,
      decidedBy: '',
      decision: 'pending',
      reason: null,
      expiresAt: new Date(Date.now() + this.limits.approvalTtlMs).toISOString(),
      decidedAt: null,
      nonceHash,
    };
    await this.options.approvals.insert(approval);
    const awaiting = await this.transition({ ...invocation, approvalId }, 'awaiting_approval');
    await this.emit(awaiting, 'tool.awaiting_approval');
    return awaiting;
  }

  private async reuse(existing: ToolInvocation): Promise<InvokeResult> {
    if (existing.status === 'succeeded') {
      const output = await this.options.invocations.getResult(existing.tenantId, existing.id);
      return { invocation: existing, output: output ?? undefined, provenance: this.provenance(existing) };
    }
    if (existing.status === 'awaiting_approval' || existing.status === 'queued' || existing.status === 'running') {
      return { invocation: existing, provenance: this.provenance(existing) };
    }
    if (existing.sideEffectClass === 'uncertain_external') {
      throw new DuplicateSideEffectError();
    }
    return { invocation: existing, provenance: this.provenance(existing) };
  }

  private async loadOwned(actor: ToolActor, id: string): Promise<ToolInvocation> {
    const row = await this.options.invocations.get(actor.tenantId, id);
    if (!row) throw new ToolError('not_found', 'Permission denied.', false);
    if (actor.workspaceId && row.workspaceId && actor.workspaceId !== row.workspaceId) {
      throw new ToolError('not_found', 'Permission denied.', false);
    }
    return row;
  }

  private async transition(
    invocation: ToolInvocation,
    to: ToolInvocationStatus,
    patch: Partial<ToolInvocation> = {},
  ): Promise<ToolInvocation> {
    if (invocation.status !== to) assertToolTransition(invocation.status, to);
    const now = this.clock();
    const next: ToolInvocation = {
      ...invocation,
      ...patch,
      status: to,
      updatedAt: now,
      startedAt: to === 'running' ? (invocation.startedAt ?? now) : (patch.startedAt ?? invocation.startedAt),
      completedAt: isTerminalToolStatus(to) ? (patch.completedAt ?? now) : (patch.completedAt ?? invocation.completedAt),
    };
    return this.options.invocations.save(next, [invocation.status]);
  }

  private provenance(invocation: ToolInvocation): ToolProvenance {
    return {
      tenantId: invocation.tenantId,
      principalId: invocation.principalId,
      workspaceId: invocation.workspaceId,
      conversationId: invocation.conversationId ?? null,
      executionId: invocation.executionId ?? null,
      modelProvider: invocation.provider ?? null,
      model: invocation.model ?? null,
      toolId: invocation.toolId,
      toolVersion: invocation.toolVersion,
      argumentHash: invocation.argumentHash,
      approvalId: invocation.approvalId ?? null,
      resultRef: invocation.resultRef ?? null,
      artefactIds: invocation.artefactIds,
      outcome: invocation.status,
      externalIds: invocation.externalIds,
      attemptCount: invocation.attemptCount,
      createdAt: invocation.createdAt,
      completedAt: invocation.completedAt,
    };
  }

  private async emit(invocation: ToolInvocation, type: string): Promise<void> {
    logPlatform(type, {
      invocationId: invocation.id,
      tenantId: invocation.tenantId,
      principalId: invocation.principalId,
      toolId: invocation.toolId,
      status: invocation.status,
      conversationId: invocation.conversationId ?? null,
      executionId: invocation.executionId ?? null,
    });
    if (!this.options.events) return;
    await this.options.events.publish({
      channel: `tool:${invocation.id}`,
      type,
      payload: { invocationId: invocation.id, toolId: invocation.toolId, status: invocation.status },
      tenantId: invocation.tenantId,
      workspaceId: invocation.workspaceId,
      conversationId: invocation.conversationId ?? null,
      jobId: invocation.jobId ?? null,
      idempotencyKey: `tool:${invocation.id}:${type}`,
    });
  }

  private assertActor(actor: ToolActor): void {
    if (!actor.tenantId?.trim() || !actor.principalId?.trim()) {
      throw new AuthorityDeniedError({
        decision: 'DENY',
        capability: 'tool.invoke',
        reasonCode: 'unauthenticated',
        message: 'Permission denied.',
        leakSensitive: false,
      });
    }
  }

  private assertAccepting(): void {
    if (!this.accepting) throw new ToolError('shutting_down', 'Process is shutting down; new tool work is not accepted.', true);
  }

  private assertTenantQuota(tenantId: string): void {
    const quota = this.limits.perTenantToolInvocationsPerMinute;
    const now = Date.now();
    const hits = (this.quotaHits.get(tenantId) ?? []).filter((ts) => now - ts < 60_000);
    if (hits.length >= quota) {
      throw new ToolError('rate_limit', 'Fail-closed: tenant tool invocation quota exceeded.', true);
    }
    hits.push(now);
    this.quotaHits.set(tenantId, hits);
  }

  private async withApprovalMutex<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.approvalMutex.get(tenantId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.approvalMutex.set(
      tenantId,
      prior.then(
        () => gate,
        () => gate,
      ),
    );
    await prior.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export function presentTool(
  invocation: ToolInvocation,
  definition: ToolDefinition | null,
  approval: ToolApproval | null,
): ToolPresentation {
  const args = redactToolArguments(invocation.arguments);
  return {
    id: invocation.id,
    toolId: invocation.toolId,
    title: definition?.title ?? invocation.toolId,
    description: definition?.description ?? '',
    status: invocation.status,
    arguments: args,
    argumentSummary: summariseArguments(args),
    resource: resourceFromArguments(args) ?? invocation.workspaceId,
    conversationId: invocation.conversationId ?? null,
    executionId: invocation.executionId ?? null,
    workspaceId: invocation.workspaceId,
    sideEffectClass: invocation.sideEffectClass,
    approvalPolicy: definition?.approvalPolicy ?? 'required',
    requiredCapabilities: definition?.requiredCapabilities ?? [],
    risk: riskFromDefinition(definition, invocation.sideEffectClass),
    awaitingApproval: invocation.status === 'awaiting_approval',
    failureMessage: invocation.failureReason?.message ?? null,
    createdAt: invocation.createdAt,
    updatedAt: invocation.updatedAt,
    startedAt: invocation.startedAt,
    completedAt: invocation.completedAt,
    approval: approval
      ? {
          id: approval.id,
          decision: approval.decision,
          decidedBy: approval.decidedBy || null,
          decidedAt: approval.decidedAt ?? null,
          reason: approval.reason ?? null,
        }
      : null,
  };
}

function riskFromDefinition(definition: ToolDefinition | null, sideEffect: ToolInvocation['sideEffectClass']): ToolRisk {
  const caps = definition?.requiredCapabilities ?? [];
  if (caps.some((cap) => cap.startsWith('admin') || cap === 'secrets.use')) return 'admin';
  if (sideEffect === 'uncertain_external' || caps.some((cap) => cap.includes('external') || cap === 'publish.external')) {
    return 'external';
  }
  if (sideEffect !== 'none' || caps.some((cap) => cap.includes('write') || cap.includes('execute') || cap === 'browser.submit')) {
    return 'write';
  }
  return 'read';
}

function redactToolArguments(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (/secret|token|password|apikey|authorization|cookie/i.test(key)) {
      out[key] = '[redacted]';
    } else {
      out[key] = value;
    }
  }
  return out;
}

function summariseArguments(args: Record<string, unknown>): string {
  const parts = Object.entries(args).map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  return parts.join(', ') || '(no arguments)';
}

function resourceFromArguments(args: Record<string, unknown>): string | null {
  for (const key of ['path', 'url', 'target', 'file', 'resource']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function isMutatingRunning(definition: ToolDefinition, invocation: ToolInvocation): boolean {
  return definition.sideEffectClass !== 'none' && invocation.status === 'running';
}

/**
 * Catalogue timeouts are an upper bound per tool. ATLAS_TOOL_TIMEOUT_MS is a
 * process ceiling: it may shorten a definition, never lengthen one.
 */
export function effectiveToolTimeoutMs(definition: Pick<ToolDefinition, 'timeoutMs'>, limits: Pick<OperationalLimits, 'defaultToolTimeoutMs'>): number {
  return Math.min(definition.timeoutMs, limits.defaultToolTimeoutMs);
}

function needsApproval(definition: ToolDefinition): boolean {
  if (definition.approvalPolicy === 'required') return true;
  if (definition.approvalPolicy === 'required_if_external') {
    return definition.sideEffectClass !== 'none';
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(code: string, message: string, retryable: boolean) {
  return { code, message, retryable, at: new Date().toISOString() };
}

export function hashOpaque(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function linkAbort(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (!parent) return () => undefined;
  if (parent.aborted) {
    child.abort();
    return () => undefined;
  }
  const onAbort = () => child.abort();
  parent.addEventListener('abort', onAbort, { once: true });
  return () => parent.removeEventListener('abort', onAbort);
}

/**
 * Bound an adapter promise against AbortSignal so a non-settling execute()
 * cannot strand ToolEngine.invoke. The adapter may keep running; callers must
 * record a terminal invocation state before returning.
 */
function awaitOrAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<{ status: 'fulfilled'; value: T } | { status: 'aborted' }> {
  void promise.then(
    () => undefined,
    () => undefined,
  );
  if (signal.aborted) return Promise.resolve({ status: 'aborted' });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: { status: 'fulfilled'; value: T } | { status: 'aborted' }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => finish({ status: 'aborted' });
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish({ status: 'fulfilled', value }),
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
