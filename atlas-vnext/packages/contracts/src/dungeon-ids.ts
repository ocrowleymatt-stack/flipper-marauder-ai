import { z } from 'zod';

export const dungeonIdSchema = z.enum([
  'writing',
  'investigation',
  'research',
  'website',
  'osint',
  'music',
  'privacy',
]);
export type DungeonId = z.infer<typeof dungeonIdSchema>;
