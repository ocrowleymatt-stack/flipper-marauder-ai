import type { DungeonId } from '@atlas-vnext/contracts';

export const dungeonId: DungeonId = 'writing';

export const writingDungeon = {
  id: dungeonId,
  title: 'Writing',
  description: 'Caspa writing dungeon: durable documents over platform primitives.',
} as const;
