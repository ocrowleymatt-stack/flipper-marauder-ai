import { describe, expect, it } from 'vitest';
import {
  ScryptPasswordHasher,
  assertProvisionPassword,
  isHashedPassword,
  parseScrypt,
} from '../src/password.ts';

describe('scrypt password hashing', () => {
  it('hashes with unique salts and verifies only the original password', async () => {
    const hasher = new ScryptPasswordHasher();
    const a = await hasher.hash('correct-horse-battery-staple');
    const b = await hasher.hash('correct-horse-battery-staple');
    expect(a).not.toBe(b);
    expect(isHashedPassword(a)).toBe(true);
    expect(a).not.toContain('correct-horse-battery-staple');
    expect(await hasher.verify('correct-horse-battery-staple', a)).toBe(true);
    expect(await hasher.verify('wrong-password-value', a)).toBe(false);
    expect(parseScrypt(a)?.n).toBe(16_384);
  });

  it('rejects short provision passwords', () => {
    expect(() => assertProvisionPassword('short')).toThrow(/12/);
  });
});
