import { describe, expect, it } from 'vitest';
import {
  isWebsiteRegenerateFollowup,
  isWebsiteRevisionFollowup,
  looksLikeWebsiteFollowup,
  looksLikeWebsiteRequest,
  titleFromBrief,
} from '../src/intent.ts';

describe('website conversation classifier', () => {
  it('routes explicit website asks', () => {
    expect(looksLikeWebsiteRequest('Build a website about a neighbourhood circus with tents, tickets, and cocoa.')).toBe(true);
    expect(looksLikeWebsiteRequest('Create a landing page for the harbour bakery.')).toBe(true);
    expect(looksLikeWebsiteRequest('Write a website about cocoa tents.')).toBe(true);
  });

  it('does not steal research, OSINT, writing, or memory asks', () => {
    expect(looksLikeWebsiteRequest('Research the history of the World Wide Web using multiple independent sources.')).toBe(false);
    expect(looksLikeWebsiteRequest('Research the website of CERN using multiple independent sources.')).toBe(false);
    expect(looksLikeWebsiteRequest('Run OSINT on octocat')).toBe(false);
    expect(looksLikeWebsiteRequest('Write a 500-word scene about a lighthouse keeper hearing a voice from the fog.')).toBe(false);
    expect(looksLikeWebsiteRequest('What did I say my dog’s name was?')).toBe(false);
    expect(looksLikeWebsiteFollowup('Which of those findings is strongest?')).toBe(false);
  });

  it('treats preview and revision phrases as follow-ups', () => {
    expect(looksLikeWebsiteFollowup('Show the preview')).toBe(true);
    expect(looksLikeWebsiteFollowup('Make the hero shorter.')).toBe(true);
    expect(looksLikeWebsiteFollowup('Add a contact section.')).toBe(true);
    expect(looksLikeWebsiteFollowup('Change the copy to a professional tone.')).toBe(true);
    expect(looksLikeWebsiteFollowup('Make this mobile layout cleaner.')).toBe(true);
    expect(isWebsiteRevisionFollowup('Make the hero shorter.')).toBe(true);
    expect(isWebsiteRevisionFollowup('Show the preview')).toBe(false);
    expect(isWebsiteRegenerateFollowup('Regenerate the site')).toBe(true);
    expect(looksLikeWebsiteFollowup('Try again')).toBe(false);
    expect(looksLikeWebsiteFollowup('Try again on the site')).toBe(true);
    expect(looksLikeWebsiteFollowup('Regenerate the site')).toBe(true);
  });

  it('titles from the about-clause', () => {
    expect(titleFromBrief('Build a website about a neighbourhood circus with tents')).toMatch(/neighbourhood circus/i);
  });
});
