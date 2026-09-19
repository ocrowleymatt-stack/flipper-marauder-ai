import { afterEach, describe, expect, it } from 'vitest';
import type { FederatedSearchPort, ResearchFinding, SearchReport, SourceInspectPort } from '@atlas-vnext/contracts';
import { ResearchService } from '../src/index.ts';
import { closePersistence, openDungeonStack, storeTenantPolicy } from '../../../tests/helpers/dungeon-stack.ts';
import type { PlatformPersistence } from '@atlas-vnext/persistence';

const persistences: PlatformPersistence[] = [];

function fixtureInspect(): SourceInspectPort {
  return {
    async inspect(input) {
      const text = `Independent source at ${input.url}. Established public facts are cited; remaining uncertainty is noted. The World Wide Web was invented at CERN. Some popular claims remain disputed.`;
      return {
        requestedUrl: input.url,
        finalUrl: input.url,
        status: 200,
        ok: true,
        contentType: 'text/html',
        text: `<title>Source</title>${text}`,
        contentHash: 'a'.repeat(64),
        fetchedAt: new Date().toISOString(),
        truncated: false,
      };
    },
  };
}

afterEach(async () => {
  while (persistences.length) {
    const item = persistences.pop();
    if (item) await closePersistence(item);
  }
});

function researchOf(stack: Awaited<ReturnType<typeof openDungeonStack>>, extra?: { search?: FederatedSearchPort; inspect?: SourceInspectPort }) {
  return new ResearchService({
    persistence: stack.persistence,
    projects: stack.projects,
    files: stack.files,
    context: stack.context,
    runtime: stack.runtime,
    authority: stack.authority,
    policy: stack.policy,
    search: extra?.search,
    inspect: extra?.inspect,
  });
}

