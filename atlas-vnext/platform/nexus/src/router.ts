import { randomUUID } from 'node:crypto';
import type {
  CapabilityAlias,
  CostClass,
  LatencyClass,
  Locality,
  RegisteredModel,
  RejectedCandidate,
  RouteDecision,
  RoutingDelegation,
  RuntimeClass,
} from '@atlas-vnext/contracts';
import { capabilityAliasSchema } from '@atlas-vnext/contracts';
import { ALIAS_POLICIES } from './alias-policy.ts';
import type { NexusRegistry } from './registry.ts';

export interface RouteRequest {
  requireTools?: boolean;
  requireVision?: boolean;
  requireReasoning?: boolean;
  requireCode?: boolean;
  contextTokens?: number;
  /** Local-only privacy: cloud models are ineligible regardless of alias. */
  privacy?: 'any' | 'local_only';
  /** Satisfied runtime tags (provider ids, local engines). Host-supplied. */
  availableRuntimes?: string[];
  traceId?: string;
  /**
   * Auto / Power-Pod specialist-fallback. Not a registry alias key.
   * `auto` and `power-pod` targets also select this path.
   */
  delegation?: RoutingDelegation;
}

export class RouteResolutionError extends Error {
  readonly rejectedCandidates: RejectedCandidate[];

  constructor(message: string, rejectedCandidates: RejectedCandidate[] = []) {
    super(message);
    this.name = 'RouteResolutionError';
    this.rejectedCandidates = rejectedCandidates;
  }
}

/**
 * Policy plane: given a capability alias, Auto/Power-Pod delegation, or
 * explicit `provider/model`, return an ordered candidate chain. Never talks
 * to providers.
 */
export class NexusRouter {
  constructor(private readonly registry: NexusRegistry) {}

  resolve(target: string, request: RouteRequest = {}): RouteDecision {
    const traceId = request.traceId ?? `trc_${randomUUID()}`;
    const evaluatedAt = new Date().toISOString();
    const delegation = parseDelegation(target, request.delegation);

    if (delegation) {
      return this.resolveDelegation(delegation, target, request, traceId, evaluatedAt);
    }

    if (target.includes('/') && !target.startsWith('nexus/')) {
      return this.resolveExplicit(target, request, traceId, evaluatedAt);
    }

    const alias = capabilityAliasSchema.parse(target);
    return this.resolveAlias(alias, request, traceId, evaluatedAt);
  }

  private resolveExplicit(
    target: string,
    request: RouteRequest,
    traceId: string,
    evaluatedAt: string,
  ): RouteDecision {
    const slash = target.indexOf('/');
    const provider = target.slice(0, slash);
    const model = target.slice(slash + 1);
    if (!provider || !model) {
      throw new RouteResolutionError(`Invalid explicit route: ${target}`);
    }

    const registered = this.registry.get(provider, model);
    if (!registered) {
      throw new RouteResolutionError(`Model ${target} is not registered.`, [
        { provider, model, reason: 'not_registered' },
      ]);
    }
    const reason = this.rejectionReason(registered, request, { localOnly: request.privacy === 'local_only' });
    if (reason) {
      throw new RouteResolutionError(this.rejectionMessage(registered, request, reason, target), [
        { provider, model, reason },
      ]);
    }

    return {
      target,
      resolvedRouteId: target,
      provider,
      model,
      candidateChain: [target],
      localOnly: registered.locality === 'local' || request.privacy === 'local_only',
      locality: registered.locality,
      runtimeClass: registered.runtimeClass,
      decisionReason: `Explicit route ${target}`,
      traceId,
      evaluatedAt,
      rejectedCandidates: [],
    };
  }

  private resolveAlias(
    alias: CapabilityAlias,
    request: RouteRequest,
    traceId: string,
    evaluatedAt: string,
  ): RouteDecision {
    const policy = ALIAS_POLICIES[alias];
    const localOnly = alias === 'nexus/local' || request.privacy === 'local_only';
    const { eligible, rejected } = this.partition(request, {
      localOnly,
      aliasPolicy: policy,
    });
    const ranked = this.sortCandidates(eligible, policy.sort);
    const primary = ranked[0];
    if (!primary) {
      throw new RouteResolutionError(`No healthy candidates for ${alias}.`, rejected);
    }

    return {
      target: alias,
      resolvedRouteId: `${primary.provider}/${primary.model}`,
      provider: primary.provider,
      model: primary.model,
      candidateChain: ranked.map((model) => `${model.provider}/${model.model}`),
      localOnly,
      locality: primary.locality,
      runtimeClass: primary.runtimeClass,
      decisionReason: `${policy.reason} → ${primary.provider}/${primary.model}`,
      traceId,
      evaluatedAt,
      rejectedCandidates: rejected,
    };
  }

