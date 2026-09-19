import { describe, expect, it } from 'vitest';
import { classifyAssistantResult, findingsFromRecords, mergeFindings, stripPrimaryHashes } from './results';

const osint = `OSINT username scan of \`octocat\`.
Observations: 1 confirmed/public, 6 negative, 1 blocked/error.
Strongest finding: GitHub profile confirmed (https://github.com/octocat)
Strongest public observations:
- GitHub: The Octocat GitHub profile repositories (https://github.com/octocat) hash=abcdef1234567890
Negative presence checks: GitLab, Reddit.
Blocked/error/rate-limited sources (not treated as not-found): Keybase:error.
This report is evidence-backed. Atlas did not treat provider success as completion.`;

const research = `Researching: early history of the World Wide Web

Engines: wikipedia, fixture. Waves: 2.

## Sources inspected
1. [World Wide Web](https://en.wikipedia.org/wiki/World_Wide_Web) — en.wikipedia.org via wikipedia, wave 1, confirmed

## Findings
- **World Wide Web** (confirmed)
  Invented by Tim Berners-Lee.
  Citation: https://en.wikipedia.org/wiki/World_Wide_Web

## Strongly established
- World Wide Web — https://en.wikipedia.org/wiki/World_Wide_Web

Strongest finding: World Wide Web (confirmed) https://en.wikipedia.org/wiki/World_Wide_Web

## Synthesis
The Web began at CERN.
`;

describe('Wave 3 conversation result presentation', () => {
  it('parses OSINT reports into findings without hashes as primary text', () => {
    const result = classifyAssistantResult(osint);
    expect(result?.kind).toBe('osint');
    expect(result?.findings[0]?.source).toBe('GitHub');
    expect(result?.findings[0]?.url).toBe('https://github.com/octocat');
    expect(result?.strongest).toMatch(/GitHub profile confirmed/);
    expect(stripPrimaryHashes(osint)).not.toMatch(/hash=/);
  });

  it('parses research reports into sources and findings', () => {
    const result = classifyAssistantResult(research);
    expect(result?.kind).toBe('research');
    expect(result?.sources[0]?.url).toContain('wikipedia.org');
    expect(result?.findings[0]?.title).toBe('World Wide Web');
    expect(result?.state).toMatch(/sources inspected/i);
  });

  it('does not treat ordinary chat as a result card', () => {
    expect(classifyAssistantResult('Hello. The kettle is copper.')).toBeNull();
  });

  it('merges durable OSINT records onto parsed findings', () => {
    const parsed = classifyAssistantResult(osint)!.findings;
    const durable = findingsFromRecords([
      {
        id: 'find_1',
        dungeon: 'osint',
        kind: 'finding',
        title: 'GitHub profile confirmed',
        status: 'completed',
        payload: {
          source: 'GitHub',
          url: 'https://github.com/octocat',
          status: 'confirmed',
          summary: 'GitHub profile confirmed',
          epistemicKind: 'observation',
          contentHash: 'abcdef1234567890',
        },
        artefactId: 'art_1',
        contentHash: 'abcdef1234567890',
        jobId: null,
        parentId: 'tgt_1',
        revision: 1,
        conversationId: 'con_1',
      },
    ]);
    const merged = mergeFindings(parsed, durable);
    expect(merged[0]?.id).toBe('find_1');
    expect(merged[0]?.url).toBe('https://github.com/octocat');
    expect(merged[0]?.evidenceHash).toBe('abcdef1234567890');
  });
});
