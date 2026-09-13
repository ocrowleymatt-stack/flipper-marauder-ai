import { randomUUID } from 'node:crypto';

import {
  type CapabilityAlias,
  type CostClass,
  type LatencyClass,
  type ModelRecord,
  type ProviderRegistry,
  type RouteCandidate,
  type RouteDecision,
  type RouteErrorCode,
  type RouteExclusion,
  type RoutePolicy,
  type RouteRequest,
  type RouteRequirements,
  type RouteTrace,
  capabilityAliasSchema,
  routeRequestSchema,
} from '@atlas/contracts';

const COST_RANK: Record<CostClass, number> = { zero: 0, low: 1, medium: 2, high: 3 };
const LATENCY_RANK: Record<LatencyClass, number> = { low: 0, medium: 1, high: 2 };

type AliasPolicy = {
  requirements: RouteRequirements;
  localOnly?: boolean;
  costPreference?: RoutePolicy['costPreference'];
  preferLatency?: boolean;
};

/**
 * Alias behaviour is data. Adding a model does not require editing this table;
 * adding a *new alias* does.
 */
export const ALIAS_POLICIES: Record<CapabilityAlias, AliasPolicy> = {
  'nexus/fast': { requirements: { text: true }, preferLatency: true, costPreference: 'cheapest' },
  'nexus/reason': { requirements: { reasoning: true } },
  'nexus/code': { requirements: { code: true, tools: true } },
  'nexus/vision': { requirements: { vision: true } },
  'nexus/cheap': { requirements: { text: true }, costPreference: 'cheapest' },
  'nexus/local': { requirements: { text: true }, localOnly: true },
  'nexus/frontier': { requirements: { reasoning: true }, costPreference: 'frontier' },
};

export class RouteError extends Error {
  readonly code: RouteErrorCode;

  constructor(code: RouteErrorCode, message: string) {
    super(message);
    this.name = 'RouteError';
    this.code = code;
  }
}

function modelKey(model: Pick<ModelRecord, 'providerId' | 'id'>): string {
  return `${model.providerId}/${model.id}`;
}

function mergeRequirements(base: RouteRequirements, extra?: RouteRequirements): RouteRequirements {
  return {
    text: Boolean(base.text || extra?.text),
    reasoning: Boolean(base.reasoning || extra?.reasoning),
    tools: Boolean(base.tools || extra?.tools),
    vision: Boolean(base.vision || extra?.vision),
    code: Boolean(base.code || extra?.code),
    minContextWindow: Math.max(base.minContextWindow ?? 0, extra?.minContextWindow ?? 0) || undefined,
  };
}

function providerHealth(registry: ProviderRegistry, providerId: string) {
  return registry.providers.find((provider) => provider.id === providerId)?.health;
}

function exclusionFor(
  model: ModelRecord,
  registry: ProviderRegistry,
  requirements: RouteRequirements,
  localOnly: boolean,
  includeFlagged: boolean,
): RouteExclusion['reason'] | null {
  const parent = providerHealth(registry, model.providerId);
  if (model.health === 'unhealthy' || parent === 'unhealthy') return 'unhealthy';
  if (localOnly && model.locality !== 'local') return 'locality';
  if (model.flagged && !includeFlagged) return 'flagged';
  if (requirements.text && !model.capabilities.text) return 'capability';
  if (requirements.reasoning && !model.capabilities.reasoning) return 'capability';
  if (requirements.tools && !model.capabilities.tools) return 'capability';
  if (requirements.vision && !model.capabilities.vision) return 'capability';
  if (requirements.code && !model.capabilities.code) return 'capability';
  if (requirements.minContextWindow && model.contextWindow < requirements.minContextWindow) {
    return 'context_window';
  }
  return null;
}

function rank(model: ModelRecord, policy: AliasPolicy): number {
  const degraded = model.health === 'healthy' ? 0 : 10_000;
  let score = degraded;
  if (policy.preferLatency) score += LATENCY_RANK[model.latencyClass] * 100;
  const preference = policy.costPreference ?? 'balanced';
  if (preference === 'cheapest') score += COST_RANK[model.costClass] * 10;
  else if (preference === 'frontier') score += (3 - COST_RANK[model.costClass]) * 100;
  else score += COST_RANK[model.costClass] + LATENCY_RANK[model.latencyClass];
  return score;
}

function newTraceId(requested?: string): string {
  return requested ?? `trc_${randomUUID()}`;
}

function emptyTrace(partial: Omit<RouteTrace, 'schemaVersion' | 'attempted' | 'excluded' | 'selected' | 'ts'> & Partial<Pick<RouteTrace, 'attempted' | 'excluded' | 'selected'>>): RouteTrace {
  return {
    schemaVersion: 1,
    attempted: partial.attempted ?? [],
    excluded: partial.excluded ?? [],
    selected: partial.selected ?? [],
    ts: new Date().toISOString(),
    traceId: partial.traceId,
    alias: partial.alias,
    explicit: partial.explicit,
    aliasIgnored: partial.aliasIgnored,
  };
}

