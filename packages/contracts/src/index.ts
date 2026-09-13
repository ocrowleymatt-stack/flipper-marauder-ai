/**
 * @atlas/contracts — the single source of truth for every message that crosses
 * an Atlas boundary.
 *
 * This package imports nothing internal, by construction and by enforced
 * architecture rule. Everything else in the monorepo may depend on it.
 */

export * from './version.js';
export * from './primitives.js';
export * from './capability.js';
export * from './command.js';
export * from './job.js';
export * from './project.js';
export * from './event.js';
export * from './provenance.js';
export * from './module-manifest.js';
export * from './catalog.js';
export * from './json-schema.js';
