import { z } from 'zod';

/**
 * Version of the Atlas contract surface as a whole.
 *
 * Every envelope carries the contract version it was produced under, so a
 * durable job written by an older deployment can still be interpreted. The
 * compatibility rule is deliberately crude and explicit: same major means
 * compatible, anything else is a hard stop.
 */
export const CONTRACT_VERSION = '1.0.0';

export const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

export const Semver = z
  .string()
  .regex(SEMVER_PATTERN, 'must be a semantic version')
  .describe('Semantic version string, e.g. 1.4.2');

export const ContractVersion = Semver.describe(
  'Version of the Atlas contract surface this record was produced under.',
);

export type Semver = z.infer<typeof Semver>;

export interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export function parseSemver(value: string): ParsedSemver {
  const match = SEMVER_PATTERN.exec(value);
  if (match === null) {
    throw new TypeError(`not a semantic version: ${value}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** True when `declared` can be interpreted by code built against `against`. */
export function isContractCompatible(
  declared: string,
  against: string = CONTRACT_VERSION,
): boolean {
  let left: ParsedSemver;
  let right: ParsedSemver;
  try {
    left = parseSemver(declared);
    right = parseSemver(against);
  } catch {
    return false;
  }
  if (left.major !== right.major) return false;
  // A producer may not be ahead of the consumer on minor: it could be using
  // fields the consumer does not know how to preserve.
  return left.minor <= right.minor;
}
