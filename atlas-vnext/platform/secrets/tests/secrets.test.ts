import { describe, expect, it } from 'vitest';
import {
  MemoryTenantSecretVault,
  SecretInfrastructureError,
  assertNoSecretInPayload,
  redactSecrets,
} from '../src/index.ts';

describe('secrets', () => {
  it('never puts values in refs and fails closed when infrastructure is missing', async () => {
    const vault = new MemoryTenantSecretVault();
    const ref = await vault.put('tenant_a', 'OPENAI_API_KEY', 'sk-secret-value-12345');
    expect(JSON.stringify(ref)).not.toContain('sk-secret-value-12345');
    const value = await vault.resolve('tenant_a', 'OPENAI_API_KEY');
    expect(value).toBe('sk-secret-value-12345');
    expect(() => assertNoSecretInPayload({ prompt: 'use sk-secret-value-12345' }, [value])).toThrow(
      SecretInfrastructureError,
    );
    const closed = new MemoryTenantSecretVault({ production: true, available: false });
    await expect(closed.resolve('tenant_a', 'OPENAI_API_KEY')).rejects.toBeInstanceOf(SecretInfrastructureError);
    expect(redactSecrets({ authorization: 'Bearer sk-secret-value-12345' }).authorization).toBe('[redacted]');
  });
});
