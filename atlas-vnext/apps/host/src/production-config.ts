/**
 * Production configuration contract.
 *
 * Classifies every host-consumed variable. Production fails loud on missing
 * critical config and refuses silent development defaults (JSON file store,
 * mock providers, wildcard CORS, unsigned sessions).
 */

export type ConfigClass = 'required' | 'optional' | 'dev' | 'secret';

export interface ConfigVarSpec {
  name: string;
  classification: ConfigClass;
  production: 'required' | 'optional' | 'forbidden' | 'ignored';
  description: string;
}

export const PRODUCTION_CONFIG_CATALOGUE: ConfigVarSpec[] = [
  { name: 'NODE_ENV', classification: 'required', production: 'required', description: 'Must be production for the production contract.' },
  { name: 'ATLAS_ENV', classification: 'optional', production: 'optional', description: 'Alias that also selects production when set to production.' },
  { name: 'ATLAS_PERSISTENCE', classification: 'required', production: 'required', description: 'Must be postgres. Implied by NODE_ENV=production.' },
  { name: 'ATLAS_DATABASE_URL', classification: 'secret', production: 'required', description: 'PostgreSQL URL. DATABASE_URL is accepted as an alias.' },
  { name: 'DATABASE_URL', classification: 'secret', production: 'optional', description: 'Alias for ATLAS_DATABASE_URL.' },
  { name: 'ATLAS_TENANT_ID', classification: 'required', production: 'required', description: 'Host tenant. No silent tenant_local default in production.' },
  { name: 'ATLAS_SESSION_SECRET', classification: 'secret', production: 'required', description: 'Signs session CSRF tokens. Never log or ship to the browser.' },
  { name: 'ATLAS_ALLOWED_ORIGINS', classification: 'required', production: 'required', description: 'Comma-separated exact origins. Wildcard is forbidden with credentials.' },
  { name: 'ATLAS_CAS_ROOT', classification: 'required', production: 'required', description: 'Filesystem CAS root. Production cannot use an implicit temp directory.' },
  { name: 'ATLAS_BIND_HOST', classification: 'optional', production: 'optional', description: 'Listen address. Default 127.0.0.1; set explicitly to expose beyond loopback.' },
  { name: 'PORT', classification: 'optional', production: 'optional', description: 'HTTP port. Default 8787.' },
  { name: 'ATLAS_PRINCIPAL_ID', classification: 'optional', production: 'optional', description: 'Bootstrap principal id for the host tenant.' },
  { name: 'ATLAS_VNEXT_STATIC', classification: 'optional', production: 'optional', description: 'Frontend dist directory.' },
  { name: 'ATLAS_VNEXT_DATA', classification: 'dev', production: 'forbidden', description: 'JSON file store path. Forbidden in production.' },
  { name: 'ATLAS_USE_MOCK_PROVIDERS', classification: 'dev', production: 'forbidden', description: 'In-process mock providers. Forbidden in production.' },
  { name: 'ATLAS_TLS', classification: 'optional', production: 'optional', description: 'Set to 1 to emit HSTS when serving HTTPS.' },
  { name: 'ATLAS_DB_POOL_MAX', classification: 'optional', production: 'optional', description: 'pg pool size.' },
  { name: 'ATLAS_DB_IDLE_TIMEOUT_MS', classification: 'optional', production: 'optional', description: 'Idle client timeout.' },
  { name: 'ATLAS_DB_CONNECT_TIMEOUT_MS', classification: 'optional', production: 'optional', description: 'Connect timeout. No infinite retry.' },
  { name: 'ATLAS_DB_STATEMENT_TIMEOUT_MS', classification: 'optional', production: 'optional', description: 'Statement timeout.' },
  { name: 'ATLAS_DB_SCHEMA', classification: 'optional', production: 'optional', description: 'Optional PostgreSQL schema.' },
  { name: 'ATLAS_PROVIDER_TIMEOUT_MS', classification: 'optional', production: 'optional', description: 'Provider HTTP timeout.' },
  { name: 'ATLAS_TOOL_TIMEOUT_MS', classification: 'optional', production: 'optional', description: 'Default tool timeout.' },
  { name: 'ATLAS_STREAM_IDLE_TIMEOUT_MS', classification: 'optional', production: 'optional', description: 'Abort SSE when no event is written.' },
  { name: 'ATLAS_STARTUP_TIMEOUT_MS', classification: 'optional', production: 'optional', description: 'Fail startup if deps are not ready in time.' },
  { name: 'ATLAS_SHUTDOWN_TIMEOUT_MS', classification: 'optional', production: 'optional', description: 'Force-exit after graceful drain.' },
  { name: 'ATLAS_HTTP_TIMEOUT_MS', classification: 'optional', production: 'optional', description: 'Inbound HTTP timeout.' },
  { name: 'ATLAS_FLAG_TOOLS', classification: 'optional', production: 'optional', description: 'Kill switch for tools. Not Authority.' },
  { name: 'ATLAS_FLAG_GENERATION', classification: 'optional', production: 'optional', description: 'Kill switch for generation/runs.' },
  { name: 'ATLAS_FLAG_DUNGEON_WRITING', classification: 'optional', production: 'optional', description: 'Kill switch for Caspa writing.' },
  { name: 'ATLAS_KILL_PROVIDERS', classification: 'optional', production: 'optional', description: 'Comma-separated provider disable list. Not a fallback chain.' },
  { name: 'OPENAI_API_KEY', classification: 'secret', production: 'optional', description: 'Marks OpenAI unavailable when missing. Does not crash the host.' },
  { name: 'ANTHROPIC_API_KEY', classification: 'secret', production: 'optional', description: 'Optional provider credential.' },
  { name: 'GEMINI_API_KEY', classification: 'secret', production: 'optional', description: 'Optional provider credential.' },
  { name: 'XAI_API_KEY', classification: 'secret', production: 'optional', description: 'Optional provider credential.' },
  { name: 'VENICE_API_KEY', classification: 'secret', production: 'optional', description: 'Optional provider credential.' },
  { name: 'RUNPOD_API_KEY', classification: 'secret', production: 'optional', description: 'Optional RunPod credential.' },
  { name: 'FORGE_API_KEY', classification: 'secret', production: 'optional', description: 'Optional Forge credential.' },
];

