import { createHash } from 'node:crypto';
import { logPlatform } from '@atlas-vnext/observability';
import { AuthenticationError, RateLimitedError } from './errors.ts';
import type { AuthService } from './service.ts';
import { BruteForceGuard } from './service.ts';
import {
  MemoryCredentialStore,
  isUsableLoginId,
  normalizeLoginId,
  type CredentialStore,
  type PrincipalCredential,
} from './credentials.ts';
import {
  PASSWORD_ALGO,
  assertProvisionPassword,
  defaultPasswordHasher,
  dummyVerify,
  type PasswordHasher,
} from './password.ts';

export const LOGIN_IDENTIFIER_LIMIT = 5;
export const LOGIN_SOURCE_LIMIT = 30;
export const LOGIN_WINDOW_MS = 5 * 60_000;

export interface LoginServiceOptions {
  auth: AuthService;
  credentials: CredentialStore;
  hasher?: PasswordHasher;
  preferredTenantId?: string | null;
  now?: () => number;
}

export interface NativeLoginInput {
  login: string;
  password: string;
  origin?: string | null;
  userAgent?: string;
  sourceKey: string;
  claimedTenantId?: string | null;
}

export interface NativeLoginResult {
  sessionId: string;
  csrfToken: string;
  principalId: string;
  tenantId: string;
}

export class LoginService {
  private readonly hasher: PasswordHasher;
  private readonly identifierGuard: BruteForceGuard;
  private readonly sourceGuard: BruteForceGuard;

  constructor(private readonly options: LoginServiceOptions) {
    this.hasher = options.hasher ?? defaultPasswordHasher;
    const now = options.now ?? Date.now;
    this.identifierGuard = new BruteForceGuard(LOGIN_IDENTIFIER_LIMIT, LOGIN_WINDOW_MS, now);
    this.sourceGuard = new BruteForceGuard(LOGIN_SOURCE_LIMIT, LOGIN_WINDOW_MS, now);
  }

  async provision(input: {
    principalId: string;
    login: string;
    password: string;
  }): Promise<{ principalId: string; loginId: string; loginIdNormalized: string; rotated: boolean }> {
    const loginId = input.login.trim();
    const loginIdNormalized = normalizeLoginId(loginId);
    if (!isUsableLoginId(loginIdNormalized)) {
      throw new Error('Login identifier is not usable.');
    }
    assertProvisionPassword(input.password);
    const existing = await this.options.credentials.getByPrincipal(input.principalId);
    const now = new Date().toISOString();
    const passwordHash = await this.hasher.hash(input.password);
    const record: PrincipalCredential = {
      principalId: input.principalId,
      loginId,
      loginIdNormalized,
      passwordHash,
      passwordAlgo: PASSWORD_ALGO,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      rotatedAt: now,
    };
    await this.options.credentials.put(record);
    logPlatform('auth.credential.provisioned', {
      principalId: input.principalId,
      loginHash: hashLogin(loginIdNormalized),
      rotated: Boolean(existing),
    });
    return {
      principalId: input.principalId,
      loginId,
      loginIdNormalized,
      rotated: Boolean(existing),
    };
  }

  async authenticate(input: NativeLoginInput): Promise<NativeLoginResult> {
    void input.claimedTenantId;
    this.options.auth.guardOrigin(input.origin);
    const loginIdNormalized = normalizeLoginId(input.login ?? '');
    const password = typeof input.password === 'string' ? input.password : '';
    const sourceKey = input.sourceKey.trim() || 'ip:unknown';
    const identifierKey = loginIdNormalized ? `login:${loginIdNormalized}` : 'login:empty';

    if (!this.identifierGuard.peek(identifierKey).allowed || !this.sourceGuard.peek(sourceKey).allowed) {
      logPlatform('auth.login.throttled', { loginHash: hashLogin(loginIdNormalized), remote: sourceKey }, 'warn');
      throw new RateLimitedError();
    }

    const credential =
      isUsableLoginId(loginIdNormalized) && password.length > 0 && password.length <= 256
        ? await this.options.credentials.getByLogin(loginIdNormalized)
        : null;

    const passwordOk = credential
      ? await this.hasher.verify(password, credential.passwordHash)
      : await dummyVerify(password || 'x', this.hasher);

    if (!credential || !passwordOk) {
      this.identifierGuard.hit(identifierKey);
      this.sourceGuard.hit(sourceKey);
      logPlatform('auth.login.failure', { loginHash: hashLogin(loginIdNormalized), outcome: 'invalid_credentials' });
      throw invalidCredentials();
    }

    const memberships = await this.options.auth.listTenantMemberships(credential.principalId);
    const tenantId = selectTenant(
      memberships.map((row) => row.tenantId),
      this.options.preferredTenantId,
    );
    if (!tenantId) {
      this.identifierGuard.hit(identifierKey);
      this.sourceGuard.hit(sourceKey);
      logPlatform('auth.login.failure', { loginHash: hashLogin(loginIdNormalized), outcome: 'invalid_credentials' });
      throw invalidCredentials();
    }

    const issued = await this.options.auth.issueSession({
      principalId: credential.principalId,
      tenantId,
      kind: 'user',
      userAgent: input.userAgent,
    });
    logPlatform('auth.login.success', {
      principalId: credential.principalId,
      tenantId,
      sessionId: issued.session.id,
      loginHash: hashLogin(loginIdNormalized),
    });
    this.identifierGuard.reset(identifierKey);
    return {
      sessionId: issued.session.id,
      csrfToken: issued.csrfToken,
      principalId: credential.principalId,
      tenantId,
    };
  }
}

export function selectTenant(memberOf: string[], preferredTenantId?: string | null): string | null {
  const tenants = [...new Set(memberOf.filter((id) => id.trim()))];
  if (preferredTenantId && tenants.includes(preferredTenantId)) return preferredTenantId;
  if (tenants.length === 1) return tenants[0]!;
  return null;
}

export function createMemoryLogin(
  auth: AuthService,
  preferredTenantId?: string | null,
): {
  credentials: MemoryCredentialStore;
  login: LoginService;
} {
  const credentials = new MemoryCredentialStore();
  return {
    credentials,
    login: new LoginService({ auth, credentials, preferredTenantId }),
  };
}

function invalidCredentials(): AuthenticationError {
  return new AuthenticationError('unauthenticated', 'Invalid credentials.');
}

function hashLogin(loginIdNormalized: string): string {
  if (!loginIdNormalized) return 'empty';
  return createHash('sha256').update(loginIdNormalized).digest('hex').slice(0, 16);
}
