import { afterEach, describe, expect, it } from 'vitest';
import { LoginService, AuthService, isHashedPassword } from '@atlas-vnext/auth';
import { openTestKernel } from './harness.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe('principal credentials persistence', () => {
  it('stores a scrypt hash and authenticates through AuthService.issueSession', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    await handle.kernel.ensureTenant({ id: 'tenant_a', name: 'A' });
    await handle.kernel.ensurePrincipal({ id: 'principal_owner', displayName: 'owner' });
    const bound = handle.kernel.forActor({ tenantId: 'tenant_a', principalId: 'principal_owner' });
    await bound.directory.putTenantMembership({
      principalId: 'principal_owner',
      tenantId: 'tenant_a',
      role: 'owner',
      capabilities: [],
      createdAt: new Date().toISOString(),
    });
    const auth = new AuthService({
      sessions: bound.sessions,
      directory: bound.directory,
      secret: 'pg-test-secret',
    });
    const login = new LoginService({
      auth,
      credentials: bound.credentials,
      preferredTenantId: 'tenant_a',
    });
    await login.provision({
      principalId: 'principal_owner',
      login: 'owner',
      password: 'correct-horse-battery-staple',
    });
    const stored = await bound.credentials.getByLogin('owner');
    expect(stored?.passwordHash).not.toContain('correct-horse-battery-staple');
    expect(isHashedPassword(stored?.passwordHash ?? '')).toBe(true);
    const issued = await login.authenticate({
      login: 'owner',
      password: 'correct-horse-battery-staple',
      sourceKey: 'ip:127.0.0.1',
    });
    expect(issued.tenantId).toBe('tenant_a');
    const resolved = await auth.resolve({ sessionId: issued.sessionId, mutating: false });
    expect(resolved.actor.principalId).toBe('principal_owner');
  });
});
