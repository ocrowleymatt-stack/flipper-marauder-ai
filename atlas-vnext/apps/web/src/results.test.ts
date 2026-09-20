import { describe, expect, it } from 'vitest';
import { classifyAssistantResult, bindOsintResult, stripPrimaryHashes } from './results';

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

  it('binds durable findings to the matching OSINT scan, not the whole conversation', () => {
    const octocat = classifyAssistantResult(osint)!;
    const hubotReport = osint.replaceAll('octocat', 'hubot').replace('The Octocat GitHub profile repositories', 'Hubot automation GitHub profile');
    const claimed = new Set<string>();
    const targets = [
      {
        id: 'tgt_octocat',
        dungeon: 'osint',
        kind: 'target',
        title: 'octocat',
        status: 'completed',
        payload: { value: 'octocat', reportText: osint },
        artefactId: null,
        contentHash: null,
        jobId: null,
        parentId: null,
        revision: 1,
        conversationId: 'con_1',
        createdAt: '2026-09-19T23:00:00.000Z',
      },
      {
        id: 'tgt_hubot',
        dungeon: 'osint',
        kind: 'target',
        title: 'hubot',
        status: 'completed',
        payload: { value: 'hubot', reportText: hubotReport },
        artefactId: null,
        contentHash: null,
        jobId: null,
        parentId: null,
        revision: 1,
        conversationId: 'con_1',
        createdAt: '2026-09-19T23:01:00.000Z',
      },
    ];
    const findings = [
      {
        id: 'find_octocat',
        dungeon: 'osint',
        kind: 'finding',
        title: 'GitHub profile confirmed',
        status: 'completed',
        payload: { source: 'GitHub', summary: 'The Octocat GitHub profile repositories', url: 'https://github.com/octocat' },
        artefactId: null,
        contentHash: null,
        jobId: null,
        parentId: 'tgt_octocat',
        revision: 1,
        conversationId: 'con_1',
      },
      {
        id: 'find_hubot',
        dungeon: 'osint',
        kind: 'finding',
        title: 'Hubot profile confirmed',
        status: 'completed',
        payload: { source: 'GitHub', summary: 'Hubot automation GitHub profile', url: 'https://github.com/hubot' },
        artefactId: null,
        contentHash: null,
        jobId: null,
        parentId: 'tgt_hubot',
        revision: 1,
        conversationId: 'con_1',
      },
    ];
    const first = bindOsintResult(octocat, osint, targets, findings, claimed);
    const second = bindOsintResult(classifyAssistantResult(hubotReport)!, hubotReport, targets, findings, claimed);
    expect(first.scanId).toBe('tgt_octocat');
    expect(first.findings.map((item) => item.id)).toEqual(['find_octocat']);
    expect(second.scanId).toBe('tgt_hubot');
    expect(second.findings.map((item) => item.id)).toEqual(['find_hubot']);
    expect(first.findings[0]?.summary).not.toMatch(/Hubot/);
    expect(second.findings[0]?.summary).not.toMatch(/Octocat/);
  });
});
