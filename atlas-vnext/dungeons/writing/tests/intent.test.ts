import { describe, expect, it } from 'vitest';
import {
  inferWritingOperation,
  looksLikeGoldRequest,
  looksLikeStoryBibleUpdate,
  looksLikeWritingFollowup,
  looksLikeWritingRequest,
} from '../src/intent.ts';

describe('writing conversation classifier', () => {
  it('routes explicit writing asks', () => {
    expect(looksLikeWritingRequest('Write a 500-word scene about a lighthouse keeper hearing a voice from the fog.')).toBe(true);
    expect(looksLikeWritingRequest('Draft chapter two of the harbour novel.')).toBe(true);
    expect(looksLikeWritingRequest('Refine this with Caspa Gold.')).toBe(true);
    expect(looksLikeGoldRequest('Give this chapter the full editorial pass.')).toBe(true);
    expect(looksLikeStoryBibleUpdate('Establish in the project that Mara has a scar over her left eye.')).toBe(true);
  });

  it('does not steal OSINT, research, memory, or artifact-open asks', () => {
    expect(looksLikeWritingRequest('Run OSINT on octocat')).toBe(false);
    expect(looksLikeWritingFollowup('Which of those findings is strongest?')).toBe(false);
    expect(looksLikeWritingRequest('Research the history of the World Wide Web using multiple independent sources.')).toBe(false);
    expect(looksLikeWritingRequest('What did I say my dog’s name was?')).toBe(false);
    expect(looksLikeWritingRequest('Open the manuscript')).toBe(false);
    expect(looksLikeWritingRequest('What is a lighthouse keeper?')).toBe(false);
    expect(looksLikeWritingRequest('Capability policy: Nexus decides WHERE\nCurrent document:\nWrite a scene')).toBe(false);
    expect(looksLikeWritingRequest('Build a website about a neighbourhood circus.')).toBe(false);
    expect(looksLikeWritingRequest('Write a website about cocoa tents.')).toBe(false);
  });

  it('treats restrained-paragraph edits as follow-ups, not new manuscripts', () => {
    expect(looksLikeWritingFollowup('Make the final paragraph more restrained.')).toBe(true);
    expect(looksLikeWritingFollowup('Make that dialogue less formal.')).toBe(true);
    expect(inferWritingOperation('Make the final paragraph more restrained.', true)).toBe('tone');
    expect(inferWritingOperation('Write a short scene about fog.', false)).toBe('create');
    expect(inferWritingOperation('Refine this with Caspa Gold.', true)).toBe('refine');
  });
});
