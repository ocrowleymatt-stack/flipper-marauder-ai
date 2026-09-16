import { CASPA_WRITING_DUNGEON } from '@atlas-vnext/dungeon-writing';
import type { DungeonRegistration } from '@atlas-vnext/contracts';

/**
 * Host-owned catalogue. Dungeons register identity here; they do not own HTTP.
 * Additional dungeon packages append to this list from the composition root.
 */
export function dungeonCatalogue(registrations: DungeonRegistration[] = [CASPA_WRITING_DUNGEON]): DungeonRegistration[] {
  const seen = new Set<string>();
  const out: DungeonRegistration[] = [];
  for (const item of registrations) {
    if (seen.has(item.id) || !item.featureAvailable) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}
