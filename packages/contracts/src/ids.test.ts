import { describe, expect, it } from 'vitest';
import {
  AnyAtlasId,
  ID_KINDS,
  InvalidAtlasIdError,
  atlasId,
  isAnyId,
  isId,
  newId,
  parseId,
  tryParseId,
} from './ids.js';

const fixedRandom = (byte: number) => (length: number) => new Uint8Array(length).fill(byte);

describe('newId', () => {
  it('produces <kind>_<26 char ULID> for every kind', () => {
    for (const kind of ID_KINDS) {
      const id = newId(kind);
      expect(id).toMatch(new RegExp(`^${kind}_[0-9A-HJKMNP-TV-Z]{26}$`));
    }
  });

  it('encodes the timestamp in the first 10 characters so ids sort by creation time', () => {
    const earlier = newId('job', { now: () => 1_000_000, randomBytes: fixedRandom(0) });
    const later = newId('job', { now: () => 2_000_000, randomBytes: fixedRandom(0) });
    expect(earlier < later).toBe(true);
    expect(parseId(earlier).createdAt.getTime()).toBe(1_000_000);
    expect(parseId(later).createdAt.getTime()).toBe(2_000_000);
  });

  it('is deterministic given a clock and random source', () => {
    const options = { now: () => 1_726_000_000_000, randomBytes: fixedRandom(31) };
    expect(newId('prj', options)).toBe(newId('prj', options));
    expect(newId('prj', options)).toBe('prj_01J7ESVV00ZZZZZZZZZZZZZZZZ');
  });

  it('rejects unknown kinds and out-of-range timestamps', () => {
    expect(() => newId('nope' as never)).toThrow(RangeError);
    expect(() => newId('prj', { now: () => -1 })).toThrow(RangeError);
    expect(() => newId('prj', { now: () => 2 ** 48 })).toThrow(RangeError);
  });

  it('generates distinct ids by default', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId('blob')));
    expect(ids.size).toBe(1000);
  });
});

describe('parseId / isId', () => {
  const id = newId('chap');

  it('parses valid ids', () => {
    const parsed = parseId(id);
    expect(parsed.kind).toBe('chap');
    expect(parsed.id).toBe(id);
    expect(parsed.ulid).toHaveLength(26);
  });

  it.each([
    'chap_',
    'chap-01J7MXN6M0ZZZZZZZZZZZZZZZZ',
    'CHAP_01J7MXN6M0ZZZZZZZZZZZZZZZZ',
    'unknown_01J7MXN6M0ZZZZZZZZZZZZZZZZ',
    'chap_01J7MXN6M0ZZZZZZZZZZZZZZZ',
    'chap_01J7MXN6M0ZZZZZZZZZZZZZZZZI',
    'chap_81J7MXN6M0ZZZZZZZZZZZZZZZZ',
    '',
    42,
    null,
  ])('rejects %j', (value) => {
    expect(tryParseId(value)).toBeNull();
    expect(() => parseId(value)).toThrow(InvalidAtlasIdError);
    expect(isAnyId(value)).toBe(false);
  });

  it('checks the kind', () => {
    expect(isId('chap', id)).toBe(true);
    expect(isId('prj', id)).toBe(false);
    expect(isId('chap')(id)).toBe(true);
    expect(isId('prj')(id)).toBe(false);
  });

  it('exposes zod schemas for typed ids', () => {
    expect(atlasId('chap').safeParse(id).success).toBe(true);
    expect(atlasId('prj').safeParse(id).success).toBe(false);
    expect(AnyAtlasId.safeParse(id).success).toBe(true);
    expect(AnyAtlasId.safeParse('x_y').success).toBe(false);
  });
});
