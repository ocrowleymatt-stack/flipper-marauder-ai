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
  'refine',
]);
export type WritingOperation = z.infer<typeof writingOperationSchema>;

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
