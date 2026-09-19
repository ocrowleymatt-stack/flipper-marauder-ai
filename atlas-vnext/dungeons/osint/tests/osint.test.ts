import { afterEach, describe, expect, it } from 'vitest';
import { OsintService, composeOsintReport, looksLikeOsintFollowup, looksLikeOsintRequest } from '../src/index.ts';
import type { PublicLookupPort } from '../src/collector.ts';
import type { PublicLookupResult } from '@atlas-vnext/contracts';
import { closePersistence, openDungeonStack, storeTenantPolicy } from '../../../tests/helpers/dungeon-stack.ts';
import type { PlatformPersistence } from '@atlas-vnext/persistence';

const persistences: PlatformPersistence[] = [];

afterEach(async () => {
  while (persistences.length) {
    const item = persistences.pop();
    if (item) await closePersistence(item);
  }
});

function collector(hits: PublicLookupResult[]): PublicLookupPort {
  return {
    async lookup() {
      return hits;
    },
  };
}

const dnsHit: PublicLookupResult = {
  source: 'dns.a',
  summary: 'example.test resolves to 192.0.2.1',
  confidence: 'confirmed',
  status: 'confirmed',
  probe: 'dns.a',
  evidence: '{"domain":"example.test","addresses":["192.0.2.1"]}',
  epistemicKind: 'observation',
};

