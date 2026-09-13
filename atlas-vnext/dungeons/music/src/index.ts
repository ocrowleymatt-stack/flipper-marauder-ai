import type { DungeonId } from '@atlas-vnext/contracts';

export const dungeonId: DungeonId = 'music';

export const musicDungeon = {
  id: dungeonId,
  title: 'Music',
  description: 'Composition and release gates. Product code deferred.',
} as const;
