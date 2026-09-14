import { describe, expect, it } from 'vitest';
import { AuthService, MemoryDirectoryStore, MemorySessionStore, SessionRevokedError } from '../src/index.ts';

describe('auth sessions', () => {
  it('issues, rotates, and revokes sessions; claimed tenant ids are not membership', async () => {
    const directory = new MemoryDirectoryStore();
    const sessions = new MemorySessionStore();
    await directory.putTenantMembership({
      principalId: 'user_a',
      tenantId: 'tenant_a',
      role: 'member',
      capabilities: [],
      createdAt: new Date().toISOString(),
    });
    const auth = new AuthService({ directory, sessions, secret: 'test-secret' });
    const issued = await auth.issueSession({ principalId: 'user_a', tenantId: 'tenant_a' });
    const resolved = await auth.resolve({
      sessionId: issued.session.id,
      csrfToken: issued.csrfToken,
      mutating: true,
    });
    expect(resolved.actor.tenantId).toBe('tenant_a');
    await expect(
      auth.resolve({
        sessionId: issued.session.id,
        csrfToken: issued.csrfToken,
        mutating: true,
        claimedTenantId: 'tenant_b',
      }),
    ).rejects.toThrow(/membership/);
    await auth.revoke(issued.session.id);
    await expect(
      auth.resolve({ sessionId: issued.session.id, csrfToken: issued.csrfToken, mutating: false }),
    ).rejects.toBeInstanceOf(SessionRevokedError);
  });

  it('rejects CSRF mismatch on mutating cookie requests', async () => {
    const directory = new MemoryDirectoryStore();
    const sessions = new MemorySessionStore();
    await directory.putTenantMembership({
      principalId: 'user_a',
      tenantId: 'tenant_a',
      role: 'member',
      capabilities: [],
      createdAt: new Date().toISOString(),
    });
    const auth = new AuthService({ directory, sessions, secret: 'test-secret' });
    const issued = await auth.issueSession({ principalId: 'user_a', tenantId: 'tenant_a' });
    await expect(
      auth.resolve({ sessionId: issued.session.id, csrfToken: 'forged', mutating: true }),
    ).rejects.toThrow(/CSRF/);
  });
});
