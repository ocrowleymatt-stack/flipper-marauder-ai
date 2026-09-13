import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION, isContractCompatible, parseSemver, Semver } from '../src/index.js';

describe('contract versioning', () => {
  it('exposes a semver contract version', () => {
    expect(Semver.parse(CONTRACT_VERSION)).toBe(CONTRACT_VERSION);
  });

  it('parses semver components', () => {
    expect(parseSemver('2.11.4')).toEqual({ major: 2, minor: 11, patch: 4 });
  });

  it('rejects non-semver input', () => {
    expect(() => parseSemver('1.2')).toThrow(TypeError);
    expect(() => parseSemver('01.2.3')).toThrow(TypeError);
  });

  it('treats the same major and an equal-or-lower minor as compatible', () => {
    expect(isContractCompatible('1.0.0', '1.0.0')).toBe(true);
    expect(isContractCompatible('1.0.9', '1.2.0')).toBe(true);
    expect(isContractCompatible('1.2.0', '1.2.5')).toBe(true);
  });

  it('rejects a producer ahead of the consumer on minor', () => {
    expect(isContractCompatible('1.3.0', '1.2.0')).toBe(false);
  });

  it('rejects a different major in either direction', () => {
    expect(isContractCompatible('2.0.0', '1.0.0')).toBe(false);
    expect(isContractCompatible('0.9.0', '1.0.0')).toBe(false);
  });

  it('rejects garbage rather than throwing', () => {
    expect(isContractCompatible('not-a-version')).toBe(false);
  });
});