/**
 * Configuration-driven router. Reads a registry; never calls a provider.
 */
export class NexusRouter {
  constructor(private registry: ProviderRegistry) {}

  replaceRegistry(registry: ProviderRegistry): void {
    this.registry = registry;
  }

  resolve(input: RouteRequest): RouteDecision {
    const parsed = routeRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new RouteError('route.invalid_request', parsed.error.issues[0]?.message ?? 'Invalid route request');
    }
    const request = parsed.data;
    const traceId = newTraceId(request.traceId);

    if (request.explicit) {
      return this.resolveExplicit(request, traceId);
    }

    const aliasParse = capabilityAliasSchema.safeParse(request.alias);
    if (!aliasParse.success || !request.alias) {
      throw new RouteError('route.unknown_alias', `Unknown alias: ${request.alias ?? '(missing)'}`);
    }
    return this.resolveAlias(request, aliasParse.data, traceId);
  }

  private resolveExplicit(request: RouteRequest, traceId: string): RouteDecision {
    const target = request.explicit!;
    const localOnly = request.policy?.localOnly === true;
    const includeFlagged = request.policy?.includeFlagged === true;
    const requirements = request.requirements ?? {};
    const model = this.registry.models.find(
      (candidate) => candidate.providerId === target.providerId && candidate.id === target.modelId,
    );
    const traceBase = {
      traceId,
      alias: request.alias ?? null,
      explicit: target,
      aliasIgnored: Boolean(request.alias),
    };

    if (!model) {
      throw new RouteError('route.unknown_target', `Unknown target ${target.providerId}/${target.modelId}`);
    }

    const parent = providerHealth(this.registry, model.providerId);
    if (model.health === 'unhealthy' || parent === 'unhealthy') {
      throw new RouteError(
        'route.explicit_unhealthy',
        `Explicit target ${modelKey(model)} is unhealthy`,
      );
    }
    if (localOnly && model.locality !== 'local') {
      throw new RouteError('route.locality_violation', `Explicit target ${modelKey(model)} is not local`);
    }
    const excluded = exclusionFor(model, this.registry, requirements, localOnly, includeFlagged);
    if (excluded === 'capability' || excluded === 'context_window') {
      throw new RouteError('route.capability_mismatch', `Explicit target ${modelKey(model)} fails ${excluded}`);
    }
    if (excluded === 'flagged') {
      throw new RouteError('route.capability_mismatch', `Explicit target ${modelKey(model)} is flagged`);
    }

    const candidate: RouteCandidate = {
      providerId: model.providerId,
      modelId: model.id,
      reason: 'explicit',
    };
    const trace = emptyTrace({
      ...traceBase,
      attempted: [modelKey(model)],
      selected: [modelKey(model)],
    });
    return { schemaVersion: 1, candidates: [candidate], trace };
  }

  private resolveAlias(request: RouteRequest, alias: CapabilityAlias, traceId: string): RouteDecision {
    const policy = ALIAS_POLICIES[alias];
    const requirements = mergeRequirements(policy.requirements, request.requirements);
    const localOnly = policy.localOnly === true || request.policy?.localOnly === true;
    const includeFlagged = request.policy?.includeFlagged === true;
    const effective: AliasPolicy = {
      ...policy,
      localOnly,
      costPreference: request.policy?.costPreference ?? policy.costPreference,
    };

    const excluded: RouteExclusion[] = [];
    const eligible: ModelRecord[] = [];
    const attempted: string[] = [];

    for (const model of this.registry.models) {
      attempted.push(modelKey(model));
      const reason = exclusionFor(model, this.registry, requirements, localOnly, includeFlagged);
      if (reason) {
        excluded.push({ providerId: model.providerId, modelId: model.id, reason });
        continue;
      }
      eligible.push(model);
    }

    eligible.sort((left, right) => {
      const delta = rank(left, effective) - rank(right, effective);
      if (delta !== 0) return delta;
      return modelKey(left).localeCompare(modelKey(right));
    });

    if (eligible.length === 0) {
      const localityOnly = localOnly && excluded.every((item) => item.reason === 'locality' || item.reason === 'unhealthy');
      throw new RouteError(
        localityOnly ? 'route.locality_violation' : 'route.no_candidate',
        `No candidate for ${alias}`,
      );
    }

    const candidates = eligible.map((model, index) => ({
      providerId: model.providerId,
      modelId: model.id,
      reason: index === 0 ? `alias:${alias}:primary` : `alias:${alias}:fallback`,
    }));

    const trace = emptyTrace({
      traceId,
      alias,
      explicit: null,
      aliasIgnored: false,
      attempted,
      excluded,
      selected: candidates.map((candidate) => `${candidate.providerId}/${candidate.modelId}`),
    });

    return { schemaVersion: 1, candidates, trace };
  }
}
