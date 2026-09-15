import {
  DEFAULT_OPERATIONAL_LIMITS,
  type DependencyHealth,
  type HealthComponent,
  type OperationalLimits,
} from '@atlas-vnext/contracts';

export function readOperationalLimits(env: Record<string, string | undefined> = process.env): OperationalLimits {
  return {
    maxRequestBytes: num(env.ATLAS_MAX_REQUEST_BYTES, DEFAULT_OPERATIONAL_LIMITS.maxRequestBytes),
    maxUploadBytes: num(env.ATLAS_MAX_UPLOAD_BYTES, DEFAULT_OPERATIONAL_LIMITS.maxUploadBytes),
    maxConcurrentExecutions: num(env.ATLAS_MAX_CONCURRENT_EXECUTIONS, DEFAULT_OPERATIONAL_LIMITS.maxConcurrentExecutions),
    maxToolConcurrency: num(env.ATLAS_MAX_TOOL_CONCURRENCY, DEFAULT_OPERATIONAL_LIMITS.maxToolConcurrency),
    perTenantToolInvocationsPerMinute: num(
      env.ATLAS_TENANT_TOOL_QUOTA_PER_MINUTE,
      DEFAULT_OPERATIONAL_LIMITS.perTenantToolInvocationsPerMinute,
    ),
    maxContextTokens: num(env.ATLAS_MAX_CONTEXT_TOKENS, DEFAULT_OPERATIONAL_LIMITS.maxContextTokens),
    jobQueueMax: num(env.ATLAS_JOB_QUEUE_MAX, DEFAULT_OPERATIONAL_LIMITS.jobQueueMax),
    defaultToolTimeoutMs: num(env.ATLAS_TOOL_TIMEOUT_MS, DEFAULT_OPERATIONAL_LIMITS.defaultToolTimeoutMs),
    shellTimeoutMs: num(env.ATLAS_SHELL_TIMEOUT_MS, DEFAULT_OPERATIONAL_LIMITS.shellTimeoutMs),
    codeTimeoutMs: num(env.ATLAS_CODE_TIMEOUT_MS, DEFAULT_OPERATIONAL_LIMITS.codeTimeoutMs),
    maxShellOutputBytes: num(env.ATLAS_SHELL_OUTPUT_BYTES, DEFAULT_OPERATIONAL_LIMITS.maxShellOutputBytes),
    maxCodeOutputBytes: num(env.ATLAS_CODE_OUTPUT_BYTES, DEFAULT_OPERATIONAL_LIMITS.maxCodeOutputBytes),
    sessionTtlMs: num(env.ATLAS_SESSION_TTL_MS, DEFAULT_OPERATIONAL_LIMITS.sessionTtlMs),
    approvalTtlMs: num(env.ATLAS_APPROVAL_TTL_MS, DEFAULT_OPERATIONAL_LIMITS.approvalTtlMs),
  };
}

function num(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export interface HealthProbe {
  live(): boolean;
  dependencies(): Promise<DependencyHealth>;
}

export async function readiness(probe: HealthProbe): Promise<{
  ready: boolean;
  live: boolean;
  dependencies: DependencyHealth;
}> {
  const live = probe.live();
  const dependencies = await probe.dependencies();
  const ready = live && isReady(dependencies);
  return { ready, live, dependencies };
}

function isReady(deps: DependencyHealth): boolean {
  return (['postgres', 'cas', 'jobs', 'runtimeScheduler'] as const).every((key) => {
    const status: HealthComponent = deps[key];
    return status === 'ok' || status === 'not_configured' || status === 'degraded';
  });
}

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'",
};

export class ShutdownController {
  accepting = true;
  begin(): void {
    this.accepting = false;
  }
}
