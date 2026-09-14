import { UnsupportedMediaError } from './errors.ts';

export const ALLOWED_MIME_TYPES = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

export type AllowedMime = (typeof ALLOWED_MIME_TYPES)[number];

const REJECTED_MIME = [
  'application/javascript',
  'text/javascript',
  'application/x-javascript',
  'application/x-msdownload',
  'application/x-executable',
  'application/x-elf',
  'application/x-mach-binary',
  'application/vnd.ms-word.document.macroenabled.12',
  'application/vnd.ms-excel.sheet.macroenabled.12',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'application/vnd.ms-word.document.macroEnabled.12',
];

const DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document' as const;

export function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return 'application/pdf';
  }
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    const asText = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
    if (asText.includes('word/document.xml')) return DOCX;
    return 'application/zip';
  }
  const prefix = new TextDecoder('utf8', { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, 512))).trimStart();
  if (prefix.startsWith('{') || prefix.startsWith('[')) return 'application/json';
  return null;
}

export function mimeFromFilename(filename: string): AllowedMime | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.docx')) return DOCX;
  return null;
}

export function isRejectedMime(mime: string): boolean {
  return REJECTED_MIME.includes(mime.toLowerCase()) || mime.toLowerCase().includes('macroenabled');
}

/**
 * MIME is authoritative over extension. Sniffed magic wins on conflict.
 * Extension is only a hint when bytes look like text.
 */
export function resolveMime(input: {
  bytes: Uint8Array;
  filename: string;
  declared?: string | null;
}): AllowedMime {
  const declared = input.declared?.split(';')[0]?.trim().toLowerCase() ?? null;
  if (declared && isRejectedMime(declared)) {
    throw new UnsupportedMediaError(`Refusing executable or macro-enabled upload (${declared}). Uploads are data.`);
  }
  const sniffed = sniffMime(input.bytes);
  if (sniffed === 'application/zip') {
    throw new UnsupportedMediaError('Generic ZIP archives are not ingested; DOCX is the only ZIP-based format.');
  }
  if (sniffed === 'application/pdf') {
    if (declared && declared !== 'application/pdf' && declared !== 'application/octet-stream') {
      throw new UnsupportedMediaError(`Declared MIME ${declared} does not match sniffed PDF.`);
    }
    return 'application/pdf';
  }
  if (sniffed === DOCX) {
    if (declared && declared !== DOCX && declared !== 'application/octet-stream' && declared !== 'application/zip') {
      throw new UnsupportedMediaError(`Declared MIME ${declared} does not match sniffed DOCX.`);
    }
    return DOCX;
  }
  if (sniffed === 'application/json') {
    if (declared && declared !== 'application/json' && declared !== 'text/plain') {
      throw new UnsupportedMediaError(`Declared MIME ${declared} does not match sniffed JSON.`);
    }
    return 'application/json';
  }
  const fromName = mimeFromFilename(input.filename);
  const candidate = (declared as AllowedMime | null) ?? fromName ?? 'text/plain';
  if (isRejectedMime(candidate)) {
    throw new UnsupportedMediaError(`Refusing executable or script upload (${candidate}). Uploads are data.`);
  }
  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(candidate)) {
    throw new UnsupportedMediaError(
      `Unsupported media type ${candidate}. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}.`,
    );
  }
  if (candidate === 'application/pdf' || candidate === DOCX) {
    throw new UnsupportedMediaError(`Bytes are not a valid ${candidate} payload.`);
  }
  return candidate;
}

export function looksLikeUtf8Text(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
