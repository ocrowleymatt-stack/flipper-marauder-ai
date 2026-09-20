import type { SiteAudit } from './audit.ts';

export function composeWebsiteReport(input: {
  title: string;
  siteId: string;
  revision: number;
  source: 'model' | 'assembler';
  note?: string;
  audit: SiteAudit;
  html: string;
  libraryOk: boolean;
}): string {
  const lines = [
    `Website: ${input.title}`,
    `Site: ${input.siteId}`,
    `Revision: ${input.revision}`,
    'Status: preview ready',
    `Source: ${input.source === 'model' ? 'generated' : 'assembled'}`,
    input.audit.ok ? 'Audit: pass' : `Audit: ${input.audit.findings.join(' ')}`,
  ];
  if (input.note) lines.push(input.note);
  if (!input.libraryOk) {
    lines.push('Library publication was not completed; the site revision is still stored.');
  }
  lines.push('This is a preview, not production. Publishing still requires owner Authority.');
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

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = 'code' in err ? String((err as { code?: string }).code) : '';
  if (code === 'cancelled' || code === 'aborted') return true;
  return err instanceof Error && /aborted|AbortError|cancelled/i.test(`${err.name} ${err.message}`);
}
