import { describe, expect, it } from 'vitest';
import {
  ExperimentalFlagInStablePathError,
  InvalidFlagNameError,
  InvalidFlagValueError,
  InvalidFlagsFileError,
  UnknownFlagError,
  defineFlags,
  envVarForFlag,
  parseFlagValue,
} from './flags.js';

const definitions = {
  NEXUS_V2_ROUTING: { description: 'new router', stability: 'experimental' },
  DURABLE_JOBS: { description: 'durable job store', stability: 'stable' },
  GRADUATED: { description: 'shipped', stability: 'stable', defaultValue: true },
} as const;

const fileWith = (json: unknown) => ({
  file: '/virtual/flags.json',
  readFile: (path: string) => (path === '/virtual/flags.json' ? JSON.stringify(json) : undefined),
});

describe('defineFlags', () => {
  it('defaults every flag OFF unless the definition says otherwise', () => {
    const flags = defineFlags(definitions, { env: {}, file: false });
    expect(flags.isEnabled('NEXUS_V2_ROUTING')).toBe(false);
    expect(flags.isEnabled('DURABLE_JOBS')).toBe(false);
    expect(flags.isEnabled('GRADUATED')).toBe(true);
    expect(flags.resolve('DURABLE_JOBS')).toEqual({
      name: 'DURABLE_JOBS',
      value: false,
      source: 'default',
      stability: 'stable',
    });
    expect(flags.names).toEqual(['NEXUS_V2_ROUTING', 'DURABLE_JOBS', 'GRADUATED']);
  });

  it('lets the file layer override defaults', () => {
    const flags = defineFlags(definitions, { env: {}, ...fileWith({ DURABLE_JOBS: true, GRADUATED: false, OTHER: true }) });
    expect(flags.resolve('DURABLE_JOBS')).toMatchObject({ value: true, source: 'file' });
    expect(flags.resolve('GRADUATED')).toMatchObject({ value: false, source: 'file' });
    expect(flags.resolve('NEXUS_V2_ROUTING')).toMatchObject({ value: false, source: 'default' });
  });

  it('lets env override the file layer', () => {
    const flags = defineFlags(definitions, {
      env: { ATLAS_FLAG_DURABLE_JOBS: 'off', ATLAS_FLAG_NEXUS_V2_ROUTING: 'On' },
      ...fileWith({ DURABLE_JOBS: true }),
    });
    expect(flags.resolve('DURABLE_JOBS')).toMatchObject({ value: false, source: 'env' });
    expect(flags.resolve('NEXUS_V2_ROUTING')).toMatchObject({ value: true, source: 'env' });
  });

  it('treats an empty env value as unset', () => {
    const flags = defineFlags(definitions, { env: { ATLAS_FLAG_DURABLE_JOBS: '' }, ...fileWith({ DURABLE_JOBS: true }) });
    expect(flags.resolve('DURABLE_JOBS')).toMatchObject({ value: true, source: 'file' });
  });

  it('locates the file via ATLAS_FLAGS_FILE and tolerates a missing file', () => {
    const seen: string[] = [];
    const flags = defineFlags(definitions, {
      env: { ATLAS_FLAGS_FILE: '/etc/atlas/flags.json' },
      readFile: (path) => {
        seen.push(path);
        return undefined;
      },
    });
    expect(seen).toEqual(['/etc/atlas/flags.json']);
    expect(flags.isEnabled('DURABLE_JOBS')).toBe(false);
  });

  it('rejects malformed env values and files', () => {
    expect(() => defineFlags(definitions, { env: { ATLAS_FLAG_DURABLE_JOBS: 'maybe' }, file: false })).toThrow(InvalidFlagValueError);
    expect(() => defineFlags(definitions, { env: {}, ...fileWith({ DURABLE_JOBS: 'yes' }) })).toThrow(InvalidFlagValueError);
    expect(() => defineFlags(definitions, { env: {}, ...fileWith([true]) })).toThrow(InvalidFlagsFileError);
    expect(() => defineFlags(definitions, { env: {}, file: '/x.json', readFile: () => '{not json' })).toThrow(InvalidFlagsFileError);
  });

  it('rejects flag names that cannot map to env vars', () => {
    expect(() => defineFlags({ 'kebab-case': { description: '', stability: 'stable' } }, { env: {}, file: false })).toThrow(InvalidFlagNameError);
    expect(envVarForFlag('DURABLE_JOBS')).toBe('ATLAS_FLAG_DURABLE_JOBS');
  });

  it('throws for unknown flags at runtime', () => {
    const flags = defineFlags(definitions, { env: {}, file: false });
    expect(() => flags.isEnabled('NOPE' as never)).toThrow(UnknownFlagError);
  });

  it('snapshots all resolutions', () => {
    const flags = defineFlags(definitions, { env: { ATLAS_FLAG_GRADUATED: '0' }, file: false });
    expect(Object.keys(flags.snapshot())).toEqual(flags.names);
    expect(flags.snapshot().GRADUATED).toMatchObject({ value: false, source: 'env' });
  });
});

describe('requireStable', () => {
  const flags = defineFlags(definitions, { env: { ATLAS_FLAG_NEXUS_V2_ROUTING: 'true' }, file: false });

  it('returns the value of stable flags', () => {
    expect(flags.requireStable('DURABLE_JOBS')).toBe(false);
    expect(flags.requireStable('GRADUATED')).toBe(true);
  });

  it('throws when an experimental flag is read from a stable path, even if enabled', () => {
    expect(flags.isEnabled('NEXUS_V2_ROUTING')).toBe(true);
    expect(() => flags.requireStable('NEXUS_V2_ROUTING')).toThrow(ExperimentalFlagInStablePathError);
  });
});

describe('parseFlagValue', () => {
  it.each(['1', 'true', 'TRUE', 'on', 'yes', ' Yes '])('parses %j as true', (raw) => {
    expect(parseFlagValue(raw)).toBe(true);
  });
  it.each(['0', 'false', 'off', 'No'])('parses %j as false', (raw) => {
    expect(parseFlagValue(raw)).toBe(false);
  });
  it('returns undefined for blank and throws for garbage', () => {
    expect(parseFlagValue('  ')).toBeUndefined();
    expect(() => parseFlagValue('enabled')).toThrow(RangeError);
  });
});