export class ProductionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductionConfigError';
  }
}

export interface TimeoutContract {
  httpMs: number;
  providerMs: number;
  runpodWarmMs: number;
  dbConnectMs: number;
  dbStatementMs: number;
  toolMs: number;
  streamIdleMs: number;
  startupMs: number;
  shutdownMs: number;
}

export interface ProductionHostConfig {
  production: boolean;
  persistenceMode: 'postgres' | 'file' | 'memory';
  databaseUrl: string | null;
  tenantId: string | null;
  sessionSecretPresent: boolean;
  allowedOrigins: string[];
  casRoot: string | null;
  bindHost: string;
  port: number;
  mockProviders: boolean;
  hsts: boolean;
  timeouts: TimeoutContract;
}

export function isProductionEnv(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === 'production' || env.ATLAS_ENV === 'production';
}

export function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function readTimeoutContract(env: Record<string, string | undefined> = process.env): TimeoutContract {
  return {
    httpMs: positive(env.ATLAS_HTTP_TIMEOUT_MS, 60_000),
    providerMs: positive(env.ATLAS_PROVIDER_TIMEOUT_MS, 60_000),
    runpodWarmMs: positive(env.RUNPOD_WARM_TIMEOUT_MS, 180_000),
    dbConnectMs: positive(env.ATLAS_DB_CONNECT_TIMEOUT_MS, 5_000),
    dbStatementMs: positive(env.ATLAS_DB_STATEMENT_TIMEOUT_MS, 30_000),
    toolMs: positive(env.ATLAS_TOOL_TIMEOUT_MS, 30_000),
    streamIdleMs: positive(env.ATLAS_STREAM_IDLE_TIMEOUT_MS, 120_000),
    startupMs: positive(env.ATLAS_STARTUP_TIMEOUT_MS, 30_000),
    shutdownMs: positive(env.ATLAS_SHUTDOWN_TIMEOUT_MS, 15_000),
  };
}

