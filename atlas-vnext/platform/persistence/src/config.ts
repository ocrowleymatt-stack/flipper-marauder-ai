import { PersistenceConfigError } from './errors.ts';

export type PersistenceMode = 'memory' | 'file' | 'postgres';

export interface PersistenceConfig {
  mode: PersistenceMode;
  production: boolean;
  databaseUrl: string | null;
  poolMax: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  statementTimeoutMs: number;
  filePath: string | null;
  defaultTenantId: string | null;
  schema?: string;
}

export function readPersistenceConfig(
  env: Record<string, string | undefined> = process.env,
): PersistenceConfig {
  const production = env.NODE_ENV === 'production' || env.ATLAS_ENV === 'production';
  const rawMode = (env.ATLAS_PERSISTENCE ?? '').trim().toLowerCase();
  let mode: PersistenceMode;
  if (rawMode === 'postgres' || rawMode === 'postgresql' || rawMode === 'pg') mode = 'postgres';
  else if (rawMode === 'memory') mode = 'memory';
  else if (rawMode === 'file') mode = 'file';
  else mode = production ? 'postgres' : 'file';

  const databaseUrl = optionalText(env.ATLAS_DATABASE_URL) ?? optionalText(env.DATABASE_URL);

  if (production && mode !== 'postgres') {
    throw new PersistenceConfigError(
      'Production persistence requires PostgreSQL. Set ATLAS_PERSISTENCE=postgres and ATLAS_DATABASE_URL.',
    );
  }
  if (mode === 'postgres' && !databaseUrl) {
    throw new PersistenceConfigError(
      'PostgreSQL persistence requested but ATLAS_DATABASE_URL / DATABASE_URL is missing.',
    );
  }

  const defaultTenantId = optionalText(env.ATLAS_TENANT_ID) ?? (production ? null : 'tenant_local');

  return {
    mode,
    production,
    databaseUrl,
    poolMax: readPositiveInt(env.ATLAS_DB_POOL_MAX, 10),
    idleTimeoutMs: readPositiveInt(env.ATLAS_DB_IDLE_TIMEOUT_MS, 10_000),
    connectionTimeoutMs: readPositiveInt(env.ATLAS_DB_CONNECT_TIMEOUT_MS, 5_000),
    statementTimeoutMs: readPositiveInt(env.ATLAS_DB_STATEMENT_TIMEOUT_MS, 30_000),
    filePath: optionalText(env.ATLAS_VNEXT_DATA),
    defaultTenantId,
    schema: optionalText(env.ATLAS_DB_SCHEMA) ?? undefined,
  };
}

function optionalText(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}