  /**
   * Auto / Power-Pod: specialist capability match + runtime ranking.
   * Not `ALIAS_POLICIES['auto']` and not a model id lookup.
   * Burst GPU stays last whenever local/private can satisfy.
   */
  private resolveDelegation(
    kind: RoutingDelegation,
    target: string,
    request: RouteRequest,
    traceId: string,
    evaluatedAt: string,
  ): RouteDecision {
    const localOnly = request.privacy === 'local_only';
    const { eligible, rejected } = this.partition(request, { localOnly });
    const ranked = this.sortDelegation(eligible, request, kind);
    const primary = ranked[0];
    if (!primary) {
      throw new RouteResolutionError(`No healthy candidates for ${kind}.`, rejected);
    }

    const specialist = specialistScore(primary, request);
    const reason =
      kind === 'power_pod'
        ? `Power-Pod specialist/fallback (burst GPU last if local/private can satisfy) → ${primary.provider}/${primary.model}`
        : specialist > 0
          ? `Auto specialist/fallback → ${primary.provider}/${primary.model}`
          : `Auto fallback (no specialist constraint) → ${primary.provider}/${primary.model}`;

    return {
      target,
      resolvedRouteId: `${primary.provider}/${primary.model}`,
      provider: primary.provider,
      model: primary.model,
      candidateChain: ranked.map((model) => `${model.provider}/${model.model}`),
      localOnly,
      locality: primary.locality,
      runtimeClass: primary.runtimeClass,
      decisionReason: reason,
      traceId,
      evaluatedAt,
      rejectedCandidates: rejected,
      delegation: kind,
    };
  }

  private partition(
    request: RouteRequest,
    opts: { localOnly: boolean; aliasPolicy?: (typeof ALIAS_POLICIES)[CapabilityAlias] },
  ): { eligible: RegisteredModel[]; rejected: RejectedCandidate[] } {
    const eligible: RegisteredModel[] = [];
    const rejected: RejectedCandidate[] = [];
    for (const model of this.registry.list()) {
      const reason = this.rejectionReason(model, request, opts);
      if (reason) {
        rejected.push({ provider: model.provider, model: model.model, reason });
      } else {
        eligible.push(model);
      }
    }
    return { eligible, rejected };
  }

  private rejectionReason(
    model: RegisteredModel,
    request: RouteRequest,
    opts: { localOnly: boolean; aliasPolicy?: (typeof ALIAS_POLICIES)[CapabilityAlias] },
  ): string | null {
    if (this.registry.isDisabled(model.provider)) return 'operator_disabled';
    if (!this.registry.isRoutable(model)) return `unhealthy:${model.health}`;
    if (opts.localOnly && model.locality !== 'local') return 'privacy_local_only';
    if (request.privacy === 'local_only' && model.locality === 'public_cloud') return 'privacy_local_only';
    if (
      request.privacy === 'local_only' &&
      model.locality !== 'local' &&
      model.privacyEligibility !== 'local_only'
    ) {
      return 'privacy_local_only';
    }
    if (opts.aliasPolicy && !this.matchesAliasPolicy(model, opts.aliasPolicy)) return 'alias_mismatch';
    if (request.requireTools && !model.capabilities.tools) return 'requirements_unmet:tools';
    if (request.requireVision && !model.capabilities.vision) return 'requirements_unmet:vision';
    if (request.requireReasoning && !model.capabilities.reasoning) return 'requirements_unmet:reasoning';
    if (request.requireCode && !model.capabilities.code) return 'requirements_unmet:code';
    if (request.contextTokens && model.contextWindow < request.contextTokens) return 'context_overflow';
    if (request.availableRuntimes && model.runtimeRequirements.length > 0) {
      const missing = model.runtimeRequirements.filter(
        (requirement) => !request.availableRuntimes!.includes(requirement),
      );
      if (missing.length > 0) return `runtime_unavailable:${missing.join(',')}`;
    }
    return null;
  }

