import type { ChunkLocator } from '@atlas-vnext/persistence';
import { estimateTokens, type ExtractedBlock } from './extract/index.ts';

export const CHUNKER_ID = 'atlas.chunk';
export const CHUNKER_VERSION = 'v1';
export const CHUNK_MAX_CHARS = 1200;
export const CHUNK_OVERLAP = 120;

export interface PreparedChunk {
  ordinal: number;
  startOffset: number;
  endOffset: number;
  locator: ChunkLocator;
  text: string;
  tokenCount: number;
}

function splitOversized(text: string): string[] {
  if (text.length <= CHUNK_MAX_CHARS) return [text];
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const end = Math.min(text.length, cursor + CHUNK_MAX_CHARS);
    parts.push(text.slice(cursor, end));
    if (end >= text.length) break;
    cursor = Math.max(cursor + 1, end - CHUNK_OVERLAP);
  }
  return parts;
}

/**
 * Deterministic chunker. Same blocks + version always produce the same ordinals and offsets.
 */
export function chunkBlocks(blocks: ExtractedBlock[], path: string): PreparedChunk[] {
  const packed: ExtractedBlock[] = [];
  let current = '';
  let start = blocks[0]?.locator.startOffset ?? 0;
  let locator = blocks[0]?.locator;
  const flush = () => {
    if (!current.trim() || !locator) return;
    packed.push({
      text: current.trim(),
      locator: { ...locator, path, startOffset: start, endOffset: start + current.trim().length },
    });
    current = '';
  };
  for (const block of blocks) {
    const piece = block.text.trim();
    if (!piece) continue;
    if (!current) {
      start = block.locator.startOffset;
      locator = block.locator;
      current = piece;
      continue;
    }
    if (current.length + 2 + piece.length <= CHUNK_MAX_CHARS) {
      current = `${current}\n\n${piece}`;
      continue;
    }
    flush();
    start = block.locator.startOffset;
    locator = block.locator;
    current = piece;
  }
  flush();

  const chunks: PreparedChunk[] = [];
  let ordinal = 0;
  for (const block of packed) {
    for (const part of splitOversized(block.text)) {
      chunks.push({
        ordinal,
        startOffset: block.locator.startOffset,
        endOffset: block.locator.startOffset + part.length,
        locator: { ...block.locator, path, startOffset: block.locator.startOffset, endOffset: block.locator.startOffset + part.length },
        text: part,
        tokenCount: estimateTokens(part),
      });
      ordinal += 1;
    }
  }
  return chunks;
}
