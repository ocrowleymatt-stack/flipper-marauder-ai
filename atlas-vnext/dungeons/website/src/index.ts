import type { DungeonId } from '@atlas-vnext/contracts';

export const dungeonId: DungeonId = 'website';

export const websiteDungeon = {
  id: dungeonId,
  title: 'Website Studio',
  description: 'Site generation and audits. Product code deferred.',
} as const;
