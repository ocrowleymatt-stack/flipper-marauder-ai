import {
  WRITING_PROMPT_PRECEDENCE,
  writingRouteRequirementsSchema,
  type WritingOperation,
  type WritingRouteRequirements,
} from '@atlas-vnext/contracts';
import { composeBehaviourPrompt } from '@atlas-vnext/permissions';

export const WRITING_CAPABILITY_POLICY =
  'Capability policy: Nexus decides WHERE this writing run goes from declared requirements (context, tools, quality, latency, privacy). Caspa does not name providers.';

export const WRITING_RUNTIME_POLICY =
  'Runtime policy: Execution owns transport, retries, and failover. Failover is allowed only before visible output. After visible output, do not silently switch providers. Continuation after a visible failure is a new run.';

export const DUNGEON_WRITING_BEHAVIOUR =
  'Caspa writing behaviour: produce durable document text for the requested operation. Prefer continuity with the current revision. Do not chat around the task. Do not invent file sources. Do not mention infrastructure, runtimes, or vendor lists.';

export function writingOperationInstruction(operation: WritingOperation, instruction: string): string {
  const verbs: Record<WritingOperation, string> = {
    create: 'Create a new document from the instruction and supplied context.',
    rewrite: 'Rewrite the current document according to the instruction.',
    shorten: 'Shorten the current document while preserving meaning.',
    expand: 'Expand the current document according to the instruction.',
    tone: 'Adjust the tone of the current document according to the instruction.',
    restructure: 'Restructure the current document according to the instruction.',
    correct: 'Correct errors in the current document according to the instruction.',
    continue: 'Continue the current document as a revision, not as a chat reply.',
    transform: 'Transform the current document according to the instruction.',
    restore: 'Restore the selected prior revision as a new version.',
  };
  return `${verbs[operation]}\n\nUser instruction:\n${instruction.trim()}`;
}

export function composeWritingPrompt(input: {
  behaviour: 'standard' | 'open';
  projectContext: string;
  operation: WritingOperation;
  instruction: string;
  currentDocument: string;
}): { layers: Record<(typeof WRITING_PROMPT_PRECEDENCE)[number], string>; text: string; precedence: typeof WRITING_PROMPT_PRECEDENCE } {
  const platform = composeBehaviourPrompt({
    behaviour: input.behaviour,
    capabilityPolicy: WRITING_CAPABILITY_POLICY,
    runtimePolicy: WRITING_RUNTIME_POLICY,
  });
  const requestInstructions = [
    writingOperationInstruction(input.operation, input.instruction),
    'Current document:',
    input.currentDocument.trim() || '(empty document)',
  ].join('\n\n');
  const layers = {
    capabilityPolicy: platform.layers.capabilityPolicy,
    runtimePolicy: platform.layers.runtimePolicy,
    behaviourPosture: platform.layers.behaviourPosture,
    dungeonWritingBehaviour: DUNGEON_WRITING_BEHAVIOUR,
    projectContext: input.projectContext.trim() || 'Project context: none selected.',
    requestInstructions,
  };
  return {
    layers,
    precedence: WRITING_PROMPT_PRECEDENCE,
    text: WRITING_PROMPT_PRECEDENCE.map((layer) => layers[layer]).join('\n\n'),
  };
}

export function writingRouteRequirements(input: {
  operation: WritingOperation;
  contentChars: number;
  selectedFileCount: number;
  privacy?: 'any' | 'local_only';
  tools?: boolean;
}): WritingRouteRequirements {
  const longContext = input.contentChars + input.selectedFileCount * 4000 > 8000;
  const qualityHigh =
    input.operation === 'restructure' ||
    input.operation === 'correct' ||
    input.operation === 'transform' ||
    input.operation === 'create' ||
    longContext;
  const privacy = input.privacy ?? 'any';
  const latency = input.operation === 'shorten' || input.operation === 'tone' ? 'fast' : 'medium';
  const target =
    privacy === 'local_only' ? 'nexus/local' : qualityHigh ? 'nexus/reason' : latency === 'fast' ? 'nexus/fast' : 'nexus/reason';
  return writingRouteRequirementsSchema.parse({
    target,
    contextTokens: Math.max(2048, Math.ceil((input.contentChars + 2000) / 3) + input.selectedFileCount * 512),
    requireTools: Boolean(input.tools),
    requireReasoning: qualityHigh,
    requireCode: false,
    requireVision: false,
    privacy,
    quality: qualityHigh ? 'high' : 'standard',
    latency,
  });
}
