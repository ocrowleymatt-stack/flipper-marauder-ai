import { decodeUtf8 } from './text.ts';
import type { ExtractedBlock, ExtractionResult } from './types.ts';

function splitRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells.map((cell) => (cell.startsWith('=') ? `'${cell}` : cell));
}

export function extractCsv(bytes: Uint8Array, path: string): ExtractionResult {
  const raw = decodeUtf8(bytes).replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
  const header = lines[0] ? splitRow(lines[0]) : [];
  const blocks: ExtractedBlock[] = [];
  if (header.length) {
    blocks.push({
      text: `columns: ${header.join(', ')}`,
      locator: { path, startOffset: 0, endOffset: lines[0]?.length ?? 0, heading: 'header', row: 0 },
    });
  }
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitRow(lines[i]!);
    const pairs = header.map((name, index) => `${name}=${cells[index] ?? ''}`);
    blocks.push({
      text: `row ${i}: ${pairs.join('; ')}`,
      locator: { path, startOffset: i, endOffset: i + 1, row: i },
    });
  }
  return {
    text: blocks.map((block) => block.text).join('\n'),
    blocks,
    pageCount: null,
    structure: { kind: 'csv', columns: header, rows: Math.max(0, lines.length - 1) },
  };
}
