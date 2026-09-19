import type { SiteAudit } from './audit.ts';

export function composeWebsiteReport(input: {
  title: string;
  siteId: string;
  source: 'model' | 'assembler';
  note?: string;
  audit: SiteAudit;
  html: string;
}): string {
  const lines = [
    `Website preview ready: ${input.title}.`,
    input.source === 'model'
      ? 'Atlas generated HTML from the brief and stored it in CAS.'
      : 'Atlas assembled a first-draft page from the brief and stored it in CAS.',
  ];
  if (input.note) lines.push(input.note);
  lines.push(input.audit.ok ? 'Audit passed (no script, title, lang, viewport).' : `Audit notes: ${input.audit.findings.join(' ')}`);
  lines.push('This is a preview, not production. Publishing still requires owner Authority.');
  lines.push('Open Website in the sidebar to see the sandboxed preview, or ask to show the preview.');
  const excerpt = input.html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
  if (excerpt) lines.push(`Excerpt: ${excerpt}`);
  return lines.join('\n');
}

export function isContentFilterError(err: unknown): boolean {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: string }).code) : '';
  const message = err instanceof Error ? err.message : String(err);
  return code === 'content_filter' || /content filter/i.test(message);
}
