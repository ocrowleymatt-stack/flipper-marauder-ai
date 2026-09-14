import { ExtractionError } from '../errors.ts';
import type { ExtractedBlock, ExtractionResult } from './types.ts';

export function extractPlainText(bytes: Uint8Array, path: string, markdown: boolean): ExtractionResult {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  const blocks: ExtractedBlock[] = [];
  let offset = 0;
  let heading: string | undefined;
  const headings: string[] = [];
  for (const part of text.split(/\n\n+/)) {
    const start = text.indexOf(part, offset);
    const end = start + part.length;
    offset = end;
    const headingMatch = markdown ? part.match(/^#{1,6}\s+(.+)$/m) : null;
    if (headingMatch?.[1]) {
      heading = headingMatch[1].trim();
      headings.push(heading);
    }
    if (part.trim()) {
      blocks.push({
        text: part,
        locator: { path, startOffset: start, endOffset: end, heading },
      });
    }
  }
  return {
    text,
    blocks,
    pageCount: null,
    structure: { kind: markdown ? 'markdown' : 'text', headings },
  };
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ExtractionError('File is not valid UTF-8 text.');
  }
}
