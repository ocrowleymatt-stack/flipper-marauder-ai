import type {
  DungeonExecutionContext,
  DungeonManifest,
  IDungeonPlugin,
} from '@atlas/core-contracts';

export const AI_FOG_PATTERNS = [
  /\bin today's (?:fast[- ]paced|ever[- ]changing) world\b/gi,
  /\bit is important to (?:note|remember|understand) that\b/gi,
  /\bdelve(?:s|d|ing)? into\b/gi,
  /\btapestry of\b/gi,
  /\btestament to\b/gi,
  /\bjourney of (?:self[- ]discovery|discovery|transformation)\b/gi,
  /\bcomplex interplay\b/gi,
];

export interface QualityGateResult {
  score: number;
  status: 'pass' | 'warn' | 'fail';
  fogMatches: number;
  wordCount: number;
  issues: string[];
}

export function evaluateTextQuality(content: string): QualityGateResult {
  let fogCount = 0;
  for (const pattern of AI_FOG_PATTERNS) {
    fogCount += (content.match(pattern) || []).length;
  }

  const words = content.trim().split(/\s+/).filter(Boolean);
  const issues: string[] = [];

  if (fogCount > 0) {
    issues.push(`Detected ${fogCount} AI-smell / cliché stock phrases.`);
  }

  const score = Math.max(0, 100 - fogCount * 15);
  const status = score >= 80 ? 'pass' : score >= 50 ? 'warn' : 'fail';

  return {
    score,
    status,
    fogMatches: fogCount,
    wordCount: words.length,
    issues,
  };
}

export class DungeonCreative implements IDungeonPlugin {
  readonly manifest: DungeonManifest = {
    id: 'dungeon-creative',
    name: 'Creative Studio Dungeon',
    version: '0.1.0',
    description: 'Literary development, psychological narrative craft, and deterministic quality gates',
    capabilitiesProvided: ['creative:draft', 'creative:quality_gate', 'creative:plan'],
    requiredPermissions: ['permission:content_generate'],
  };

  async execute(
    taskType: string,
    payload: Readonly<Record<string, unknown>>,
    context: DungeonExecutionContext,
  ): Promise<Record<string, unknown>> {
    await context.reportProgress(10, 'Initializing creative studio pipeline');

    if (taskType === 'creative:quality_gate') {
      const text = String(payload.text || '');
      await context.reportProgress(50, 'Running AI-fog and narrative integrity checks');
      const result = evaluateTextQuality(text);
      await context.reportProgress(100, 'Quality gate analysis complete');
      return { result };
    }

    if (taskType === 'creative:draft') {
      const prompt = String(payload.prompt || '');
      await context.reportProgress(30, 'Routing draft prompt through Nexus Router');
      const response = await context.router.routePrompt(prompt, { maxTokens: 2000 });

      await context.reportProgress(70, 'Running output quality gate');
      const quality = evaluateTextQuality(response.text);

      await context.reportProgress(90, 'Storing draft to CAS');
      const blobDesc = await context.storage.put(response.text, 'text/markdown', {
        provider: response.provider,
        model: response.model,
      });

      await context.reportProgress(100, 'Draft generation and verification complete');

      return {
        text: response.text,
        blobHash: blobDesc.hash,
        quality,
        model: response.model,
      };
    }

    throw new Error(`Unsupported task type: ${taskType}`);
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true, message: 'Creative Studio Dungeon ready' };
  }
}
