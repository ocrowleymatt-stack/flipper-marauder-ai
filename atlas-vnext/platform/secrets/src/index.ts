import { logPlatform, redactFields } from '@atlas-vnext/observability';

export class SecretInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretInfrastructureError';
  }
}

/** Port compatible with execution `SecretStore`. Adapters must not read process.env. */
export interface SecretStore {
  get(name: string): string | undefined;
}

export interface TenantSecretRef {
  tenantId: string;
  name: string;
  version: number;
  rotatedAt: string;
}

export interface TenantSecretVault {
  ref(tenantId: string, name: string): Promise<TenantSecretRef | null>;
  resolve(tenantId: string, name: string): Promise<string>;
  put(tenantId: string, name: string, value: string): Promise<TenantSecretRef>;
  rotate(tenantId: string, name: string, value: string): Promise<TenantSecretRef>;
}

export class MapSecretStore implements SecretStore {
  constructor(private readonly values: Record<string, string | undefined> = {}) {}
  get(name: string): string | undefined {
    const value = this.values[name]?.trim();
    return value ? value : undefined;
  }
}

/**
 * Tenant-scoped secret vault. Values never enter conversation/project/artefact
 * records or model prompts unless a controlled adapter requests a named key.
 * Production fails closed when the backing store is missing.
 */
export class MemoryTenantSecretVault implements TenantSecretVault {
  private readonly values = new Map<string, { value: string; ref: TenantSecretRef }>();

  constructor(
    private readonly options: { production?: boolean; available?: boolean } = {},
  ) {}

  async ref(tenantId: string, name: string): Promise<TenantSecretRef | null> {
    this.assertAvailable();
    this.assertTenant(tenantId);
    return this.values.get(key(tenantId, name))?.ref ?? null;
  }

  async resolve(tenantId: string, name: string): Promise<string> {
    this.assertAvailable();
    this.assertTenant(tenantId);
    const row = this.values.get(key(tenantId, name));
    if (!row) {
      throw new SecretInfrastructureError(`Fail-closed: secret ${name} is not configured for this tenant.`);
    }
    return row.value;
  }

  async put(tenantId: string, name: string, value: string): Promise<TenantSecretRef> {
    this.assertAvailable();
    this.assertTenant(tenantId);
    const trimmed = value.trim();
    if (!trimmed) throw new SecretInfrastructureError('Fail-closed: empty secret values are rejected.');
    const existing = this.values.get(key(tenantId, name));
    const ref: TenantSecretRef = {
      tenantId,
      name,
      version: (existing?.ref.version ?? 0) + 1,
      rotatedAt: new Date().toISOString(),
    };
    this.values.set(key(tenantId, name), { value: trimmed, ref });
    logPlatform('secrets.put', { tenantId, name, version: ref.version });
    return ref;
  }

  async rotate(tenantId: string, name: string, value: string): Promise<TenantSecretRef> {
    return this.put(tenantId, name, value);
  }

  private assertAvailable(): void {
    if (this.options.production && this.options.available === false) {
      throw new SecretInfrastructureError('Fail-closed: secret infrastructure is not available.');
    }
  }

  private assertTenant(tenantId: string): void {
    if (!tenantId.trim()) {
      throw new SecretInfrastructureError('Fail-closed: secrets are tenant-scoped.');
    }
  }
}

export function assertNoSecretInPayload(payload: unknown, secrets: string[]): void {
  const text = safeText(payload);
  for (const secret of secrets) {
    if (secret && secret.length >= 8 && text.includes(secret)) {
      throw new SecretInfrastructureError('Fail-closed: secret material cannot be persisted in domain data.');
    }
  }
}

export function redactSecrets<T extends Record<string, unknown>>(fields: T, extra: string[] = []): T {
  const redacted = redactFields(fields) as T;
  let text = JSON.stringify(redacted);
  for (const secret of extra) {
    if (secret && secret.length >= 8) text = text.split(secret).join('[redacted]');
  }
  return JSON.parse(text) as T;
}

function key(tenantId: string, name: string): string {
  return `${tenantId}::${name}`;
}

function safeText(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return '';
  }
}

export class EnvBackedSecretStore implements SecretStore {
  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly production = false,
  ) {}

  get(name: string): string | undefined {
    const value = this.env[name]?.trim();
    if (value) return value;
    if (this.production) {
      throw new SecretInfrastructureError(
        `Fail-closed: production secret ${name} is missing from secret infrastructure.`,
      );
    }
    return undefined;
  }
}
