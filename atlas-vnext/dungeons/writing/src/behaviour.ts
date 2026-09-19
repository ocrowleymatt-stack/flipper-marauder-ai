import {
  WRITING_PROMPT_PRECEDENCE,
  isFindingsOnlyOperation,
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
  'Caspa writing behaviour: this is a novelist\'s room. Produce durable manuscript text or structured findings for the requested operation. Prefer continuity with the current revision, story bible, and named characters. Do not chat around the task. Do not invent file sources. Do not mention infrastructure, runtimes, vendor lists, or numeric quality scores.';

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
    edit: 'Commit the supplied editor text as a new user-authored revision.',
    outline: 'Produce a structured outline for the current document or instruction.',
    continue_scene: 'Continue the current scene in the same voice, tense, and POV. Stay in the scene. Do not summarise.',
    draft_scene: 'Draft the requested scene as manuscript prose, using bible/character/structure context only where relevant.',
    rewrite_selection: 'Rewrite only the selected passage. Preserve surrounding continuity. Return the replacement passage.',
    tighten: 'Tighten the prose: cut filler, keep meaning, keep voice.',
    dialogue: 'Dialogue pass: sharpen speech, subtext, and character distinction. Keep attribution light.',
    description: 'Description pass: sensory, specific, in-voice. Do not stall the scene.',
    character_voice: 'Rewrite so the focal character\'s voice, diction, and want are unmistakable.',
    continuity_check:
      'Do NOT rewrite the manuscript. Report continuity concerns as findings with explanation and a manuscript quote or location. Cover character consistency, timeline, and world rules. No numeric scores.',
    critique:
      'Do NOT rewrite the manuscript. Critique as findings about reader attachment, tension, curiosity, expectation, emotional trajectory, pacing, payoff, character consistency, and narrative voice. Each finding needs a concern, explanation, and manuscript reference. No 0–100 scores.',
    repair_from_critique:
      'Repair the manuscript from the supplied critique/continuity findings. Change only what the findings require. Keep voice. Produce the full revised manuscript.',
  };
  const extra = isFindingsOnlyOperation(operation)
    ? '\n\nReturn findings in markdown with headings. Do not output a rewritten chapter.'
    : '';
  return `${verbs[operation]}\n\nUser instruction:\n${instruction.trim()}${extra}`;
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
    'Current manuscript:',
    input.currentDocument.trim() || '(empty document)',
  ].join('\n\n');
  const layers = {
    capabilityPolicy: platform.layers.capabilityPolicy,
    runtimePolicy: platform.layers.runtimePolicy,
    behaviourPosture: platform.layers.behaviourPosture,
    dungeonWritingBehaviour: DUNGEON_WRITING_BEHAVIOUR,
    projectContext: input.projectContext.trim() || 'Project context: none selected. Do not dump the whole novel.',
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
    input.operation === 'outline' ||
    input.operation === 'draft_scene' ||
    input.operation === 'character_voice' ||
    input.operation === 'continuity_check' ||
    input.operation === 'critique' ||
    input.operation === 'repair_from_critique' ||
    longContext;
  const privacy = input.privacy ?? 'any';
  const latency =
    input.operation === 'shorten' || input.operation === 'tone' || input.operation === 'tighten' ? 'fast' : 'medium';
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
