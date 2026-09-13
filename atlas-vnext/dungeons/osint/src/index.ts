import type { DungeonId } from '@atlas-vnext/contracts';

export const dungeonId: DungeonId = 'osint';

export const osintDungeon = {
  id: dungeonId,
  title: 'OSINT',
  description: 'Entity correlation and dossiers. Product code deferred.',
} as const;
