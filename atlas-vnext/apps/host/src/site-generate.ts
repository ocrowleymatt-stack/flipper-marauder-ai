import { DEFAULT_OPERATIONAL_LIMITS, type RouteDecision, type SiteGeneratePort } from '@atlas-vnext/contracts';
import { classifyProviderFailure, ProviderHttpError } from '@atlas-vnext/execution';
import type { CapabilityRouter, ModelExecutor } from '@atlas-vnext/conversation';
import { PlatformHttpError } from './errors.ts';
import type { ResourceGuard } from './limits.ts';

const SYSTEM = `You write a single complete HTML5 document for a public website preview.
Return HTML only. No markdown fences. No JavaScript, iframes, or event handlers.
Include doctype, html lang, charset, viewport, a real title, and visible body copy matching the brief.
Keep the page family-friendly and production-quality.`;

export class NodeSiteGenerate implements SiteGeneratePort {
  constructor(
    private readonly router: CapabilityRouter,
    private readonly executor: ModelExecutor,
    private readonly resources?: ResourceGuard,
  ) {}

  async generateHtml(input: {
    brief: string;
    previousHtml?: string | null;
    signal?: AbortSignal;
    privacy?: 'any' | 'local_only';
    tenantId?: string;
  }): Promise<{ html: string }> {
    if (input.signal?.aborted) {
      throw abortError();
    }
    const tenantId = input.tenantId?.trim();
    const release = tenantId && this.resources ? this.resources.beginRun(tenantId) : () => {};
    try {
      const decision: RouteDecision = this.router.resolve('nexus/code', {
        requireCode: true,
        privacy: input.privacy ?? 'any',
      });
      let html = '';
      let generatedBytes = 0;
      const byteLimit = this.resources?.generatedByteLimit() ?? DEFAULT_OPERATIONAL_LIMITS.maxGeneratedBytes;
      try {
        const prompt = input.previousHtml
          ? `Existing HTML:\n${input.previousHtml.slice(0, 12_000)}\n\nRevision brief:\n${input.brief}\n\nWrite the complete revised HTML document now.`
          : `Site brief:\n${input.brief}\n\nWrite the HTML document now.`;
        for await (const chunk of this.executor.execute(
          decision,
          {
            prompt,
            systemPrompt: SYSTEM,
            signal: input.signal,
          },
          {
            onAttempt() {
              return undefined;
            },
          },
        )) {
          if (input.signal?.aborted) throw abortError();
          if (chunk.type === 'text' && chunk.text) {
            const extra = Buffer.byteLength(chunk.text, 'utf8');
            const projected = generatedBytes + extra;
            if (this.resources) this.resources.assertGeneratedOutput(projected);
            else if (projected > byteLimit) {
              throw new PlatformHttpError('payload_too_large', 'generated exceeds the configured limit.', 413);
            }
            generatedBytes = projected;
            html += chunk.text;
          }
        }
      } catch (err) {
        if (isAbort(err, input.signal)) throw abortError();
        if (err instanceof PlatformHttpError) throw err;
        const classified = classifyProviderFailure(err);
        const error = new Error(err instanceof Error ? err.message : String(err)) as Error & { code: string };
        error.code = classified.code;
        if (err instanceof ProviderHttpError) error.code = err.failure.code;
        throw error;
      }
      if (!html.trim()) {
        const error = new Error('Model returned no HTML.') as Error & { code: string };
        error.code = 'empty_html';
        throw error;
      }
      return { html };
    } finally {
      release();
    }
  }
}

function abortError(): Error & { code: string } {
  const error = new Error('aborted') as Error & { code: string };
  error.code = 'aborted';
  return error;
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!err || typeof err !== 'object') return false;
  const code = 'code' in err ? String((err as { code?: string }).code) : '';
  if (code === 'cancelled' || code === 'aborted') return true;
  return err instanceof Error && /aborted|AbortError|cancelled/i.test(`${err.name} ${err.message}`);
}
