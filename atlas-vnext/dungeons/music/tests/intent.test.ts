import { describe, expect, it } from 'vitest';
import {
  isMusicRegenerateFollowup,
  isMusicRevisionFollowup,
  looksLikeMusicFollowup,
  looksLikeMusicRequest,
  titleFromBrief,
} from '../src/intent.ts';

describe('music conversation classifier', () => {
  it('routes explicit music asks', () => {
    expect(looksLikeMusicRequest('Compose a 30-second piano piece in A minor, 90 BPM.')).toBe(true);
    expect(looksLikeMusicRequest('Write a song about rain')).toBe(true);
    expect(looksLikeMusicRequest('Create an instrumental soundtrack for the harbour.')).toBe(true);
  });

  it('does not steal writing, website, research, or OSINT', () => {
    expect(looksLikeMusicRequest('Write a 500-word scene about a lighthouse keeper hearing a voice from the fog.')).toBe(false);
    expect(looksLikeMusicRequest('Write a musical scene about the harbour choir.')).toBe(false);
    expect(looksLikeMusicRequest('Build a website about jazz')).toBe(false);
    expect(looksLikeMusicRequest('Research the history of jazz using multiple independent sources.')).toBe(false);
    expect(looksLikeMusicRequest('OSINT on octocat')).toBe(false);
    expect(looksLikeMusicFollowup('Which of those findings is strongest?')).toBe(false);
  });

  it('treats tempo and arrangement phrases as follow-ups', () => {
    expect(looksLikeMusicFollowup('Make it slower.')).toBe(true);
    expect(looksLikeMusicFollowup('Change it to 120 BPM.')).toBe(true);
    expect(looksLikeMusicFollowup('Add strings.')).toBe(true);
    expect(looksLikeMusicFollowup('Remove the vocals.')).toBe(true);
    expect(looksLikeMusicFollowup('Make the chorus bigger.')).toBe(true);
    expect(isMusicRevisionFollowup('Make it slower.')).toBe(true);
    expect(isMusicRegenerateFollowup('Regenerate this version.')).toBe(true);
    expect(looksLikeMusicFollowup('Play the song')).toBe(true);
    expect(isMusicRevisionFollowup('Play the song')).toBe(false);
  });

  it('titles from the about-clause', () => {
    expect(titleFromBrief('Write a song about rain on copper roofs')).toMatch(/rain/i);
  });
});
