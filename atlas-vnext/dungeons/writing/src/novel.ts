import {
  characterRecordSchema,
  creativeLineageSchema,
  isFindingsOnlyOperation,
  novelStructureSchema,
  storyBibleSchema,
  worldRecordSchema,
  writingFindingSchema,
  type CharacterRecord,
  type CreativeLineage,
  type NovelStructure,
  type StoryBible,
  type WorldRecord,
  type WritingCompanionKind,
  type WritingContextManifest,
  type WritingContextRef,
  type WritingFinding,
  type WritingOperation,
} from '@atlas-vnext/contracts';

export const NOVEL_KINDS = {
  storyBible: 'story_bible',
  character: 'character',
  world: 'world',
  structure: 'structure',
  continuity: 'continuity',
  critique: 'critique',
  lineage: 'creative_lineage',
} as const satisfies Record<string, WritingCompanionKind>;

export const PROJECT_NOVEL_KINDS: readonly WritingCompanionKind[] = [
  'story_bible',
  'character',
  'world',
  'structure',
  'continuity',
  'critique',
];

export { isFindingsOnlyOperation };

const BIBLE_SLICE = 1800;
const CHARACTER_SLICE = 700;
const WORLD_SLICE = 600;
const NEARBY_SLICE = 500;
const MAX_CHARACTERS = 4;
const MAX_WORLD = 2;
const MAX_FINDINGS = 5;

export function emptyStoryBible(): StoryBible {
  return storyBibleSchema.parse({});
}

export function emptyStructure(): NovelStructure {
  return novelStructureSchema.parse({ chapters: [] });
}

export function parseStoryBible(payload: Record<string, unknown> | undefined, text = ''): StoryBible {
  const parsed = storyBibleSchema.safeParse(payload ?? {});
  const bible = parsed.success ? parsed.data : emptyStoryBible();
  if (!bible.premise && text.trim()) return { ...bible, premise: text.trim() };
  return bible;
}

export function parseCharacter(payload: Record<string, unknown> | undefined, title: string): CharacterRecord {
  const parsed = characterRecordSchema.safeParse({ name: title, ...(payload ?? {}) });
  if (parsed.success) return parsed.data;
  return characterRecordSchema.parse({ name: title || 'Unnamed' });
}

export function parseWorld(payload: Record<string, unknown> | undefined, title: string): WorldRecord {
  const parsed = worldRecordSchema.safeParse({ name: title, ...(payload ?? {}) });
  if (parsed.success) return parsed.data;
  return worldRecordSchema.parse({ name: title || 'Setting' });
}

export function parseStructure(payload: Record<string, unknown> | undefined): NovelStructure {
  const parsed = novelStructureSchema.safeParse(payload ?? { chapters: [] });
  return parsed.success ? parsed.data : emptyStructure();
}

