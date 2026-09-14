import { describe, expect, it } from 'vitest';
import {
  buildSimpleDocx,
  buildSimplePdf,
  chunkBlocks,
  extractBytes,
  CHUNKER_VERSION,
} from '@atlas-vnext/files';

describe('extraction and deterministic chunking', () => {
  it('extracts markdown, json, csv, pdf pages, and docx structure', () => {
    const md = extractBytes(new TextEncoder().encode('# Title\n\nHello Atlas source.\n'), 'text/markdown', 'brief.md');
    expect(md.structure.headings).toEqual(['Title']);
    expect(md.blocks[0]?.locator.heading).toBe('Title');

    const json = extractBytes(
      new TextEncoder().encode(JSON.stringify({ vessel: 'Marauder', tags: ['osint'] })),
      'application/json',
      'meta.json',
    );
    expect(json.text).toContain('$.vessel: Marauder');

    const csv = extractBytes(new TextEncoder().encode('name,role\nAda,analyst\n'), 'text/csv', 'people.csv');
    expect(csv.text).toContain('row 1: name=Ada');
    expect(csv.blocks[1]?.locator.row).toBe(1);

    const pdf = extractBytes(buildSimplePdf(['Page one source', 'Page two source']), 'application/pdf', 'memo.pdf');
    expect(pdf.pageCount).toBe(2);
    expect(pdf.blocks[0]?.locator.page).toBe(1);
    expect(pdf.text).toContain('Page one source');

    const docx = extractBytes(buildSimpleDocx(['Opening paragraph', 'Second paragraph']), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'note.docx');
    expect(docx.structure.paragraphs).toBe(2);
    expect(docx.text).toContain('Opening paragraph');
  });

  it('chunks deterministically for the same input', () => {
    const extracted = extractBytes(
      new TextEncoder().encode('Alpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.'),
      'text/plain',
      'a.txt',
    );
    const a = chunkBlocks(extracted.blocks, 'a.txt');
    const b = chunkBlocks(extracted.blocks, 'a.txt');
    expect(a).toEqual(b);
    expect(a[0]?.locator.path).toBe('a.txt');
    expect(CHUNKER_VERSION).toBe('v1');
  });
});
