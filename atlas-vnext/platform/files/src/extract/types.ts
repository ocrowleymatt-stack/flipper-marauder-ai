export const EXTRACTOR_ID = 'atlas.extract';
export const EXTRACTOR_VERSION = 'v1';

export interface ExtractedBlock {
  text: string;
  locator: {
    path: string;
    startOffset: number;
    endOffset: number;
    page?: number;
    heading?: string;
    row?: number;
    jsonPath?: string;
  };
}

export interface ExtractionResult {
  text: string;
  blocks: ExtractedBlock[];
  pageCount: number | null;
  structure: Record<string, unknown>;
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
