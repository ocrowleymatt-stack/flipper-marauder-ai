import { z } from 'zod';
import { dungeonIdSchema } from './dungeon-ids.ts';

export const writingOperationSchema = z.enum([
  'create',
  'rewrite',
  'shorten',
  'expand',
  'tone',
  'restructure',
  'correct',
  'continue',
  'transform',
  'restore',
  'edit',
  'outline',
  'continue_scene',
  'draft_scene',
  'rewrite_selection',
  'tighten',
  'dialogue',
  'description',
  'character_voice',
  'continuity_check',
  'critique',
  'repair_from_critique',
]);
export type WritingOperation = z.infer<typeof writingOperationSchema>;

/** Operations that write a manuscript revision. */
export const MANUSCRIPT_MUTATING_OPERATIONS: readonly WritingOperation[] = [
  'create',
  'rewrite',
  'shorten',
  'expand',
  'tone',
  'restructure',
  'correct',
  'continue',
  'transform',
  'restore',
  'edit',
  'outline',
  'continue_scene',
  'draft_scene',
  'rewrite_selection',
  'tighten',
  'dialogue',
  'description',
  'character_voice',
  'repair_from_critique',
];

/** Operations that record findings without overwriting manuscript content. */
export const FINDINGS_ONLY_OPERATIONS: readonly WritingOperation[] = ['continuity_check', 'critique'];

export function isFindingsOnlyOperation(operation: WritingOperation): boolean {
  return (FINDINGS_ONLY_OPERATIONS as readonly string[]).includes(operation);
}

export const documentStatusSchema = z.enum([
  'idle',
  'requested',
  'running',
  'streaming',
  'candidate',
  'committed',
  'failed',
]);
export type DocumentStatus = z.infer<typeof documentStatusSchema>;

export const writingPromptLayerSchema = z.enum([
  'capabilityPolicy',
  'runtimePolicy',
  'behaviourPosture',
  'dungeonWritingBehaviour',
  'projectContext',
  'requestInstructions',
]);
export type WritingPromptLayer = z.infer<typeof writingPromptLayerSchema>;

/** Later layers refine the task. They cannot strip capability or runtime policy. */
export const WRITING_PROMPT_PRECEDENCE: readonly WritingPromptLayer[] = [
  'capabilityPolicy',
  'runtimePolicy',
  'behaviourPosture',
  'dungeonWritingBehaviour',
  'projectContext',
  'requestInstructions',
];

export const writingRouteRequirementsSchema = z.object({
  target: z.enum([
    'nexus/fast',
    'nexus/reason',
    'nexus/code',
    'nexus/vision',
    'nexus/cheap',
    'nexus/local',
    'nexus/frontier',
  ]),
  contextTokens: z.number().int().positive(),
  requireTools: z.boolean(),
  requireReasoning: z.boolean(),
  requireCode: z.boolean().default(false),
  requireVision: z.boolean().default(false),
  privacy: z.enum(['any', 'local_only']),
  quality: z.enum(['standard', 'high']),
  latency: z.enum(['fast', 'medium', 'slow']),
});
export type WritingRouteRequirements = z.infer<typeof writingRouteRequirementsSchema>;

export const dungeonRegistrationSchema = z.object({
  id: dungeonIdSchema,
  slug: z.string().min(1),
  title: z.string().min(1),
  navLabel: z.string().min(1),
  description: z.string().min(1),
  surface: z.string().min(1),
  routes: z.record(z.string(), z.string().min(1)),
  capabilities: z.array(z.string().min(1)).min(1),
  permissions: z.object({
    read: z.string().min(1),
    write: z.string().min(1),
  }),
  featureAvailable: z.boolean(),
  ownerOnly: z.boolean().optional(),
});
export type DungeonRegistration = z.infer<typeof dungeonRegistrationSchema>;

export const writingDocumentSchema = z.object({
  id: z.string().min(1),
  urn: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  status: documentStatusSchema,
  currentVersion: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  content: z.string(),
  draft: z.string().nullable(),
  currentContentHash: z.string().nullable(),
  draftContentHash: z.string().nullable(),
  originatingRunId: z.string().nullable(),
  conversationId: z.string().nullable(),
  failure: z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
      retryable: z.boolean(),
      at: z.string(),
    })
    .nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WritingDocument = z.infer<typeof writingDocumentSchema>;

