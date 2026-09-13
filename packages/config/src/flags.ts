import { readFileSync } from 'node:fs';

export type FlagStability = 'stable' | 'experimental';

export interface FlagDefinition {
  description: string;
  stability: FlagStability;
  /** Only set this to `true` for flags that have graduated; new flags default OFF. */
  defaultValue?: boolean;
}

export type FlagSource = 'default' | 'file' | 'env';

export interface FlagResolution {
  name: string;
  value: boolean;
  source: FlagSource;
  stability: FlagStability;
}

export interface FlagOptions {
  /** Environment to read `ATLAS_FLAG_<NAME>` and `ATLAS_FLAGS_FILE` from. Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Path of a JSON flags file (`{ "NAME": true }`). Defaults to `env.ATLAS_FLAGS_FILE`; `false` disables the file layer. */
  file?: string | false;
  /** Returns file contents, or `undefined` when the file does not exist. Defaults to `fs.readFileSync`. */
  readFile?: (path: string) => string | undefined;
}

export interface Flags<K extends string> {
  readonly names: readonly K[];
  readonly definitions: Readonly<Record<K, FlagDefinition>>;
  isEnabled(name: K): boolean;
  /** Read a flag from a code path that must stay stable; throws if the flag is experimental. */
  requireStable(name: K): boolean;
  resolve(name: K): FlagResolution;
  snapshot(): Readonly<Record<K, FlagResolution>>;
}

export const FLAG_ENV_PREFIX = 'ATLAS_FLAG_';
export const FLAGS_FILE_ENV = 'ATLAS_FLAGS_FILE';
const FLAG_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export class FlagError extends Error {
  override readonly name: string = 'FlagError';
}

export class InvalidFlagNameError extends FlagError {
  override readonly name = 'InvalidFlagNameError';
  constructor(readonly flag: string) {
    super(`invalid flag name "${flag}": expected UPPER_SNAKE_CASE`);
  }
}

export class UnknownFlagError extends FlagError {
  override readonly name = 'UnknownFlagError';
  constructor(readonly flag: string) {
    super(`unknown feature flag "${flag}"`);
  }
}

export class InvalidFlagValueError extends FlagError {
  override readonly name = 'InvalidFlagValueError';
  constructor(
    readonly flag: string,
    readonly source: FlagSource,
    readonly raw: unknown,
  ) {
    super(`invalid value for flag "${flag}" from ${source}: ${JSON.stringify(raw)}`);
  }
}

export class InvalidFlagsFileError extends FlagError {
  override readonly name = 'InvalidFlagsFileError';
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`invalid flags file ${path}: ${detail}`);
  }
}

export class ExperimentalFlagInStablePathError extends FlagError {
  override readonly name = 'ExperimentalFlagInStablePathError';
  constructor(readonly flag: string) {
    super(`experimental flag "${flag}" was read from a code path marked stable`);
  }
}

const TRUTHY = new Set(['1', 'true', 'on', 'yes']);
const FALSY = new Set(['0', 'false', 'off', 'no']);

export function parseFlagValue(raw: string): boolean | undefined {
  const normalised = raw.trim().toLowerCase();
  if (normalised === '') return undefined;
  if (TRUTHY.has(normalised)) return true;
  if (FALSY.has(normalised)) return false;
  throw new RangeError(`unrecognised boolean "${raw}"`);
}

export function envVarForFlag(name: string): string {
  return `${FLAG_ENV_PREFIX}${name}`;
}

const defaultReadFile = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

function readFileLayer(path: string, readFile: (p: string) => string | undefined): Record<string, boolean> {
  const contents = readFile(path);
  if (contents === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new InvalidFlagsFileError(path, (error as Error).message);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidFlagsFileError(path, 'expected a JSON object of flag name -> boolean');
  }
  const layer: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'boolean') throw new InvalidFlagValueError(key, 'file', value);
    layer[key] = value;
  }
  return layer;
}

export function defineFlags<const D extends Record<string, FlagDefinition>>(
  definitions: D,
  options: FlagOptions = {},
): Flags<keyof D & string> {
  type K = keyof D & string;
  const names = Object.keys(definitions) as K[];
  for (const name of names) {
    if (!FLAG_NAME_PATTERN.test(name)) throw new InvalidFlagNameError(name);
  }

  const env = options.env ?? process.env;
  const readFile = options.readFile ?? defaultReadFile;
  const filePath = options.file === undefined ? env[FLAGS_FILE_ENV] : options.file;
  const fileLayer = filePath ? readFileLayer(filePath, readFile) : {};

  const resolved = {} as Record<K, FlagResolution>;
  for (const name of names) {
    const definition = definitions[name] as FlagDefinition;
    let value = definition.defaultValue ?? false;
    let source: FlagSource = 'default';

    if (Object.hasOwn(fileLayer, name)) {
      value = fileLayer[name] as boolean;
      source = 'file';
    }

    const raw = env[envVarForFlag(name)];
    if (raw !== undefined) {
      let fromEnv: boolean | undefined;
      try {
        fromEnv = parseFlagValue(raw);
      } catch {
        throw new InvalidFlagValueError(name, 'env', raw);
      }
      if (fromEnv !== undefined) {
        value = fromEnv;
        source = 'env';
      }
    }

    resolved[name] = { name, value, source, stability: definition.stability };
  }

  const resolve = (name: K): FlagResolution => {
    const entry = resolved[name];
    if (entry === undefined) throw new UnknownFlagError(String(name));
    return entry;
  };

  return {
    names,
    definitions,
    resolve,
    isEnabled: (name) => resolve(name).value,
    requireStable: (name) => {
      const entry = resolve(name);
      if (entry.stability !== 'stable') throw new ExperimentalFlagInStablePathError(name);
      return entry.value;
    },
    snapshot: () => ({ ...resolved }),
  };
}
