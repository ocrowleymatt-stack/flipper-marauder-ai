import { CASPA_WRITING_DUNGEON } from '@atlas-vnext/dungeon-writing';
import { OSINT_DUNGEON } from '@atlas-vnext/dungeon-osint';
import { INVESTIGATION_DUNGEON } from '@atlas-vnext/dungeon-investigation';
import { RESEARCH_DUNGEON } from '@atlas-vnext/dungeon-research';
import { WEBSITE_DUNGEON } from '@atlas-vnext/dungeon-website';
import { MUSIC_DUNGEON } from '@atlas-vnext/dungeon-music';
import { PRIVACY_DUNGEON } from '@atlas-vnext/dungeon-privacy';
import type { DungeonRegistration } from '@atlas-vnext/contracts';

export const REGISTERED_DUNGEONS: DungeonRegistration[] = [
  CASPA_WRITING_DUNGEON,
  OSINT_DUNGEON,
  INVESTIGATION_DUNGEON,
  RESEARCH_DUNGEON,
  WEBSITE_DUNGEON,
  MUSIC_DUNGEON,
  PRIVACY_DUNGEON,
];

/**
 * Host-owned catalogue. Dungeons register identity here; they do not own HTTP.
 */
export function dungeonCatalogue(registrations: DungeonRegistration[] = REGISTERED_DUNGEONS): DungeonRegistration[] {
  const seen = new Set<string>();
  const out: DungeonRegistration[] = [];
  for (const item of registrations) {
    if (seen.has(item.id) || !item.featureAvailable) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}
