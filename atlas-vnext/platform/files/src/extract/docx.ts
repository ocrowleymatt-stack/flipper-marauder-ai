import { ExtractionError } from '../errors.ts';
import { readZip, writeZip, zipEntry } from '../zip.ts';
import type { ExtractedBlock, ExtractionResult } from './types.ts';

function xmlText(xml: string): string {
  return xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<w:p[^>]*>/g, '\n')
    .replace(/<w:tr[^>]*>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractDocx(bytes: Uint8Array, path: string): ExtractionResult {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new ExtractionError('Bytes are not a DOCX (ZIP) archive.');
  }
  const entries = readZip(bytes);
  if (entries.some((entry) => /vbaProject\.bin$/i.test(entry.name) || /macro/i.test(entry.name))) {
    throw new ExtractionError('Macro-enabled Word documents are rejected. Uploads are data.');
  }
  const document = zipEntry(entries, 'word/document.xml');
  if (!document) throw new ExtractionError('DOCX is missing word/document.xml.');
  const xml = new TextDecoder('utf-8').decode(document);
  const paragraphs = [...xml.matchAll(/<w:p[\s\S]*?<\/w:p>/g)].map((match) => xmlText(match[0]));
  const tables = [...xml.matchAll(/<w:tbl[\s\S]*?<\/w:tbl>/g)].map((match) => xmlText(match[0]));
  const blocks: ExtractedBlock[] = [];
  let offset = 0;
  paragraphs.forEach((text) => {
    if (!text) return;
    blocks.push({
      text,
      locator: { path, startOffset: offset, endOffset: offset + text.length, heading: text.length < 80 ? text : undefined },
    });
    offset += text.length + 1;
  });
  tables.forEach((text, index) => {
    if (!text) return;
    blocks.push({
      text: `table ${index + 1}: ${text}`,
      locator: { path, startOffset: offset, endOffset: offset + text.length, jsonPath: `table[${index}]` },
    });
    offset += text.length + 1;
  });
  if (blocks.length === 0) throw new ExtractionError('DOCX contained no extractable paragraphs or tables.');
  return {
    text: blocks.map((block) => block.text).join('\n'),
    blocks,
    pageCount: null,
    structure: {
      kind: 'docx',
      paragraphs: paragraphs.filter(Boolean).length,
      tables: tables.length,
      macrosIgnored: true,
    },
  };
}

export function buildSimpleDocx(paragraphs: string[]): Uint8Array {
  const body = paragraphs
    .map((text) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`)
    .join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  return writeZip([
    { name: '[Content_Types].xml', data: new TextEncoder().encode(contentTypes) },
    { name: '_rels/.rels', data: new TextEncoder().encode(rels) },
    { name: 'word/document.xml', data: new TextEncoder().encode(document) },
  ]);
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
