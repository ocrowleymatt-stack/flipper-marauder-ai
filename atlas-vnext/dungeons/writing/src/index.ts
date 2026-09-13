import type { DungeonId } from '@atlas-vnext/contracts';

export const dungeonId: DungeonId = 'writing';

export const writingDungeon = {
  id: dungeonId,
  title: 'Writing',
  description: 'Manuscripts, claim ledgers, stylometry, and literary craft. Product code deferred.',
} as const;
