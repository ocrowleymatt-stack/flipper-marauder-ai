export interface StoryBibleCharacter {
  name: string;
  facts: string;
}

export interface StoryBiblePayload {
  premise?: string;
  characters?: StoryBibleCharacter[];
  world?: string;
  facts?: string[];
  continuity?: string[];
  voice?: string;
  relationships?: string[];
}

export const STORY_BIBLE_BUDGET = 4000;
const PREMISE_CAP = 800;
const CHARACTER_CAP = 1200;
const WORLD_CAP = 800;
const FACTS_CAP = 800;
const CONTINUITY_CAP = 800;
const VOICE_CAP = 400;

export const EMPTY_STORY_BIBLE: StoryBiblePayload = {
  premise: '',
  characters: [],
  world: '',
  facts: [],
  continuity: [],
  voice: '',
  relationships: [],
};

export function parseStoryBiblePayload(value: unknown): StoryBiblePayload {
  if (!value || typeof value !== 'object') return { ...EMPTY_STORY_BIBLE };
  const row = value as Record<string, unknown>;
  return {
    premise: typeof row.premise === 'string' ? row.premise : '',
    world: typeof row.world === 'string' ? row.world : '',
    voice: typeof row.voice === 'string' ? row.voice : '',
    facts: stringList(row.facts),
    continuity: stringList(row.continuity),
    relationships: stringList(row.relationships),
    characters: Array.isArray(row.characters)
      ? row.characters
          .map((item) => {
            if (!item || typeof item !== 'object') return null;
            const character = item as Record<string, unknown>;
            const name = typeof character.name === 'string' ? character.name.trim() : '';
            const facts = typeof character.facts === 'string' ? character.facts.trim() : '';
            if (!name && !facts) return null;
            return { name: name || 'Unnamed', facts };
          })
          .filter((item): item is StoryBibleCharacter => Boolean(item))
      : [],
  };
}

export function mergeStoryBible(base: StoryBiblePayload, patch: StoryBiblePayload): StoryBiblePayload {
  const characters = [...(base.characters ?? [])];
  for (const incoming of patch.characters ?? []) {
    const idx = characters.findIndex((item) => item.name.toLowerCase() === incoming.name.toLowerCase());
    if (idx >= 0) characters[idx] = { ...characters[idx], ...incoming };
    else characters.push(incoming);
  }
  return {
    premise: patch.premise?.trim() || base.premise || '',
    world: patch.world?.trim() || base.world || '',
    voice: patch.voice?.trim() || base.voice || '',
    facts: uniqueStrings([...(base.facts ?? []), ...(patch.facts ?? [])]),
    continuity: uniqueStrings([...(base.continuity ?? []), ...(patch.continuity ?? [])]),
    relationships: uniqueStrings([...(base.relationships ?? []), ...(patch.relationships ?? [])]),
    characters,
  };
}

export function replaceStoryBible(base: StoryBiblePayload, patch: StoryBiblePayload): StoryBiblePayload {
  return {
    premise: patch.premise !== undefined ? patch.premise.trim() : base.premise || '',
    world: patch.world !== undefined ? patch.world.trim() : base.world || '',
    voice: patch.voice !== undefined ? patch.voice.trim() : base.voice || '',
    facts: patch.facts !== undefined ? uniqueStrings(patch.facts) : [...(base.facts ?? [])],
    continuity: patch.continuity !== undefined ? uniqueStrings(patch.continuity) : [...(base.continuity ?? [])],
    relationships: patch.relationships !== undefined ? uniqueStrings(patch.relationships) : [...(base.relationships ?? [])],
    characters: patch.characters !== undefined ? patch.characters : [...(base.characters ?? [])],
  };
}

export function assembleStoryBible(input: {
  bible: StoryBiblePayload;
  instruction?: string;
  currentDocument?: string;
  budget?: number;
}): { text: string; usedChars: number; truncated: boolean } {
  const budget = input.budget ?? STORY_BIBLE_BUDGET;
  const query = `${input.instruction ?? ''} ${input.currentDocument ?? ''}`.toLowerCase();
  const sections: string[] = [];
  pushCapped(sections, 'Premise', input.bible.premise, PREMISE_CAP);
  const characters = rankCharacters(input.bible.characters ?? [], query).slice(0, 6);
  if (characters.length) {
    const body = characters.map((item) => `- ${item.name}: ${item.facts}`.trim()).join('\n');
    pushCapped(sections, 'Characters', body, CHARACTER_CAP);
  }
  pushCapped(sections, 'World', input.bible.world, WORLD_CAP);
  pushCapped(sections, 'Facts', (input.bible.facts ?? []).map((item) => `- ${item}`).join('\n'), FACTS_CAP);
  pushCapped(
    sections,
    'Continuity',
    (input.bible.continuity ?? []).map((item) => `- ${item}`).join('\n'),
    CONTINUITY_CAP,
  );
  pushCapped(sections, 'Voice', input.bible.voice, VOICE_CAP);
  const joined = sections.filter(Boolean).join('\n\n');
  if (!joined.trim()) return { text: '', usedChars: 0, truncated: false };
  const header = 'Story bible (durable project canon — respect these facts):';
  const full = `${header}\n${joined}`;
  if (full.length <= budget) return { text: full, usedChars: full.length, truncated: false };
  return { text: full.slice(0, budget), usedChars: budget, truncated: true };
}

function rankCharacters(characters: StoryBibleCharacter[], query: string): StoryBibleCharacter[] {
  return [...characters].sort((a, b) => Number(mentioned(b.name, query)) - Number(mentioned(a.name, query)));
}

function mentioned(name: string, query: string): boolean {
  const token = name.trim().split(/\s+/)[0]?.toLowerCase();
  return Boolean(token && token.length > 2 && query.includes(token));
}

function pushCapped(sections: string[], heading: string, body: string | undefined, cap: number): void {
  const text = (body ?? '').trim();
  if (!text) return;
  sections.push(`${heading}:\n${text.slice(0, cap)}`);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()));
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.trim();
    if (!key) continue;
    const id = key.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(key);
  }
  return out;
}
