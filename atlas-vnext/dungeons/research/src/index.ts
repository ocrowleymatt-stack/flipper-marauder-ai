import type { DungeonId } from '@atlas-vnext/contracts';

export const dungeonId: DungeonId = 'research';

export const researchDungeon = {
  id: dungeonId,
  title: 'Research',
  description: 'Federated search and synthesis. Product code deferred.',
} as const;