describe('OSINT dungeon', () => {
  it('scans through jobs, persists findings and provenance, and writes a deterministic dossier', async () => {
    const stack = await openDungeonStack('Dossier: example.test is a documentation domain.');
    persistences.push(stack.persistence);
    const osint = new OsintService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      runtime: stack.runtime,
      authority: stack.authority,
      policy: stack.policy,
      collector: collector([dnsHit]),
    });
    const result = await osint.scan(stack.actor, {
      projectId: stack.project.id,
      kind: 'domain',
      value: 'example.test',
      synthesize: true,
    });
    expect(result.target.dungeon).toBe('osint');
    expect(result.target.status).toBe('completed');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe('finding');
    expect(result.dossier?.kind).toBe('dossier');
    expect(result.dossier?.payload.deterministic).toBe(true);
    const listed = await osint.listFindings(stack.actor, result.target.id);
    expect(listed).toHaveLength(1);
    const job = await stack.persistence.forActor(stack.actor).jobs.get(stack.actor, result.target.jobId!);
    expect(job?.status).toBe('completed');
    const artefactId = result.findings[0]?.artefactId;
    expect(artefactId).toBeTruthy();
    const provenance = await stack.persistence.forActor(stack.actor).provenance.forArtefact(artefactId!);
    expect(Array.isArray(provenance) ? provenance.length : provenance ? 1 : 0).toBeGreaterThan(0);
  });

  it('does not leak a missing target as another tenant object', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const osint = new OsintService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      runtime: stack.runtime,
      authority: stack.authority,
      policy: stack.policy,
      collector: collector([dnsHit]),
    });
    await expect(osint.get(stack.actor, 'rec_missing')).rejects.toMatchObject({ httpStatus: 404, message: 'Permission denied.' });
  });

  it('refuses public scans when stored networkAccess is none', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    await storeTenantPolicy(stack, { networkAccess: 'none' });
    const osint = new OsintService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      runtime: stack.runtime,
      authority: stack.authority,
      policy: stack.policy,
      collector: collector([dnsHit]),
    });
    await expect(
      osint.scan(stack.actor, { projectId: stack.project.id, kind: 'domain', value: 'example.test', synthesize: false }),
    ).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('fail-closes private IP targets and does not persist them as intelligence', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const osint = new OsintService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      runtime: stack.runtime,
      authority: stack.authority,
      policy: stack.policy,
      collector: collector([
        {
          source: 'ssrf',
          probe: 'ip.validate',
          summary: 'Private, reserved, or local-network targets are not scanned.',
          confidence: 'possible',
          status: 'blocked',
          evidence: '{"value":"127.0.0.1"}',
          epistemicKind: 'observation',
        },
      ]),
    });
    await expect(
      osint.scan(stack.actor, { projectId: stack.project.id, kind: 'ip', value: '127.0.0.1', synthesize: false }),
    ).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('stores observations and correlations as distinct kinds and answers conversation follow-ups', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const osint = new OsintService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      runtime: stack.runtime,
      authority: stack.authority,
      policy: stack.policy,
      collector: collector([
        {
          source: 'GitHub',
          probe: 'username.github',
          url: 'https://github.com/octocat',
          summary: 'GitHub profile observed at https://github.com/octocat',
          confidence: 'confirmed',
          status: 'confirmed',
          evidence: '{"url":"https://github.com/octocat"}',
          contentHash: 'a'.repeat(64),
          epistemicKind: 'observation',
        },
        {
          source: 'GitLab',
          probe: 'username.gitlab',
          url: 'https://gitlab.com/octocat',
          summary: 'GitLab profile observed at https://gitlab.com/octocat',
          confidence: 'confirmed',
          status: 'confirmed',
          evidence: '{"url":"https://gitlab.com/octocat"}',
          contentHash: 'b'.repeat(64),
          epistemicKind: 'observation',
        },
        {
          source: 'Reddit',
          probe: 'username.reddit',
          url: 'https://www.reddit.com/user/octocat',
          summary: 'Reddit did not show a public profile',
          confidence: 'possible',
          status: 'negative',
          evidence: '{"soft404":true}',
          epistemicKind: 'observation',
        },
        {
          source: 'correlation.username',
          probe: 'correlation',
          summary: 'Same username observed on 2 platforms: GitHub, GitLab',
          confidence: 'likely',
          status: 'likely',
          evidence: '{"kind":"correlation"}',
          epistemicKind: 'correlation',
        },
      ]),
    });
    const conversation = await stack.runtime.createConversation({ projectId: stack.project.id });
    const handled = await osint.maybeRunFromConversation(stack.actor, {
      conversationId: conversation.id,
      projectId: stack.project.id,
      question: 'Run OSINT on octocat',
    });
    expect(handled.handled).toBe(true);
    expect(handled.text).toMatch(/Strongest finding:/);
    expect(handled.text).toMatch(/GitHub/);
    expect(handled.text).toMatch(/Negative presence checks: Reddit/);
    expect(handled.text).toMatch(/Correlations \(not facts\)/);

    const strongest = await osint.maybeRunFromConversation(stack.actor, {
      conversationId: conversation.id,
      projectId: stack.project.id,
      question: 'Which of those findings is strongest?',
    });
    expect(strongest.handled).toBe(true);
    expect(strongest.text).toMatch(/Strongest finding:/);
    expect(strongest.text).toMatch(/GitHub/);

    const sources = await osint.maybeRunFromConversation(stack.actor, {
      conversationId: conversation.id,
      projectId: stack.project.id,
      question: 'Which sources support it?',
    });
    expect(sources.handled).toBe(true);
    expect(sources.text).toMatch(/github\.com\/octocat/i);

    const second = await osint.maybeRunFromConversation(stack.actor, {
      conversationId: conversation.id,
      projectId: stack.project.id,
      question: 'Open the second one.',
    });
    expect(second.handled).toBe(true);
    expect(second.text).toMatch(/second observation/i);
    expect(second.text).toMatch(/id=/);

    const listed = await osint.listTargets(stack.actor, stack.project.id);
    const findings = await osint.listFindings(stack.actor, listed[0]!.id);
    expect(findings.some((row) => row.kind === 'finding' && row.payload.epistemicKind === 'observation')).toBe(true);
    expect(findings.some((row) => row.kind === 'correlation')).toBe(true);
  });

  it('does not treat hypothesis-only output as completed intelligence', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const osint = new OsintService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      runtime: stack.runtime,
      authority: stack.authority,
      policy: stack.policy,
      collector: collector([
        {
          source: 'spiderfoot',
          probe: 'spiderfoot',
          summary: 'Specialist engine is not configured.',
          confidence: 'possible',
          status: 'unknown',
          evidence: '{"configured":false}',
          epistemicKind: 'hypothesis',
        },
      ]),
    });
    await expect(
      osint.scan(stack.actor, { projectId: stack.project.id, kind: 'username', value: 'octocat', synthesize: false }),
    ).rejects.toMatchObject({ code: 'insufficient_evidence' });
  });

  it('classifies request text without specialist-engine brand names', () => {
    expect(looksLikeOsintRequest('Run OSINT on octocat')).toBe(true);
    expect(looksLikeOsintFollowup('Which of those findings is strongest?')).toBe(true);
    expect(looksLikeOsintRequest('Research the history of the web')).toBe(false);
    const report = composeOsintReport({
      kind: 'username',
      value: 'octocat',
      hits: [
        { source: 'GitHub', summary: 'present', confidence: 'confirmed', status: 'confirmed', evidence: 'e', epistemicKind: 'observation' },
        { source: 'npm', summary: 'missing', confidence: 'possible', status: 'negative', evidence: 'e', epistemicKind: 'observation' },
        { source: 'Keybase', summary: '429', confidence: 'possible', status: 'rate_limited', evidence: 'e', epistemicKind: 'observation' },
      ],
    });
    expect(report).toMatch(/Negative presence checks: npm/);
    expect(report).toMatch(/rate_limited/);
    expect(report).toMatch(/not treated as not-found/);
  });
});
