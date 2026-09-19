import type { RouteDecision, SiteGeneratePort } from '@atlas-vnext/contracts';
import { classifyProviderFailure, ProviderHttpError } from '@atlas-vnext/execution';
import type { CapabilityRouter, ModelExecutor } from '@atlas-vnext/conversation';

const SYSTEM = `You write a single complete HTML5 document for a public website preview.
Return HTML only. No markdown fences. No JavaScript, iframes, or event handlers.
Include doctype, html lang, charset, viewport, a real title, and visible body copy matching the brief.
Keep the page family-friendly and production-quality.`;

export class NodeSiteGenerate implements SiteGeneratePort {
  constructor(
    private readonly router: CapabilityRouter,
    private readonly executor: ModelExecutor,
  ) {}

  async generateHtml(input: { brief: string; signal?: AbortSignal }): Promise<{ html: string; model?: string }> {
    const decision: RouteDecision = this.router.resolve('nexus/code', {
      requireCode: true,
      privacy: 'any',
    });
    let html = '';
    let model: string | undefined = decision.model;
    try {
      for await (const chunk of this.executor.execute(
        decision,
        {
          prompt: `Site brief:\n${input.brief}\n\nWrite the HTML document now.`,
          systemPrompt: SYSTEM,
          signal: input.signal,
        },
        {
          onAttempt() {
            return undefined;
          },
          onSelected(selection) {
            model = selection.model;
          },
        },
      )) {
        if (chunk.type === 'text' && chunk.text) html += chunk.text;
      }
    } catch (err) {
      const classified = classifyProviderFailure(err);
      const error = new Error(err instanceof Error ? err.message : String(err)) as Error & { code: string };
      error.code = classified.code;
      if (err instanceof ProviderHttpError) error.code = err.failure.code;
      throw error;
    }
    if (!html.trim()) {
      const error = new Error('Model returned no HTML.') as Error & { code: string };
      error.code = 'provider_error';
      throw error;
    }
    return { html, model };
  }
}