export function formatStoryBible(bible: StoryBible): string {
  const themes = bible.themes.filter((item) => item.trim()).join(', ');
  return [
    bible.premise && `Premise: ${bible.premise}`,
    bible.genre && `Genre: ${bible.genre}`,
    bible.tone && `Tone: ${bible.tone}`,
    bible.pov && `POV: ${bible.pov}`,
    bible.tense && `Tense: ${bible.tense}`,
    bible.styleNotes && `Style: ${bible.styleNotes}`,
    themes && `Themes: ${themes}`,
    bible.settingRules && `World rules: ${bible.settingRules}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatCharacter(character: CharacterRecord): string {
  return [
    `Character: ${character.name}`,
    character.role && `Role: ${character.role}`,
    character.want && `Want: ${character.want}`,
    character.need && `Need: ${character.need}`,
    character.voice && `Voice: ${character.voice}`,
    character.notes && `Notes: ${character.notes}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatWorld(world: WorldRecord): string {
  return [`Setting: ${world.name}`, world.rules && `Rules: ${world.rules}`, world.notes && `Notes: ${world.notes}`]
    .filter(Boolean)
    .join('\n');
}

export function selectRelevantCharacters(
  haystack: string,
  characters: Array<{ id: string; title: string; payload: Record<string, unknown>; contentHash: string | null }>,
): Array<{ id: string; title: string; payload: Record<string, unknown>; contentHash: string | null; text: string }> {
  const blob = haystack.toLowerCase();
  const scored = characters.map((row) => {
    const character = parseCharacter(row.payload, row.title);
    const name = character.name.trim();
    const mentioned = name.length >= 2 && blob.includes(name.toLowerCase());
    return { ...row, character, mentioned, text: formatCharacter(character) };
  });
  const mentioned = scored.filter((row) => row.mentioned);
  const chosen = (mentioned.length > 0 ? mentioned : scored).slice(0, MAX_CHARACTERS);
  return chosen.map(({ character: _c, mentioned: _m, ...rest }) => rest);
}

export function sliceText(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}…`;
}

export function parseFindings(text: string): WritingFinding[] {
  const blocks = text
    .split(/\n(?=#{1,3}\s|Finding\s+\d+|Concern:)/i)
    .map((block) => block.trim())
    .filter(Boolean);
  const findings: WritingFinding[] = [];
  for (const block of blocks) {
    const concern =
      block.match(/(?:^#{1,3}\s+|Concern:\s*)([^\n]+)/i)?.[1]?.trim() ||
      block.split('\n')[0]!.replace(/^[-*]\s+/, '').slice(0, 180);
    if (!concern) continue;
    const quote = block.match(/>\s*([^\n]+)|Quote:\s*([^\n]+)|“([^”]+)”/)?.[1] || block.match(/Quote:\s*([^\n]+)/i)?.[1] || '';
    const location = block.match(/Location:\s*([^\n]+)/i)?.[1]?.trim() || '';
    const lensMatch = block.match(
      /Lens:\s*(attachment|tension|curiosity|expectation|emotion|pacing|payoff|character_consistency|voice)/i,
    );
    const parsed = writingFindingSchema.safeParse({
      concern,
      explanation: sliceText(block, 800),
      manuscriptQuote: quote.trim(),
      location,
      lens: lensMatch?.[1]?.toLowerCase(),
    });
    if (parsed.success) findings.push(parsed.data);
    if (findings.length >= 12) break;
  }
  if (findings.length === 0 && text.trim()) {
    findings.push(
      writingFindingSchema.parse({
        concern: sliceText(text, 180),
        explanation: sliceText(text, 800),
      }),
    );
  }
  return findings;
}

export function assembleNovelContext(input: {
  operation: WritingOperation;
  instruction: string;
  currentDocument: string;
  selection?: string;
  bible?: { id: string; title: string; payload: Record<string, unknown>; contentHash: string | null; text?: string };
  characters?: Array<{ id: string; title: string; payload: Record<string, unknown>; contentHash: string | null }>;
  worlds?: Array<{ id: string; title: string; payload: Record<string, unknown>; contentHash: string | null }>;
  structure?: { id: string; title: string; payload: Record<string, unknown>; contentHash: string | null };
  nearbyChapter?: string;
  findings?: Array<{ id: string; title: string; payload: Record<string, unknown>; contentHash: string | null }>;
  fileContext?: string;
  fileIds?: string[];
  documentId: string;
}): { text: string; manifest: WritingContextManifest } {
  const haystack = [input.instruction, input.currentDocument, input.selection ?? ''].join('\n');
  const refs: WritingContextRef[] = [];
  const parts: string[] = [];

  if (input.bible) {
    const bible = parseStoryBible(input.bible.payload, input.bible.text ?? '');
    const text = sliceText(formatStoryBible(bible) || input.bible.text || '', BIBLE_SLICE);
    if (text) {
      parts.push(`Story bible:\n${text}`);
      refs.push({
        kind: 'story_bible',
        id: input.bible.id,
        title: input.bible.title,
        contentHash: input.bible.contentHash,
        chars: text.length,
      });
    }
  }

  const characters = selectRelevantCharacters(haystack, input.characters ?? []);
  for (const character of characters) {
    const text = sliceText(character.text, CHARACTER_SLICE);
    if (!text) continue;
    parts.push(text);
    refs.push({
      kind: 'character',
      id: character.id,
      title: character.title,
      contentHash: character.contentHash,
      chars: text.length,
    });
  }

  const worlds = (input.worlds ?? []).slice(0, MAX_WORLD);
  for (const row of worlds) {
    const world = parseWorld(row.payload, row.title);
    const text = sliceText(formatWorld(world), WORLD_SLICE);
    if (!text) continue;
    parts.push(text);
    refs.push({ kind: 'world', id: row.id, title: row.title, contentHash: row.contentHash, chars: text.length });
  }

  if (input.structure) {
    const structure = parseStructure(input.structure.payload);
    const outline = structure.chapters
      .map((chapter, index) => `${index + 1}. ${chapter.title}${chapter.documentId === input.documentId ? ' (current)' : ''}`)
      .join('\n');
    if (outline) {
      parts.push(`Structure:\n${outline}`);
      refs.push({
        kind: 'structure',
        id: input.structure.id,
        title: input.structure.title,
        contentHash: input.structure.contentHash,
        chars: outline.length,
      });
    }
  }

  if (input.nearbyChapter?.trim()) {
    parts.push(`Nearby chapter (tail):\n${sliceText(input.nearbyChapter, NEARBY_SLICE)}`);
  }

  const findings = (input.findings ?? []).slice(0, MAX_FINDINGS);
  if (findings.length) {
    parts.push(`Open continuity / critique findings:\n${findings.map((item) => `- ${item.title}`).join('\n')}`);
    for (const item of findings) {
      refs.push({
        kind: (item.payload.kind as WritingCompanionKind) || 'continuity',
        id: item.id,
        title: item.title,
        contentHash: item.contentHash,
        chars: item.title.length,
      });
    }
  }

  if (input.fileContext?.trim()) {
    parts.push(input.fileContext.trim());
  }

  if (input.selection?.trim()) {
    parts.push(`Selected manuscript passage:\n${sliceText(input.selection, 2000)}`);
  }

  const text = parts.join('\n\n').trim();
  const manifest: WritingContextManifest = {
    documentId: input.documentId,
    operation: input.operation,
    selectionChars: input.selection?.trim().length ?? 0,
    fileIds: input.fileIds ?? [],
    refs,
  };
  return { text, manifest };
}

export function lineageFrom(input: {
  documentId: string;
  version: number;
  versionId?: string | null;
  parentVersion?: number | null;
  operation: WritingOperation;
  executionId?: string | null;
  context?: WritingContextManifest;
  createdBy?: string | null;
  createdAt?: string;
}): CreativeLineage {
  return creativeLineageSchema.parse({
    documentId: input.documentId,
    version: input.version,
    versionId: input.versionId ?? null,
    parentVersion: input.parentVersion ?? null,
    operation: input.operation,
    executionId: input.executionId ?? null,
    context: input.context,
    createdBy: input.createdBy ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}
