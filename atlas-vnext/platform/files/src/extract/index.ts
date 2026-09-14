import { UnsupportedMediaError } from '../errors.ts';
import type { AllowedMime } from '../mime.ts';
import { extractCsv } from './csv.ts';
import { extractDocx } from './docx.ts';
import { extractJson } from './json.ts';
import { extractPdf } from './pdf.ts';
import { extractPlainText } from './text.ts';
import type { ExtractionResult } from './types.ts';

export { EXTRACTOR_ID, EXTRACTOR_VERSION, estimateTokens } from './types.ts';
export type { ExtractedBlock, ExtractionResult } from './types.ts';
export { buildSimplePdf } from './pdf.ts';
export { buildSimpleDocx } from './docx.ts';

export function extractBytes(bytes: Uint8Array, mime: AllowedMime, path: string): ExtractionResult {
  switch (mime) {
    case 'text/plain':
      return extractPlainText(bytes, path, false);
    case 'text/markdown':
      return extractPlainText(bytes, path, true);
    case 'text/csv':
      return extractCsv(bytes, path);
    case 'application/json':
      return extractJson(bytes, path);
    case 'application/pdf':
      return extractPdf(bytes, path);
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return extractDocx(bytes, path);
    default:
      throw new UnsupportedMediaError(`No extractor for ${mime}.`);
  }
}
