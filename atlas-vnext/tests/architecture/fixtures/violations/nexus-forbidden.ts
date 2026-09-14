/**
 * Fixture kept as a readable example of a graph the checker must reject.
 * Not part of the production import graph (tests/architecture/fixtures is skipped).
 */
import { writingDungeon } from '@atlas-vnext/dungeon-writing';

export async function illegallyProbeFromNexus() {
  await fetch('https://api.openai.com/v1/models');
  return writingDungeon;
}
