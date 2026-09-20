import { describe, expect, it } from 'vitest';
import { bindStructureByTitle, detectChapters } from '../src/chapters.ts';

const TWO_CHAPTERS = `# Chapter 1: Harbour

The keeper lit the lamp before dusk and waited on the gallery.

# Chapter 2: Fog

A voice came in from the water and would not leave the stair.
`;

describe('detectChapters', () => {
  it('splits realistic chapter headings and is fixture-stable', () => {
    const first = detectChapters(TWO_CHAPTERS);
    const second = detectChapters(TWO_CHAPTERS);
    expect(first.map((item) => item.title)).toEqual(['Chapter 1: Harbour', 'Chapter 2: Fog']);
    expect(second.map((item) => item.title)).toEqual(first.map((item) => item.title));
    expect(first[0]?.content).toMatch(/keeper lit the lamp/);
  });

  it('does not split dialogue containing the word chapter', () => {
    const prose = `She shut the ledger.
"Chapter closed," she said.
The lamp kept burning through the fog.`;
    const chapters = detectChapters(prose);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.content).toContain('"Chapter closed," she said.');
  });

  it('accepts labelled and special headings', () => {
    const text = `Chapter One: Harbour

The boats knocked against the quay until dusk.

CHAPTER 2 — Departure

The sails filled and the harbour fell behind them.

Prologue

Before the lamp was lit the stone was already wet with spray.`;
    const titles = detectChapters(text).map((item) => item.title);
    expect(titles.some((title) => /harbour/i.test(title))).toBe(true);
    expect(titles.some((title) => /departure|chapter 2/i.test(title))).toBe(true);
  });

  it('binds later detections by title rather than array index', () => {
    const detected = detectChapters(TWO_CHAPTERS);
    const bound = bindStructureByTitle(detected, [
      { title: 'Chapter 2: Fog', order: 0, wordCount: 3, documentId: 'doc_fog' },
      { title: 'Chapter 1: Harbour', order: 1, wordCount: 9, documentId: 'doc_harbour' },
    ]);
    expect(bound.find((item) => item.title.includes('Harbour'))?.documentId).toBe('doc_harbour');
    expect(bound.find((item) => item.title.includes('Fog'))?.documentId).toBe('doc_fog');
  });
});
