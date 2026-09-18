import { describe, expect, it } from 'vitest';
import {
  AuthService,
  LOGIN_IDENTIFIER_LIMIT,
  LOGIN_SOURCE_LIMIT,
  LoginService,
  MemoryCredentialStore,
  MemoryDirectoryStore,
  MemorySessionStore,
  RateLimitedError,
  isHashedPassword,
  selectTenant,
} from '../src/index.ts';

const PASSWORD = 'correct-horse-battery-staple';

async function setup() {
  const directory = new MemoryDirectoryStore();
  const sessions = new MemorySessionStore();
  const credentials = new MemoryCredentialStore();
  await directory.putTenantMembership({
    principalId: 'principal_owner',
    tenantId: 'tenant_a',
    role: 'owner',
    capabilities: [],
    createdAt: new Date().toISOString(),
  });
  const auth = new AuthService({
    directory,
    sessions,
    secret: 'test-secret',
    allowedOrigins: ['https://atlas.ocrowley.com'],
    production: true,
  });
  const login = new LoginService({
    auth,
    credentials,
    preferredTenantId: 'tenant_a',
  });
  await login.provision({ principalId: 'principal_owner', login: 'owner', password: PASSWORD });
  return { auth, login, credentials, directory, sessions };
}

describe('native login', () => {
  it('stores scrypt hashes, never plaintext, and verifies the correct password', async () => {
    const { credentials, login } = await setup();
    const stored = await credentials.getByPrincipal('principal_owner');
    expect(stored?.passwordHash).not.toContain(PASSWORD);
    expect(isHashedPassword(stored?.passwordHash ?? '')).toBe(true);
    const ok = await login.authenticate({
      login: 'Owner',
      password: PASSWORD,
      origin: 'https://atlas.ocrowley.com',
      sourceKey: 'ip:10.0.0.1',
    });
    expect(ok.principalId).toBe('principal_owner');
    expect(ok.tenantId).toBe('tenant_a');
    expect(ok.sessionId.startsWith('ses_')).toBe(true);
  });

  it('returns equivalent failures for unknown accounts and wrong passwords', async () => {
    const { login } = await setup();
    await expect(
      login.authenticate({
        login: 'nobody',
        password: PASSWORD,
        origin: 'https://atlas.ocrowley.com',
        sourceKey: 'ip:10.0.0.2',
      }),
    ).rejects.toMatchObject({ code: 'unauthenticated', message: 'Invalid credentials.' });
    await expect(
      login.authenticate({
        login: 'owner',
        password: 'definitely-not-the-password',
        origin: 'https://atlas.ocrowley.com',
        sourceKey: 'ip:10.0.0.3',
      }),
    ).rejects.toMatchObject({ code: 'unauthenticated', message: 'Invalid credentials.' });
  });

  it('ignores claimed tenant ids and derives tenant from membership', async () => {
    const { login, auth } = await setup();
    const issued = await login.authenticate({
      login: 'owner',
      password: PASSWORD,
      origin: 'https://atlas.ocrowley.com',
      sourceKey: 'ip:10.0.0.4',
      claimedTenantId: 'tenant_foreign',
    });
    expect(issued.tenantId).toBe('tenant_a');
    const resolved = await auth.resolve({ sessionId: issued.sessionId, mutating: false });
    expect(resolved.actor.tenantId).toBe('tenant_a');
    await expect(
      auth.resolve({
        sessionId: issued.sessionId,
        mutating: false,
        claimedTenantId: 'tenant_foreign',
      }),
    ).rejects.toThrow(/membership/);
  });

  it('issues a fresh session and honours revocation', async () => {
    const { login, auth } = await setup();
    const first = await login.authenticate({
      login: 'owner',
      password: PASSWORD,
      origin: 'https://atlas.ocrowley.com',
      sourceKey: 'ip:10.0.0.5',
    });
    const second = await login.authenticate({
      login: 'owner',
      password: PASSWORD,
      origin: 'https://atlas.ocrowley.com',
      sourceKey: 'ip:10.0.0.5',
    });
    expect(second.sessionId).not.toBe(first.sessionId);
    await auth.revoke(first.sessionId);
    await expect(auth.resolve({ sessionId: first.sessionId, mutating: false })).rejects.toThrow(/revoked/i);
    const still = await auth.resolve({ sessionId: second.sessionId, mutating: false });
    expect(still.actor.principalId).toBe('principal_owner');
  });

  it('rejects a hostile Origin when an allow-list is configured', async () => {
    const { login } = await setup();
    await expect(
      login.authenticate({
        login: 'owner',
        password: PASSWORD,
        origin: 'https://evil.example',
        sourceKey: 'ip:10.0.0.6',
      }),
    ).rejects.toThrow(/Origin/);
  });

  it('throttles repeated failures without leaking account existence', async () => {
    const { login } = await setup();
    for (let i = 0; i < LOGIN_IDENTIFIER_LIMIT; i += 1) {
      await expect(
        login.authenticate({
          login: 'owner',
          password: 'wrong-password-xxxx',
          origin: 'https://atlas.ocrowley.com',
          sourceKey: 'ip:10.0.0.7',
        }),
      ).rejects.toMatchObject({ message: 'Invalid credentials.' });
    }
    await expect(
      login.authenticate({
        login: 'owner',
        password: 'wrong-password-xxxx',
        origin: 'https://atlas.ocrowley.com',
        sourceKey: 'ip:10.0.0.7',
      }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    await expect(
      login.authenticate({
        login: 'owner',
        password: PASSWORD,
        origin: 'https://atlas.ocrowley.com',
        sourceKey: 'ip:10.0.0.7',
      }),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('throttles a source across distinct identifiers without revealing which exist', async () => {
    const directory = new MemoryDirectoryStore();
    const sessions = new MemorySessionStore();
    const credentials = new MemoryCredentialStore();
    await directory.putTenantMembership({
      principalId: 'principal_owner',
      tenantId: 'tenant_a',
      role: 'owner',
      capabilities: [],
      createdAt: new Date().toISOString(),
    });
    const auth = new AuthService({
      directory,
      sessions,
      secret: 'test-secret',
      allowedOrigins: ['https://atlas.ocrowley.com'],
      production: true,
    });
    const hasher = {
      async hash(password: string) {
        return `plain:${password}`;
      },
      async verify(password: string, encoded: string) {
        return encoded === `plain:${password}`;
      },
    };
    const login = new LoginService({
      auth,
      credentials,
      hasher,
      preferredTenantId: 'tenant_a',
    });
    await login.provision({ principalId: 'principal_owner', login: 'owner', password: PASSWORD });
    for (let i = 0; i < LOGIN_SOURCE_LIMIT; i += 1) {
      await expect(
        login.authenticate({
          login: `nobody${i}`,
          password: 'wrong-password-xxxx',
          origin: 'https://atlas.ocrowley.com',
          sourceKey: 'ip:10.0.0.9',
        }),
      ).rejects.toMatchObject({ message: 'Invalid credentials.' });
    }
    await expect(
      login.authenticate({
        login: 'nobody-final',
        password: 'wrong-password-xxxx',
        origin: 'https://atlas.ocrowley.com',
        sourceKey: 'ip:10.0.0.9',
      }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    await expect(
      login.authenticate({
        login: 'owner',
        password: PASSWORD,
        origin: 'https://atlas.ocrowley.com',
        sourceKey: 'ip:10.0.0.9',
      }),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('selects the preferred tenant when the principal is a member of several', () => {
    expect(selectTenant(['tenant_b', 'tenant_a'], 'tenant_a')).toBe('tenant_a');
    expect(selectTenant(['tenant_b'], 'tenant_a')).toBe('tenant_b');
    expect(selectTenant(['tenant_b', 'tenant_c'], 'tenant_a')).toBeNull();
  });
});
