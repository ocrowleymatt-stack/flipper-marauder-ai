import { describe, expect, it } from 'vitest';
import { parseByteRange } from '../src/http.ts';

describe('parseByteRange', () => {
  it('treats omitted start as a suffix count from the end', () => {
    expect(parseByteRange('-500', 1000)).toEqual({ start: 500, end: 999 });
    expect(parseByteRange('-500', 400)).toEqual({ start: 0, end: 399 });
  });

  it('keeps inclusive closed and open-ended ranges', () => {
    expect(parseByteRange('0-11', 100)).toEqual({ start: 0, end: 11 });
    expect(parseByteRange('50-', 100)).toEqual({ start: 50, end: 99 });
    expect(parseByteRange('0-0', 10)).toEqual({ start: 0, end: 0 });
  });

  it('rejects inverted or empty ranges', () => {
    expect(parseByteRange('20-10', 100)).toBeNull();
    expect(parseByteRange('100-110', 100)).toBeNull();
    expect(parseByteRange('-', 100)).toBeNull();
    expect(parseByteRange('abc-def', 100)).toBeNull();
  });
});
