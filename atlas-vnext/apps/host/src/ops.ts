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
    maxContextFiles: num(env.ATLAS_MAX_CONTEXT_FILES, DEFAULT_OPERATIONAL_LIMITS.maxContextFiles),
    maxRetrievalChunks: num(env.ATLAS_MAX_RETRIEVAL_CHUNKS, DEFAULT_OPERATIONAL_LIMITS.maxRetrievalChunks),
    maxGeneratedBytes: num(env.ATLAS_MAX_GENERATED_BYTES, DEFAULT_OPERATIONAL_LIMITS.maxGeneratedBytes),
    maxToolArgBytes: num(env.ATLAS_MAX_TOOL_ARG_BYTES, DEFAULT_OPERATIONAL_LIMITS.maxToolArgBytes),
    maxConcurrentStreams: num(env.ATLAS_MAX_CONCURRENT_STREAMS, DEFAULT_OPERATIONAL_LIMITS.maxConcurrentStreams),
    maxPendingApprovals: num(env.ATLAS_MAX_PENDING_APPROVALS, DEFAULT_OPERATIONAL_LIMITS.maxPendingApprovals),
    maxConcurrentRuns: num(env.ATLAS_MAX_CONCURRENT_RUNS, DEFAULT_OPERATIONAL_LIMITS.maxConcurrentRuns),
    maxToolRounds: num(env.ATLAS_MAX_TOOL_ROUNDS, DEFAULT_OPERATIONAL_LIMITS.maxToolRounds),
    maxExecutionMs: num(env.ATLAS_MAX_EXECUTION_MS, DEFAULT_OPERATIONAL_LIMITS.maxExecutionMs),
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

export async function readiness(
  probe: HealthProbe,
  production = false,
): Promise<{
  ready: boolean;
  live: boolean;
  dependencies: DependencyHealth;
}> {
  const live = probe.live();
  const dependencies = await probe.dependencies();
  const ready = live && isReady(dependencies, production);
  return { ready, live, dependencies };
}

function isReady(deps: DependencyHealth, production: boolean): boolean {
  const postgresOk = production ? deps.postgres === 'ok' : isOptionalOk(deps.postgres);
  const casOk = production ? deps.cas === 'ok' : isOptionalOk(deps.cas);
  const jobsOk = isOptionalOk(deps.jobs);
  const runtimeOk = isOptionalOk(deps.runtimeScheduler);
  return postgresOk && casOk && jobsOk && runtimeOk;
}

function isOptionalOk(status: HealthComponent): boolean {
  return status === 'ok' || status === 'not_configured' || status === 'degraded';
}

export function securityHeaders(options: { hsts?: boolean } = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  };
  if (options.hsts) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

export const SECURITY_HEADERS: Record<string, string> = securityHeaders();

export class ShutdownController {
  accepting = true;
  begin(): void {
    this.accepting = false;
  }
}
