import { webcrypto } from 'node:crypto';
import { z } from 'zod';

/**
 * Atlas IDs are `<kind>_<ULID>`: a short lowercase kind prefix, an underscore, and a
 * 26-character Crockford base32 ULID (48-bit millisecond timestamp + 80 random bits).
 * They sort lexicographically by creation time within a kind and are safe in URLs,
 * filenames and log lines. Monotonicity within the same millisecond is not guaranteed.
 */
export const ID_KINDS = [
  'prj',
  'file',
  'art',
  'job',
  'conv',
  'site',
  'chap',
  'char',
  'res',
  'evd',
  'dep',
  'mdl',
  'rev',
  'blob',
  'trace',
  'evt',
] as const;

export type IdKind = (typeof ID_KINDS)[number];
export type AtlasId<K extends IdKind = IdKind> = `${K}_${string}`;

export const ID_KIND_LABELS: Readonly<Record<IdKind, string>> = {
  prj: 'project',
  file: 'file',
  art: 'artifact',
  job: 'job',
  conv: 'conversation',
  site: 'site',
  chap: 'chapter',
  char: 'character',
  res: 'research item',
  evd: 'evidence',
  dep: 'deployment',
  mdl: 'model',
  rev: 'revision',
  blob: 'blob',
  trace: 'trace',
  evt: 'event',
};

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_LENGTH = 26;
const TIME_LENGTH = 10;
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const ID_PATTERN = /^([a-z]+)_([0-9A-HJKMNP-TV-Z]{26})$/;

export interface IdGeneratorOptions {
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}

const defaultRandomBytes = (length: number): Uint8Array =>
  webcrypto.getRandomValues(new Uint8Array(length));

function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > 0xffffffffffff) {
    throw new RangeError(`timestamp out of ULID range: ${ms}`);
  }
  let value = ms;
  let out = '';
  for (let i = 0; i < TIME_LENGTH; i += 1) {
    out = CROCKFORD[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  if (bytes.length < ULID_LENGTH - TIME_LENGTH) {
    throw new RangeError('not enough random bytes for a ULID');
  }
  let out = '';
  for (let i = 0; i < ULID_LENGTH - TIME_LENGTH; i += 1) {
    out += CROCKFORD[(bytes[i] as number) & 31];
  }
  return out;
}

function decodeTime(ulid: string): number {
  let value = 0;
  for (let i = 0; i < TIME_LENGTH; i += 1) {
    value = value * 32 + CROCKFORD.indexOf(ulid[i] as string);
  }
  return value;
}

export function isIdKind(value: unknown): value is IdKind {
  return typeof value === 'string' && (ID_KINDS as readonly string[]).includes(value);
}

export function newId<K extends IdKind>(kind: K, options: IdGeneratorOptions = {}): AtlasId<K> {
  if (!isIdKind(kind)) {
    throw new RangeError(`unknown id kind: ${String(kind)}`);
  }
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? defaultRandomBytes;
  return `${kind}_${encodeTime(now())}${encodeRandom(randomBytes(16))}`;
}

export interface ParsedId<K extends IdKind = IdKind> {
  kind: K;
  id: AtlasId<K>;
  ulid: string;
  createdAt: Date;
}

export class InvalidAtlasIdError extends Error {
  override readonly name = 'InvalidAtlasIdError';
  constructor(readonly value: unknown) {
    super(`not a valid Atlas id: ${typeof value === 'string' ? value : typeof value}`);
  }
}

export function tryParseId(value: unknown): ParsedId | null {
  if (typeof value !== 'string') return null;
  const match = ID_PATTERN.exec(value);
  if (!match) return null;
  const [, kind, ulid] = match as unknown as [string, string, string];
  if (!isIdKind(kind) || !ULID_PATTERN.test(ulid)) return null;
  return { kind, id: value as AtlasId, ulid, createdAt: new Date(decodeTime(ulid)) };
}

export function parseId(value: unknown): ParsedId {
  const parsed = tryParseId(value);
  if (!parsed) throw new InvalidAtlasIdError(value);
  return parsed;
}

export function isId<K extends IdKind>(kind: K): (value: unknown) => value is AtlasId<K>;
export function isId<K extends IdKind>(kind: K, value: unknown): value is AtlasId<K>;
export function isId<K extends IdKind>(kind: K, ...rest: [unknown] | []): unknown {
  const check = (value: unknown): value is AtlasId<K> => tryParseId(value)?.kind === kind;
  return rest.length === 0 ? check : check(rest[0]);
}

export function isAnyId(value: unknown): value is AtlasId {
  return tryParseId(value) !== null;
}

export function atlasId<K extends IdKind>(kind: K): z.ZodType<AtlasId<K>> {
  return z.custom<AtlasId<K>>((value) => isId(kind, value), {
    message: `expected an Atlas id with prefix "${kind}_"`,
  });
}

export const AnyAtlasId: z.ZodType<AtlasId> = z.custom<AtlasId>(isAnyId, {
  message: 'expected an Atlas id (<kind>_<ULID>)',
});

export const IdKindSchema = z.enum(ID_KINDS);
