export interface PrincipalCredential {
  principalId: string;
  loginId: string;
  loginIdNormalized: string;
  passwordHash: string;
  passwordAlgo: string;
  createdAt: string;
  updatedAt: string;
  rotatedAt: string;
}

export interface CredentialStore {
  getByLogin(loginIdNormalized: string): Promise<PrincipalCredential | null>;
  getByPrincipal(principalId: string): Promise<PrincipalCredential | null>;
  put(record: PrincipalCredential): Promise<PrincipalCredential>;
}

export class MemoryCredentialStore implements CredentialStore {
  private readonly byPrincipal = new Map<string, PrincipalCredential>();
  private readonly byLogin = new Map<string, string>();

  async getByLogin(loginIdNormalized: string): Promise<PrincipalCredential | null> {
    const principalId = this.byLogin.get(loginIdNormalized);
    return principalId ? (this.byPrincipal.get(principalId) ?? null) : null;
  }

  async getByPrincipal(principalId: string): Promise<PrincipalCredential | null> {
    return this.byPrincipal.get(principalId) ?? null;
  }

  async put(record: PrincipalCredential): Promise<PrincipalCredential> {
    const taken = this.byLogin.get(record.loginIdNormalized);
    if (taken && taken !== record.principalId) {
      throw new Error('Login identifier is already assigned.');
    }
    const existing = this.byPrincipal.get(record.principalId);
    if (existing && existing.loginIdNormalized !== record.loginIdNormalized) {
      this.byLogin.delete(existing.loginIdNormalized);
    }
    this.byPrincipal.set(record.principalId, record);
    this.byLogin.set(record.loginIdNormalized, record.principalId);
    return record;
  }
}

export function normalizeLoginId(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isUsableLoginId(normalized: string): boolean {
  return normalized.length >= 1 && normalized.length <= 128 && /^[a-z0-9._@+-]+$/.test(normalized);
}
