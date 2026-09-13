import { z } from 'zod';
import { CapabilityScope } from './capability.js';
import { CommandType } from './command.js';
import { EventType } from './event.js';
import { Identifier, Metadata, NonEmptyString } from './primitives.js';
import { Semver } from './version.js';

/**
 * How strongly the host isolates a module. Only `in-process` is implemented in
 * this skeleton; the other two exist in the contract so that a module can
 * declare its requirement before the host can honour it, rather than the
 * manifest needing a breaking change later.
 */
export const MODULE_ISOLATION_MODES = ['in-process', 'worker-thread', 'subprocess'] as const;

export const ModuleIsolationMode = z.enum(MODULE_ISOLATION_MODES);

export const ModuleManifest = z
  .strictObject({
    id: Identifier.describe('Globally unique module id, e.g. `device.transport`.'),
    version: Semver.describe('The module\u2019s own version.'),
    contractVersion: Semver.describe(
      'Version of @atlas/contracts the module was built against. The host refuses incompatible majors.',
    ),
    sdkVersion: Semver.describe(
      'Version of the @atlas/module-sdk interface the module implements.',
    ),
    displayName: NonEmptyString.max(128),
    description: NonEmptyString.max(1024).optional(),
    entrypoint: NonEmptyString.max(512).describe(
      'Module-relative path or specifier the host imports to obtain the module definition.',
    ),
    isolation: ModuleIsolationMode,
    requiredCapabilities: z
      .array(CapabilityScope)
      .describe(
        'Everything the module may ever ask to do. The host mints an attenuated token from exactly this set and nothing wider.',
      ),
    declaredCommands: z
      .array(CommandType)
      .describe('Command types this module claims. Two modules may not claim the same type.'),
    declaredEvents: z
      .array(EventType)
      .describe('Event types this module emits. The host rejects emissions outside this set.'),
    metadata: Metadata.optional(),
  })
  .describe('Everything the host needs to know about a module before running any of its code.');

export type ModuleIsolationMode = z.infer<typeof ModuleIsolationMode>;
export type ModuleManifest = z.infer<typeof ModuleManifest>;
