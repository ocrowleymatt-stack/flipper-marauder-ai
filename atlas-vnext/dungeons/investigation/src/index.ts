import type { DungeonId } from '@atlas-vnext/contracts';

export const dungeonId: DungeonId = 'investigation';

export const investigationDungeon = {
  id: dungeonId,
  title: 'Investigation',
  description: 'Evidential agents and caseboards. Product code deferred.',
} as const;
