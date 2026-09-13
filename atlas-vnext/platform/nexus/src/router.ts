import { randomUUID } from 'node:crypto';
import type {
  CapabilityAlias,
  CostClass,
  LatencyClass,
  RegisteredModel,
  RouteDecision,
} from '@atlas-vnext/contracts';
import { capabilityAliasSchema } from '@atlas-vnext/contracts';
import type { NexusRegistry } from './registry.ts';

export interface RouteRequest {
  requireTools?: boolean;
  requireVision?: boolean;
  requireReasoning?: boolean;
  requireCode?: boolean;
  contextTokens?: number;
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
    this.assertRequirements(registered, request);

    return {
      target,
      resolvedRouteId: target,
      provider,
      model,
      candidateChain: [target],
      localOnly: registered.locality === 'local',
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
    const pool = this.registry.list().filter((model) => this.registry.isRoutable(model));
    const localOnly = alias === 'nexus/local';
    let reason = '';

    let candidates = pool.filter((model) => {
      if (localOnly && model.locality !== 'local') return false;
      switch (alias) {
        case 'nexus/local':
          reason = 'Local-only policy';
          return model.locality === 'local';
        case 'nexus/reason':
          reason = 'Reasoning capability required';
          return model.capabilities.reasoning;
        case 'nexus/code':
          reason = 'Code capability required';
          return model.capabilities.code;
        case 'nexus/vision':
          reason = 'Vision capability required';
          return model.capabilities.vision;
        case 'nexus/fast':
          reason = 'Lowest-latency interactive path';
          return model.latencyClass === 'fast';
        case 'nexus/cheap':
          reason = 'Lowest cost class';
          return true;
        case 'nexus/frontier':
          reason = 'Frontier / high-capability path';
          return model.costClass === 'high' || model.capabilities.reasoning;
      }
    });

    candidates = candidates.filter((model) => this.matchesRequirements(model, request));

    if (alias === 'nexus/cheap') {
      candidates.sort((a, b) => costRank(a.costClass) - costRank(b.costClass));
    } else {
      candidates.sort((a, b) => {
        if (a.health === 'healthy' && b.health !== 'healthy') return -1;
        if (b.health === 'healthy' && a.health !== 'healthy') return 1;
        return latencyRank(a.latencyClass) - latencyRank(b.latencyClass);
      });
    }

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
      decisionReason: `${reason} → ${primary.provider}/${primary.model}`,
      traceId,
      evaluatedAt,
    };
  }

  private matchesRequirements(model: RegisteredModel, request: RouteRequest): boolean {
    if (request.requireTools && !model.capabilities.tools) return false;
    if (request.requireVision && !model.capabilities.vision) return false;
    if (request.requireReasoning && !model.capabilities.reasoning) return false;
    if (request.requireCode && !model.capabilities.code) return false;
    if (request.contextTokens && model.contextWindow < request.contextTokens) return false;
    return true;
  }

  private assertRequirements(model: RegisteredModel, request: RouteRequest): void {
    if (!this.matchesRequirements(model, request)) {
      if (request.contextTokens && model.contextWindow < request.contextTokens) {
        throw new Error(
          `Prompt size (${request.contextTokens}) exceeds context limit of ${model.provider}/${model.model} (${model.contextWindow}).`,
        );
      }
      throw new Error(`Model ${model.provider}/${model.model} does not meet route requirements.`);
    }
  }
}

function costRank(cost: CostClass): number {
  return { free: 0, low: 1, medium: 2, high: 3 }[cost];
}

function latencyRank(latency: LatencyClass): number {
  return { fast: 0, medium: 1, slow: 2 }[latency];
}
