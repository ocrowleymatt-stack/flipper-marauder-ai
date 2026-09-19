export interface SiteAudit {
  ok: boolean;
  findings: string[];
}

const FORBIDDEN = /<(script|iframe|object|embed|link\s[^>]*rel=["']?import)\b/i;
const HANDLERS = /\son[a-z]+\s*=/i;
const BAD_URL = /(javascript:|data:\s*text\/html)/i;

export function sanitizeSiteHtml(raw: string): string {
  let html = raw.replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/i, '').trim();
  html = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '');
  html = html.replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, '');
  html = html.replace(/\shref\s*=\s*(['"])\s*javascript:[\s\S]*?\1/gi, ' href="#"');
  return html.trim();
}

export function auditSiteHtml(html: string): SiteAudit {
  const findings: string[] = [];
  if (!/<!doctype html/i.test(html)) findings.push('Missing doctype.');
  if (!/<html\b[^>]*\blang=/i.test(html)) findings.push('Missing html lang.');
  if (!/<title>[^<]+<\/title>/i.test(html)) findings.push('Missing title.');
  if (!/<meta[^>]+charset/i.test(html)) findings.push('Missing charset.');
  if (!/<meta[^>]+viewport/i.test(html)) findings.push('Missing viewport.');
  const text = html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length < 40) findings.push('Not enough visible text.');
  if (FORBIDDEN.test(html)) findings.push('Forbidden embed or script.');
  if (HANDLERS.test(html)) findings.push('Inline event handler.');
  if (BAD_URL.test(html)) findings.push('Unsafe URL protocol.');
  return { ok: findings.length === 0, findings };
}
