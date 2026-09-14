import { randomUUID } from 'node:crypto';
import type {
  CapabilityAlias,
  CostClass,
  LatencyClass,
  RegisteredModel,
  RouteDecision,
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
}

/**
 * Policy plane: given a capability alias or explicit `provider/model`,
 * return an ordered candidate chain. Never talks to providers.
 */
export class NexusRouter {
  constructor(private readonly registry: NexusRegistry) {}

  resolve(target: string, request: RouteRequest = {}): RouteDecision {
    const traceId = request.traceId ?? `trc_${randomUUID()}`;
    const evaluatedAt = new Date().toISOString();

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
      throw new Error(`Invalid explicit route: ${target}`);
    }

    const registered = this.registry.get(provider, model);
    if (!registered) {
      throw new Error(`Model ${target} is not registered.`);
    }
    if (!this.registry.isRoutable(registered)) {
      throw new Error(`Model ${target} is not healthy.`);
    }
    this.assertPrivacy(registered, request, target);
    this.assertRequirements(registered, request);

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
    const pool = this.registry.list().filter((model) => this.registry.isRoutable(model));

    let candidates = pool.filter((model) => this.matchesAliasPolicy(model, policy));
    if (localOnly) {
      candidates = candidates.filter((model) => model.locality === 'local');
    }
    if (request.privacy === 'local_only') {
      candidates = candidates.filter((model) => model.privacyEligibility === 'local_only' || model.locality === 'local');
    }
    candidates = candidates.filter((model) => this.matchesRequirements(model, request));
    candidates = this.sortCandidates(candidates, policy.sort);

    const primary = candidates[0];
    if (!primary) {
      throw new Error(`No healthy candidates for ${alias}.`);
    }

    const candidateChain = candidates.map((model) => `${model.provider}/${model.model}`);
    return {
      target: alias,
      resolvedRouteId: `${primary.provider}/${primary.model}`,
      provider: primary.provider,
      model: primary.model,
      candidateChain,
      localOnly,
      locality: primary.locality,
      runtimeClass: primary.runtimeClass,
      decisionReason: `${policy.reason} → ${primary.provider}/${primary.model}`,
      traceId,
      evaluatedAt,
    };
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

  private matchesRequirements(model: RegisteredModel, request: RouteRequest): boolean {
    if (request.requireTools && !model.capabilities.tools) return false;
    if (request.requireVision && !model.capabilities.vision) return false;
    if (request.requireReasoning && !model.capabilities.reasoning) return false;
    if (request.requireCode && !model.capabilities.code) return false;
    if (request.contextTokens && model.contextWindow < request.contextTokens) return false;
    if (request.privacy === 'local_only' && model.locality !== 'local' && model.privacyEligibility !== 'local_only') {
      return false;
    }
    if (request.availableRuntimes && model.runtimeRequirements.length > 0) {
      if (!model.runtimeRequirements.every((requirement) => request.availableRuntimes!.includes(requirement))) {
        return false;
      }
    }
    return true;
  }

  private assertRequirements(model: RegisteredModel, request: RouteRequest): void {
    if (!this.matchesRequirements(model, request)) {
      if (request.contextTokens && model.contextWindow < request.contextTokens) {
        throw new Error(
          `Prompt size (${request.contextTokens}) exceeds context limit of ${model.provider}/${model.model} (${model.contextWindow}).`,
        );
      }
      if (request.availableRuntimes && model.runtimeRequirements.length > 0) {
        const missing = model.runtimeRequirements.filter((requirement) => !request.availableRuntimes!.includes(requirement));
        if (missing.length > 0) {
          throw new Error(`Model ${model.provider}/${model.model} requires runtime ${missing.join(', ')}.`);
        }
      }
      throw new Error(`Model ${model.provider}/${model.model} does not meet route requirements.`);
    }
  }

  private assertPrivacy(model: RegisteredModel, request: RouteRequest, target: string): void {
    if (request.privacy === 'local_only' && model.locality !== 'local' && model.privacyEligibility !== 'local_only') {
      throw new Error(`Model ${target} is not eligible under local-only privacy policy.`);
    }
  }
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