describe('Research dungeon', () => {
  it('retrieves selected files and synthesises with backend citations', async () => {
    const stack = await openDungeonStack('The notes describe a copper kettle. Source: notes.md.');
    persistences.push(stack.persistence);
    const file = await stack.files.ingest(stack.actor, {
      projectId: stack.project.id,
      path: 'notes.md',
      bytes: new TextEncoder().encode('A copper kettle sings on the stove.'),
    });
    for (let i = 0; i < 16; i += 1) {
      if (!(await stack.files.processNextJob(stack.actor, 'research-test'))) break;
    }
    const research = researchOf(stack);
    const brief = await research.create(stack.actor, {
      projectId: stack.project.id,
      question: 'What object is on the stove?',
      fileIds: [file.id],
    });
    const result = await research.run(stack.actor, brief.id);
    expect(result.synthesis.kind).toBe('synthesis');
    expect(result.context.slices.length).toBeGreaterThan(0);
    expect(result.synthesis.payload.citations).toBeDefined();
  });

  it('does not retrieve files when stored retrievalScope is none', async () => {
    const stack = await openDungeonStack('Should not appear in synthesis context.');
    persistences.push(stack.persistence);
    const file = await stack.files.ingest(stack.actor, {
      projectId: stack.project.id,
      path: 'secret.md',
      bytes: new TextEncoder().encode('classified kettle notes'),
    });
    for (let i = 0; i < 16; i += 1) {
      if (!(await stack.files.processNextJob(stack.actor, 'research-none'))) break;
    }
    await storeTenantPolicy(stack, { retrievalScope: 'none' });
    const research = researchOf(stack);
    const brief = await research.create(stack.actor, {
      projectId: stack.project.id,
      question: 'What is classified?',
      fileIds: [file.id],
    });
    const result = await research.run(stack.actor, brief.id);
    expect(result.context.slices).toEqual([]);
  });

  it('refuses run when stored autonomyCeiling is suggest', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    await storeTenantPolicy(stack, { autonomyCeiling: 'suggest' });
    const research = researchOf(stack);
    const brief = await research.create(stack.actor, {
      projectId: stack.project.id,
      question: 'Should not run',
    });
    await expect(research.run(stack.actor, brief.id)).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('runs a second search wave when the first host set is inadequate and returns to the requesting conversation', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    let calls = 0;
    const search: FederatedSearchPort = {
      async search(input): Promise<SearchReport> {
        calls += 1;
        const now = new Date().toISOString();
        const wiki = {
          engine: 'brave',
          title: 'World Wide Web',
          url: 'https://en.wikipedia.org/wiki/World_Wide_Web',
          canonicalUrl: 'https://en.wikipedia.org/wiki/World_Wide_Web',
          snippet: 'The World Wide Web is an established information system.',
          rank: 1,
          retrievedAt: now,
          source: 'en.wikipedia.org',
        };
        const w3 = {
          engine: 'searxng',
          title: 'W3C History',
          url: 'https://www.w3.org/History/1989/proposal.html',
          canonicalUrl: 'https://w3.org/History/1989/proposal.html',
          snippet: 'The origin of the web remains disputed in popular retellings.',
          rank: 1,
          retrievedAt: now,
          source: 'w3.org',
        };
        const hits = calls === 1 ? [wiki] : [wiki, w3];
        return { query: input.query, hits, engines: calls === 1 ? ['brave'] : ['brave', 'searxng'], errors: [], retrievedAt: now };
      },
    };
    const research = researchOf(stack, { search, inspect: fixtureInspect() });
    const conversation = await stack.runtime.createConversation({ title: 'Atlas', projectId: stack.project.id });
    const handled = await research.maybeRunFromConversation(stack.actor, {
      conversationId: conversation.id,
      projectId: stack.project.id,
      question:
        'Research the history of the World Wide Web using multiple independent sources. Tell me what is strongly established.',
    });
    expect(handled.handled).toBe(true);
    expect(calls).toBeGreaterThan(1);
    expect(handled.text).toMatch(/Researching:/);
    expect(handled.text).toMatch(/Strongest finding:/);
    const listed = await research.list(stack.actor, stack.project.id);
    expect(listed[0]?.conversationId).toBe(conversation.id);
  });

  it('does not treat memory probes as research', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const search: FederatedSearchPort = {
      async search(): Promise<SearchReport> {
        throw new Error('search must not run for memory probes');
      },
    };
    const research = researchOf(stack, { search, inspect: fixtureInspect() });
    const handled = await research.maybeRunFromConversation(stack.actor, {
      conversationId: 'con_x',
      projectId: stack.project.id,
      question: "What did I say my dog's name was?",
    });
    expect(handled.handled).toBe(false);
  });

  it('records findings as structured evidence', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const now = new Date().toISOString();
    const search: FederatedSearchPort = {
      async search(input): Promise<SearchReport> {
        return {
          query: input.query,
          engines: ['brave', 'searxng'],
          errors: [],
          retrievedAt: now,
          hits: [
            {
              engine: 'brave',
              title: 'WWW',
              url: 'https://en.wikipedia.org/wiki/World_Wide_Web',
              canonicalUrl: 'https://en.wikipedia.org/wiki/World_Wide_Web',
              snippet: 'The World Wide Web was invented at CERN and is established.',
              rank: 1,
              retrievedAt: now,
              source: 'en.wikipedia.org',
            },
            {
              engine: 'searxng',
              title: 'Proposal',
              url: 'https://www.w3.org/History/1989/proposal.html',
              canonicalUrl: 'https://w3.org/History/1989/proposal.html',
              snippet: 'Independent primary source for the web.',
              rank: 1,
              retrievedAt: now,
              source: 'w3.org',
            },
          ],
        };
      },
    };
    const research = researchOf(stack, { search, inspect: fixtureInspect() });
    const brief = await research.create(stack.actor, {
      projectId: stack.project.id,
      question: 'Research the history of the World Wide Web using multiple independent sources.',
      conversationId: 'con_atlas',
    });
    const result = await research.run(stack.actor, brief.id, { conversationId: 'con_atlas' });
    expect(result.findings.length).toBeGreaterThan(1);
    expect(new Set(result.findings.map((item: ResearchFinding) => item.host)).size).toBeGreaterThan(1);
    expect(result.synthesis.conversationId).toBe('con_atlas');
    expect(result.reportText).toMatch(/Sources inspected/);
  });

  it('does not complete web research when inspect fails for every hit even if files exist', async () => {
    const stack = await openDungeonStack('A copper kettle sings on the stove.');
    persistences.push(stack.persistence);
    const file = await stack.files.ingest(stack.actor, {
      projectId: stack.project.id,
      path: 'notes.md',
      bytes: new TextEncoder().encode('A copper kettle sings on the stove.'),
    });
    for (let i = 0; i < 16; i += 1) {
      if (!(await stack.files.processNextJob(stack.actor, 'research-inspect-fail'))) break;
    }
    const now = new Date().toISOString();
    const search: FederatedSearchPort = {
      async search(input): Promise<SearchReport> {
        return {
          query: input.query,
          engines: ['brave'],
          errors: [],
          retrievedAt: now,
          hits: [
            {
              engine: 'brave',
              title: 'WWW',
              url: 'https://en.wikipedia.org/wiki/World_Wide_Web',
              canonicalUrl: 'https://en.wikipedia.org/wiki/World_Wide_Web',
              snippet: 'The World Wide Web was invented at CERN.',
              rank: 1,
              retrievedAt: now,
              source: 'en.wikipedia.org',
            },
          ],
        };
      },
    };
    const inspect: SourceInspectPort = {
      async inspect() {
        throw new Error('inspect failed');
      },
    };
    const research = researchOf(stack, { search, inspect });
    const brief = await research.create(stack.actor, {
      projectId: stack.project.id,
      question: 'Research the history of the World Wide Web using multiple independent sources.',
      fileIds: [file.id],
    });
    await expect(research.run(stack.actor, brief.id)).rejects.toMatchObject({ code: 'insufficient_evidence' });
    const listed = await research.list(stack.actor, stack.project.id);
    expect(listed[0]?.status).toBe('failed');
  });

  it('denies web search for a same-tenant principal without network.public', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const member = { tenantId: stack.actor.tenantId, principalId: 'principal_member' };
    await stack.persistence.ensurePrincipal({ id: member.principalId, displayName: 'member' });
    stack.authority.grantMembership(member.principalId, member.tenantId);
    for (const cap of ['artifact.read', 'artifact.write', 'project.read', 'file.read'] as const) {
      stack.authority.grantTo({ principalId: member.principalId, tenantId: member.tenantId, capability: cap });
    }
    let searched = false;
    const research = researchOf(stack, {
      search: {
        async search() {
          searched = true;
          throw new Error('search must not run');
        },
      },
      inspect: fixtureInspect(),
    });
    const brief = await research.create(member, {
      projectId: stack.project.id,
      question: 'Research the history of the World Wide Web using multiple independent sources.',
    });
    await expect(research.run(member, brief.id)).rejects.toMatchObject({ code: 'insufficient_evidence' });
    expect(searched).toBe(false);
  });
});
