import { promisify } from 'node:util';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing for native login.
 *
 * Argon2id is the preferred algorithm, but this runtime is Node 20 on a slim
 * production image with no C toolchain. Node 20 has no built-in Argon2. A
 * native `argon2` add-on would fail `npm ci` in the published Dockerfile.
 * scrypt via `node:crypto` is the well-configured standard-library primitive.
 *
 * Parameters: N=16384, r=8, p=1, 32-byte key, 16-byte unique salt.
 */
export const SCRYPT_N = 16_384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEYLEN = 32;
export const SCRYPT_SALT_BYTES = 16;
export const PASSWORD_ALGO = 'scrypt';
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

const SCRYPT_OPTIONS = {
  N: SCRYPT_N,
  r: SCRYPT_R,
  p: SCRYPT_P,
  maxmem: 64 * 1024 * 1024,
};

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, encoded: string): Promise<boolean>;
}

export class ScryptPasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(SCRYPT_SALT_BYTES);
    const key = await scryptAsync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS);
    return `$scrypt$n=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
  }

  async verify(password: string, encoded: string): Promise<boolean> {
    const parsed = parseScrypt(encoded);
    if (!parsed) {
      await dummyWork(password);
      return false;
    }
    const key = await scryptAsync(password, parsed.salt, parsed.keylen, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
      maxmem: 64 * 1024 * 1024,
    });
    if (key.length !== parsed.hash.length) return false;
    return timingSafeEqual(key, parsed.hash);
  }
}

export const defaultPasswordHasher = new ScryptPasswordHasher();

let dummyHashPromise: Promise<string> | null = null;

export async function dummyVerify(password: string, hasher: PasswordHasher = defaultPasswordHasher): Promise<false> {
  dummyHashPromise ??= hasher.hash(randomBytes(16).toString('hex'));
  const dummy = await dummyHashPromise;
  await hasher.verify(password, dummy);
  return false;
}

async function dummyWork(password: string): Promise<void> {
  await scryptAsync(password, Buffer.alloc(SCRYPT_SALT_BYTES), SCRYPT_KEYLEN, SCRYPT_OPTIONS);
}

export function parseScrypt(encoded: string): {
  n: number;
  r: number;
  p: number;
  keylen: number;
  salt: Buffer;
  hash: Buffer;
} | null {
  const match = /^\$scrypt\$n=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(encoded);
  if (!match) return null;
  const n = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (n < 1024 || n > 1_048_576 || r < 1 || p < 1) return null;
  try {
    const salt = Buffer.from(match[4]!, 'base64url');
    const hash = Buffer.from(match[5]!, 'base64url');
    if (salt.length < 8 || hash.length < 16) return null;
    return { n, r, p, keylen: hash.length, salt, hash };
  } catch {
    return null;
  }
}

export function assertProvisionPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
}

export function isHashedPassword(value: string): boolean {
  return parseScrypt(value) !== null;
}
