import type { DungeonId } from '@atlas-vnext/contracts';

export const dungeonId: DungeonId = 'osint';

export const osintDungeon = {
  id: dungeonId,
  title: 'OSINT',
  description: 'Entity correlation and dossiers over Atlas jobs, CAS, Nexus, and Authority.',
} as const;

export { OSINT_DUNGEON } from './registration.ts';
export { OsintService } from './service.ts';
export type { OsintActor } from './service.ts';
export type { PublicLookupPort } from './collector.ts';
export { DungeonError, GENERIC_DENY } from './errors.ts';
