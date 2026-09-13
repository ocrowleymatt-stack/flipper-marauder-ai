import { timingSafeEqual, createHash } from 'node:crypto';
import type {
  AiProviderType,
  INexusRouter,
  ProviderCallResult,
  RoutePromptOptions,
  SecurityContext,
  UserIdentity,
} from '@atlas/core-contracts';

// ============================================================================
// 1. Authentication & Token Verification (Dual Auth)
// ============================================================================

export interface AuthConfig {
  readonly proxySharedSecret?: string;
  readonly allowedOpsGroups?: readonly string[];
}

export class NexusAuthGateway {
  readonly #config: AuthConfig;

  constructor(config: AuthConfig) {
    this.#config = config;
  }

  verifyProxyIdentity(
    proxySecretHeader?: string,
    uidHeader?: string,
    emailHeader?: string,
    groupsHeader?: string,
  ): UserIdentity | null {
    if (!this.#config.proxySharedSecret || !proxySecretHeader || !uidHeader) {
      return null;
    }

    const expected = Buffer.from(this.#config.proxySharedSecret);
    const provided = Buffer.from(proxySecretHeader);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      return null;
    }

    const groups = (groupsHeader || '')
      .split(/[|,]/)
      .map((g) => g.trim().toLowerCase())
      .filter(Boolean);

    return {
      id: uidHeader.trim(),
      email: (emailHeader || '').trim(),
      displayName: uidHeader.trim(),
      groups,
      roles: groups.includes('admin') || groups.includes('operators') ? ['operator'] : ['user'],
    };
  }

  verifyApiToken(rawToken: string, storedHash: string): boolean {
    if (!rawToken || !rawToken.startsWith('ak_')) return false;
    const parts = rawToken.split('_');
    if (parts.length < 3) return false;

    const computedHash = createHash('sha256').update(rawToken).digest('hex');
    const computedBuf = Buffer.from(computedHash);
    const storedBuf = Buffer.from(storedHash);

    if (computedBuf.length !== storedBuf.length) return false;
    return timingSafeEqual(computedBuf, storedBuf);
  }
}

// ============================================================================
// 2. Token Bucket Rate Limiter
// ============================================================================

export class TokenBucketRateLimiter {
  readonly #capacity: number;
  readonly #refillTokensPerSecond: number;
  readonly #buckets = new Map<string, { tokens: number; lastRefillMs: number }>();

  constructor(capacity = 10, refillTokensPerSecond = 2) {
    this.#capacity = capacity;
    this.#refillTokensPerSecond = refillTokensPerSecond;
  }

  tryConsume(key: string, tokens = 1): boolean {
    const now = Date.now();
    let bucket = this.#buckets.get(key);

    if (!bucket) {
      bucket = { tokens: this.#capacity, lastRefillMs: now };
      this.#buckets.set(key, bucket);
    } else {
      const elapsedSec = (now - bucket.lastRefillMs) / 1000;
      const refilled = elapsedSec * this.#refillTokensPerSecond;
      bucket.tokens = Math.min(this.#capacity, bucket.tokens + refilled);
      bucket.lastRefillMs = now;
    }

    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens;
      return true;
    }
    return false;
  }
}

// ============================================================================
// 3. Nexus Router (Circuit Breaking, Cascade & Provider Routing)
// ============================================================================

export interface IProviderAdapter {
  readonly provider: AiProviderType;
  isAvailable(): Promise<boolean>;
  call(prompt: string, options?: RoutePromptOptions): Promise<ProviderCallResult>;
}

export class NexusRouter implements INexusRouter {
  readonly #providers = new Map<AiProviderType, IProviderAdapter>();
  readonly #circuitCooldownMs = 30_000;
  readonly #circuitFailures = new Map<AiProviderType, { lastFailureMs: number; count: number }>();

  registerProvider(adapter: IProviderAdapter): void {
    this.#providers.set(adapter.provider, adapter);
  }

  async routePrompt(prompt: string, options?: RoutePromptOptions): Promise<ProviderCallResult> {
    const primary = options?.primaryProvider || 'host';
    const fallbackAllowed = options?.fallbackAllowed !== false;

    const candidateOrder: AiProviderType[] = [
      primary,
      ...(['host', 'gemini', 'grok', 'openai', 'claude', 'venice', 'ollama'] as AiProviderType[]).filter(
        (p) => p !== primary,
      ),
    ];

    const attempts: string[] = [];

    for (const providerType of candidateOrder) {
      const adapter = this.#providers.get(providerType);
      if (!adapter) continue;

      // Check circuit breaker
      if (this.#isCircuitOpen(providerType)) {
        attempts.push(`${providerType}: circuit_open`);
        continue;
      }

      try {
        const result = await adapter.call(prompt, options);
        // Clear circuit breaker on success
        this.#circuitFailures.delete(providerType);
        return result;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        attempts.push(`${providerType}: ${msg}`);
        this.#recordCircuitFailure(providerType);

        if (!fallbackAllowed) {
          throw new Error(`Provider ${providerType} failed and fallback is disabled: ${msg}`);
        }
      }
    }

    throw new Error(`AI Router cascade exhausted all available providers. Attempts: [${attempts.join(', ')}]`);
  }

  async getProviderHealth(): Promise<Readonly<Record<AiProviderType, { available: boolean; latencyMs?: number }>>> {
    const health: Partial<Record<AiProviderType, { available: boolean; latencyMs?: number }>> = {};

    for (const [type, adapter] of this.#providers.entries()) {
      const start = Date.now();
      const available = !this.#isCircuitOpen(type) && (await adapter.isAvailable());
      health[type] = {
        available,
        latencyMs: Date.now() - start,
      };
    }

    return health as Record<AiProviderType, { available: boolean; latencyMs?: number }>;
  }

  #isCircuitOpen(provider: AiProviderType): boolean {
    const state = this.#circuitFailures.get(provider);
    if (!state) return false;
    if (state.count >= 3 && Date.now() - state.lastFailureMs < this.#circuitCooldownMs) {
      return true;
    }
    return false;
  }

  #recordCircuitFailure(provider: AiProviderType): void {
    const state = this.#circuitFailures.get(provider) || { count: 0, lastFailureMs: 0 };
    this.#circuitFailures.set(provider, {
      count: state.count + 1,
      lastFailureMs: Date.now(),
    });
  }
}