export const writingDocumentVersionSchema = z.object({
  id: z.string().min(1),
  documentId: z.string().min(1),
  version: z.number().int().positive(),
  contentHash: z.string().min(1),
  artefactId: z.string().min(1),
  title: z.string().min(1),
  operation: writingOperationSchema,
  executionId: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
});
export type WritingDocumentVersion = z.infer<typeof writingDocumentVersionSchema>;

export const writingCompanionKindSchema = z.enum([
  'outline',
  'canon',
  'claims',
  'quality',
  'story_bible',
  'character',
  'world',
  'structure',
  'continuity',
  'critique',
  'creative_lineage',
]);
export type WritingCompanionKind = z.infer<typeof writingCompanionKindSchema>;

/** Document-scoped notes. Novel records and creative lineage are not companions. */
export const DOCUMENT_COMPANION_KINDS = ['outline', 'canon', 'claims', 'quality'] as const;
export type DocumentCompanionKind = (typeof DOCUMENT_COMPANION_KINDS)[number];

export function isDocumentCompanionKind(kind: string): kind is DocumentCompanionKind {
  return (DOCUMENT_COMPANION_KINDS as readonly string[]).includes(kind);
}

export const storyBibleSchema = z.object({
  premise: z.string().default(''),
  genre: z.string().default(''),
  tone: z.string().default(''),
  pov: z.string().default(''),
  tense: z.string().default(''),
  styleNotes: z.string().default(''),
  themes: z.array(z.string()).default([]),
  settingRules: z.string().default(''),
});
export type StoryBible = z.infer<typeof storyBibleSchema>;

export const characterRecordSchema = z.object({
  name: z.string().min(1),
  role: z.string().default(''),
  want: z.string().default(''),
  need: z.string().default(''),
  voice: z.string().default(''),
  notes: z.string().default(''),
});
export type CharacterRecord = z.infer<typeof characterRecordSchema>;

export const worldRecordSchema = z.object({
  name: z.string().min(1),
  rules: z.string().default(''),
  notes: z.string().default(''),
});
export type WorldRecord = z.infer<typeof worldRecordSchema>;

export const structureSceneSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  documentId: z.string().nullable().default(null),
  summary: z.string().default(''),
});
export type StructureScene = z.infer<typeof structureSceneSchema>;

export const structureChapterSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  documentId: z.string().nullable().default(null),
  summary: z.string().default(''),
  scenes: z.array(structureSceneSchema).default([]),
});
export type StructureChapter = z.infer<typeof structureChapterSchema>;

export const novelStructureSchema = z.object({
  chapters: z.array(structureChapterSchema).default([]),
});
export type NovelStructure = z.infer<typeof novelStructureSchema>;

export const readerExperienceLensSchema = z.enum([
  'attachment',
  'tension',
  'curiosity',
  'expectation',
  'emotion',
  'pacing',
  'payoff',
  'character_consistency',
  'voice',
]);
export type ReaderExperienceLens = z.infer<typeof readerExperienceLensSchema>;

export const writingFindingSchema = z.object({
  concern: z.string().min(1),
  explanation: z.string().min(1),
  manuscriptQuote: z.string().default(''),
  location: z.string().default(''),
  lens: readerExperienceLensSchema.optional(),
});
export type WritingFinding = z.infer<typeof writingFindingSchema>;

export const writingContextRefSchema = z.object({
  kind: writingCompanionKindSchema,
  id: z.string().min(1),
  title: z.string().min(1),
  contentHash: z.string().nullable().default(null),
  chars: z.number().int().nonnegative().default(0),
});
export type WritingContextRef = z.infer<typeof writingContextRefSchema>;

export const writingContextManifestSchema = z.object({
  documentId: z.string().min(1),
  operation: writingOperationSchema,
  selectionChars: z.number().int().nonnegative().default(0),
  fileIds: z.array(z.string()).default([]),
  refs: z.array(writingContextRefSchema).default([]),
});
export type WritingContextManifest = z.infer<typeof writingContextManifestSchema>;

export const creativeLineageSchema = z.object({
  documentId: z.string().min(1),
  version: z.number().int().nonnegative(),
  versionId: z.string().nullable().default(null),
  parentVersion: z.number().int().nonnegative().nullable().default(null),
  operation: writingOperationSchema,
  executionId: z.string().nullable().default(null),
  context: writingContextManifestSchema.optional(),
  createdBy: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type CreativeLineage = z.infer<typeof creativeLineageSchema>;
