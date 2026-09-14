import { inflateSync } from 'node:zlib';
import { ExtractionError } from '../errors.ts';
import type { ExtractionResult } from './types.ts';

const JS_HINT = /\/(JS|JavaScript|OpenAction|AA|RichMedia)\b/;

function decodePdfString(raw: string): string {
  return raw
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

function extractFromContent(content: string): string {
  const parts: string[] = [];
  const tj = /\((?:\\.|[^\\)])*\)\s*Tj/g;
  for (const match of content.matchAll(tj)) {
    const inner = match[0].slice(1, match[0].lastIndexOf(')'));
    parts.push(decodePdfString(inner));
  }
  const tjArray = /\[(.*?)\]\s*TJ/gs;
  for (const match of content.matchAll(tjArray)) {
    const body = match[1] ?? '';
    for (const str of body.matchAll(/\((?:\\.|[^\\)])*\)/g)) {
      parts.push(decodePdfString(str[0].slice(1, -1)));
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function inflateStream(stream: Uint8Array): string {
  try {
    return new TextDecoder('latin1').decode(inflateSync(stream));
  } catch {
    return new TextDecoder('latin1').decode(stream);
  }
}

/**
 * Text-layer PDF extractor. Does not execute JavaScript, OpenAction, or annotations.
 * Image-only PDFs fail clearly (no OCR).
 */
export function extractPdf(bytes: Uint8Array, path: string): ExtractionResult {
  const latin = new TextDecoder('latin1').decode(bytes);
  if (!latin.startsWith('%PDF')) {
    throw new ExtractionError('Bytes are not a PDF.');
  }
  const pages: string[] = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (const match of latin.matchAll(streamRe)) {
    const aroundStart = Math.max(0, (match.index ?? 0) - 200);
    const header = latin.slice(aroundStart, match.index);
    if (JS_HINT.test(header)) continue;
    const payload = match[1] ?? '';
    const raw = new TextEncoder().encode(payload);
    const content = /\/Filter\s*\/FlateDecode/.test(header) ? inflateStream(raw) : payload;
    if (JS_HINT.test(content)) continue;
    const text = extractFromContent(content);
    if (text) pages.push(text);
  }
  if (pages.length === 0) {
    const fallback = extractFromContent(latin);
    if (!fallback) {
      throw new ExtractionError('PDF has no extractable text layer (OCR is not supported).');
    }
    pages.push(fallback);
  }
  const blocks = pages.map((text, index) => ({
    text,
    locator: {
      path,
      startOffset: index,
      endOffset: index + 1,
      page: index + 1,
    },
  }));
  return {
    text: pages.map((text, index) => `page ${index + 1}: ${text}`).join('\n\n'),
    blocks,
    pageCount: pages.length,
    structure: { kind: 'pdf', pages: pages.length, javascriptIgnored: true },
  };
}

export function buildSimplePdf(pages: string[]): Uint8Array {
  const objects: string[] = [];
  objects.push('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n');
  const pageIds = pages.map((_, i) => 3 + i * 2);
  objects.push(
    `2 0 obj << /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >> endobj\n`,
  );
  let fontId = 3 + pages.length * 2;
  pages.forEach((text, index) => {
    const pageId = 3 + index * 2;
    const contentId = pageId + 1;
    const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
    objects.push(
      `${pageId} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >> endobj\n`,
    );
    objects.push(
      `${contentId} 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj\n`,
    );
  });
  objects.push(`${fontId} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n`);
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(body.length);
    body += obj;
  }
  const xrefStart = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(body + xref + trailer);
}