export function readProductionHostConfig(
  env: Record<string, string | undefined> = process.env,
): ProductionHostConfig {
  const production = isProductionEnv(env);
  const mockProviders = env.ATLAS_USE_MOCK_PROVIDERS === '1';
  const persistenceRaw = (env.ATLAS_PERSISTENCE ?? '').trim().toLowerCase();
  const persistenceMode: ProductionHostConfig['persistenceMode'] =
    persistenceRaw === 'postgres' || persistenceRaw === 'postgresql' || persistenceRaw === 'pg'
      ? 'postgres'
      : persistenceRaw === 'memory'
        ? 'memory'
        : persistenceRaw === 'file'
          ? 'file'
          : production
            ? 'postgres'
            : 'file';
  const databaseUrl = trim(env.ATLAS_DATABASE_URL) ?? trim(env.DATABASE_URL);
  const tenantId = trim(env.ATLAS_TENANT_ID) ?? (production ? null : 'tenant_local');
  const allowedOrigins = parseOrigins(env.ATLAS_ALLOWED_ORIGINS);
  const casRoot = trim(env.ATLAS_CAS_ROOT);
  const bindHost = trim(env.ATLAS_BIND_HOST) ?? '127.0.0.1';
  const port = Number(env.PORT ?? 8787);

  if (production) {
    const missing: string[] = [];
    if (persistenceMode !== 'postgres') {
      throw new ProductionConfigError(
        'Production refuses non-PostgreSQL persistence. Set ATLAS_PERSISTENCE=postgres.',
      );
    }
    if (!databaseUrl) missing.push('ATLAS_DATABASE_URL');
    if (!tenantId) missing.push('ATLAS_TENANT_ID');
    if (!trim(env.ATLAS_SESSION_SECRET)) missing.push('ATLAS_SESSION_SECRET');
    if (allowedOrigins.length === 0) missing.push('ATLAS_ALLOWED_ORIGINS');
    if (!casRoot) missing.push('ATLAS_CAS_ROOT');
    if (missing.length) {
      throw new ProductionConfigError(
        `Production is missing critical configuration: ${missing.join(', ')}. No silent development defaults.`,
      );
    }
    if (mockProviders) {
      throw new ProductionConfigError('Production forbids ATLAS_USE_MOCK_PROVIDERS=1.');
    }
    if (trim(env.ATLAS_VNEXT_DATA)) {
      throw new ProductionConfigError('Production forbids ATLAS_VNEXT_DATA (JSON file store).');
    }
    if (allowedOrigins.includes('*')) {
      throw new ProductionConfigError('Production forbids wildcard CORS origins.');
    }
  }

  if (!Number.isFinite(port) || port <= 0) {
    throw new ProductionConfigError('PORT must be a positive integer.');
  }

  return {
    production,
    persistenceMode,
    databaseUrl,
    tenantId,
    sessionSecretPresent: Boolean(trim(env.ATLAS_SESSION_SECRET)),
    allowedOrigins,
    casRoot,
    bindHost,
    port,
    mockProviders,
    hsts: production && env.ATLAS_TLS === '1',
    timeouts: readTimeoutContract(env),
  };
}

export function publicConfigView(config: ProductionHostConfig): Record<string, unknown> {
  return {
    production: config.production,
    persistenceMode: config.persistenceMode,
    databaseConfigured: Boolean(config.databaseUrl),
    tenantConfigured: Boolean(config.tenantId),
    sessionSecretConfigured: config.sessionSecretPresent,
    allowedOriginCount: config.allowedOrigins.length,
    casConfigured: Boolean(config.casRoot),
    bindHost: config.bindHost,
    port: config.port,
    mockProviders: config.mockProviders,
    hsts: config.hsts,
    timeouts: config.timeouts,
  };
}

function trim(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value ? value : null;
}

function positive(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