  private rejectionMessage(
    model: RegisteredModel,
    request: RouteRequest,
    reason: string,
    target: string,
  ): string {
    if (reason === 'privacy_local_only') {
      return `Model ${target} is not eligible under local-only privacy policy.`;
    }
    if (reason === 'context_overflow') {
      return `Prompt size (${request.contextTokens}) exceeds context limit of ${model.provider}/${model.model} (${model.contextWindow}).`;
    }
    if (reason.startsWith('runtime_unavailable:')) {
      return `Model ${model.provider}/${model.model} requires runtime ${reason.slice('runtime_unavailable:'.length)}.`;
    }
    if (reason.startsWith('unhealthy:')) {
      return `Model ${target} is not healthy.`;
    }
    return `Model ${model.provider}/${model.model} does not meet route requirements.`;
  }

  private matchesAliasPolicy(model: RegisteredModel, policy: (typeof ALIAS_POLICIES)[CapabilityAlias]): boolean {
    if (policy.locality && model.locality !== policy.locality) return false;
    if (policy.requireLatencyClass && model.latencyClass !== policy.requireLatencyClass) return false;
    if (policy.requireCapabilities) {
      for (const cap of policy.requireCapabilities) {
        if (!model.capabilities[cap]) return false;
      }
    }
    if (policy.frontier) {
      return model.costClass === 'high' || model.capabilities.reasoning;
    }
    return true;
  }

  private sortCandidates(candidates: RegisteredModel[], sort: 'latency' | 'cost'): RegisteredModel[] {
    return [...candidates].sort((a, b) => {
      const byRuntime = runtimeRank(a.runtimeClass) - runtimeRank(b.runtimeClass);
      if (byRuntime !== 0) return byRuntime;
      if (sort === 'cost') {
        const byCost = costRank(a.costClass) - costRank(b.costClass);
        if (byCost !== 0) return byCost;
      }
      if (a.health === 'healthy' && b.health !== 'healthy') return -1;
      if (b.health === 'healthy' && a.health !== 'healthy') return 1;
      return latencyRank(a.latencyClass) - latencyRank(b.latencyClass);
    });
  }

  private sortDelegation(
    candidates: RegisteredModel[],
    request: RouteRequest,
    kind: RoutingDelegation,
  ): RegisteredModel[] {
    return [...candidates].sort((a, b) => {
      const bySpecialist = specialistScore(b, request) - specialistScore(a, request);
      if (bySpecialist !== 0) return bySpecialist;
      const byRuntime = runtimeRank(a.runtimeClass) - runtimeRank(b.runtimeClass);
      if (byRuntime !== 0) return byRuntime;
      const byLocality = localityRank(a.locality) - localityRank(b.locality);
      if (byLocality !== 0) return byLocality;
      if (kind === 'power_pod') {
        const byBurst = Number(a.runtimeClass === 'expensive_burst') - Number(b.runtimeClass === 'expensive_burst');
        if (byBurst !== 0) return byBurst;
      }
      if (a.health === 'healthy' && b.health !== 'healthy') return -1;
      if (b.health === 'healthy' && a.health !== 'healthy') return 1;
      return latencyRank(a.latencyClass) - latencyRank(b.latencyClass);
    });
  }
}

function parseDelegation(target: string, requested?: RoutingDelegation): RoutingDelegation | undefined {
  const normalised = target.trim().toLowerCase().replace(/_/g, '-');
  if (normalised === 'auto' || normalised === 'nexus/auto') return 'auto';
  if (normalised === 'power-pod' || normalised === 'powerpod' || normalised === 'nexus/power-pod') {
    return 'power_pod';
  }
  if (requested && !target.startsWith('nexus/') && !target.includes('/')) return requested;
  return undefined;
}

function specialistScore(model: RegisteredModel, request: RouteRequest): number {
  let score = 0;
  if (request.requireVision && model.capabilities.vision) score += 8;
  if (request.requireCode && model.capabilities.code) score += 8;
  if (request.requireReasoning && model.capabilities.reasoning) score += 8;
  if (request.requireTools && model.capabilities.tools) score += 4;
  return score;
}

function costRank(cost: CostClass): number {
  return { free: 0, low: 1, medium: 2, high: 3 }[cost];
}

function latencyRank(latency: LatencyClass): number {
  return { fast: 0, medium: 1, slow: 2 }[latency];
}

/** Prefer local/private always-on capacity over waking a paid burst GPU. */
function runtimeRank(runtime: RuntimeClass): number {
  return { always_available: 0, private_hosted: 1, on_demand: 2, expensive_burst: 3 }[runtime];
}

function localityRank(locality: Locality): number {
  return { local: 0, private_cloud: 1, public_cloud: 2 }[locality];
}
