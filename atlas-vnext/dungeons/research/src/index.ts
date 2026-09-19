import type { DungeonId, DungeonRegistration, InspectedSource, SearchHit, SearchReport } from '@atlas-vnext/contracts';
import type { ConversationRuntime } from '@atlas-vnext/conversation';
import type { ContextService } from '@atlas-vnext/context';
import type { FilesService } from '@atlas-vnext/files';
import type { DungeonRecordRow, PersistenceActor, PlatformPersistence } from '@atlas-vnext/persistence';
import { AuthorityEngine, EffectivePolicyEngine } from '@atlas-vnext/permissions';
import type { ProjectService } from '@atlas-vnext/projects';
import { coverageOf, detectContradictions, planQueries, strongestHit } from '@atlas-vnext/search';
import type { FederatedSearchPort } from './search.ts';

export const dungeonId: DungeonId = 'research';

export const researchDungeon = {
  id: dungeonId,
  title: 'Research',
  description: 'Iterative federated research over web sources, project files, Nexus, and provenance.',
} as const;

export const RESEARCH_DUNGEON: DungeonRegistration = {
  id: 'research',
  slug: 'research',
  title: 'Research',
  navLabel: 'Research',
  description: 'Plan, search, inspect, challenge, and synthesise with citations. Does not own HTTP sockets.',
  surface: 'research-desk',
  routes: {
    list: '/api/projects/:projectId/research',
    item: '/api/research/:id',
    run: '/api/research/:id/run',
  },
  capabilities: ['project.read', 'file.read', 'artifact.read', 'artifact.write', 'network.public'],
  permissions: { read: 'artifact.read', write: 'artifact.write' },
  featureAvailable: true,
};

export const GENERIC_DENY = 'Permission denied.';

export class ResearchError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
    this.name = 'ResearchError';
  }
}

export interface ResearchActor extends PersistenceActor {
  principalId: string;
  tenantId: string;
}

export { type FederatedSearchPort } from './search.ts';

interface ResearchWave {
  queries: string[];
  hitCount: number;
  coverage: number;
  engines: string[];
  gaps: string[];
}

export class ResearchService {
  constructor(
    private readonly deps: {
      persistence: PlatformPersistence;
      projects: ProjectService;
      files: FilesService;
      context: ContextService;
      runtime: ConversationRuntime;
      authority: AuthorityEngine;
      policy: EffectivePolicyEngine;
      search?: FederatedSearchPort | null;
    },
  ) {}

  async list(actor: ResearchActor, projectId: string): Promise<DungeonRecordRow[]> {
    await this.requireProject(actor, projectId, 'artifact.read');
    return this.store(actor).list(actor, { workspaceId: projectId, dungeon: 'research', kind: 'brief' });
  }

  async create(
    actor: ResearchActor,
    input: { projectId: string; question: string; fileIds?: string[]; conversationId?: string },
  ) {
    const project = await this.requireProject(actor, input.projectId, 'artifact.write');
    return this.store(actor).create(actor, {
      workspaceId: project.id,
      dungeon: 'research',
      kind: 'brief',
      title: input.question.trim().slice(0, 120) || 'Research brief',
      status: 'idle',
      payload: {
        question: input.question,
        fileIds: input.fileIds ?? [],
        conversationId: input.conversationId ?? null,
      },
      conversationId: input.conversationId ?? null,
    });
  }

  async get(actor: ResearchActor, id: string): Promise<DungeonRecordRow> {
    const row = await this.store(actor).get(actor, id);
    if (!row || row.dungeon !== 'research') throw new ResearchError('not_found', GENERIC_DENY, 404);
    this.authorize(actor, 'artifact.read', row.workspaceId ?? row.id, row.tenantId);
    return row;
  }

  async run(actor: ResearchActor, id: string, input: { conversationId?: string } = {}) {
    const brief = await this.get(actor, id);
    this.authorize(actor, 'artifact.write', brief.workspaceId ?? brief.id, brief.tenantId);
    const projectId = brief.workspaceId;
    if (!projectId) throw new ResearchError('malformed', 'Brief is missing a project.');
    const policy = await this.boundPolicy(actor);
    this.assertPolicy(actor, 'artifact.write', policy, projectId, brief.tenantId);
    const question = String(brief.payload.question ?? '');
    const fileIds = Array.isArray(brief.payload.fileIds) ? (brief.payload.fileIds as string[]) : [];
    const requestingConversationId =
      input.conversationId ??
      (typeof brief.payload.conversationId === 'string' ? brief.payload.conversationId : null) ??
      brief.conversationId;
    const assembled =
      policy.retrievalScope === 'none'
        ? { slices: [], citations: [], truncated: false, tokenCount: 0, tokenBudget: 4000 }
        : await this.deps.context.assemble(actor, {
            projectId,
            query: question,
            tokenBudget: 4000,
            ...(policy.retrievalScope === 'project' && fileIds.length === 0
              ? {}
              : { restrictFileIds: fileIds, attachmentFileIds: fileIds }),
          });

    const webAllowed = this.webAllowed(actor, policy, projectId);
    const loop = await this.iterateWeb(question, webAllowed);

    const findings: DungeonRecordRow[] = [];
    for (const hit of loop.hits.slice(0, 12)) {
      findings.push(await this.persistFinding(actor, projectId, brief.id, hit, loop.inspected.has(hit.canonicalUrl)));
    }

    const statements = [
      ...loop.hits.map((hit, index) => ({ id: `web:${index}`, text: `${hit.title}. ${hit.snippet}` })),
      ...assembled.slices.map((slice, index) => ({ id: `file:${index}`, text: slice.text.slice(0, 400) })),
    ];
    const contradictions = detectContradictions(statements);
    const strongest = strongestHit(loop.hits);

    const conversation = await this.deps.runtime.createConversation({ title: brief.title, projectId });
    let text = '';
    let executionId: string | null = null;
    const inspectedNotes = [...loop.inspected.entries()].map(
      ([url, source]) => `Inspected ${url} (${source.title}): ${source.excerpt.slice(0, 400)}`,
    );
    for await (const event of this.deps.runtime.sendMessage(conversation.id, {
      content: [
        this.deps.policy.scopedModelInstructions(policy),
        'Synthesise an answer. Cite every web URL and file path you use. If evidence is missing, say so.',
        'Do not invent sources. Identify the strongest finding, conflicting evidence, and remaining uncertainty.',
        `Question: ${question}`,
        `Search waves: ${JSON.stringify(loop.waves)}`,
        `Web hits:\n${loop.hits
          .slice(0, 12)
          .map((hit) => `- ${hit.title} (${hit.canonicalUrl}) [${hit.engine}/${hit.sourceType}]: ${hit.snippet}`)
          .join('\n') || '(none)'}`,
        inspectedNotes.join('\n'),
        contradictions.length
          ? `Contradictions:\n${contradictions.map((item) => `- ${item.a} vs ${item.b}: ${item.reason}`).join('\n')}`
          : 'No deterministic contradictions detected.',
        ...assembled.slices.map((slice) => `File ${slice.path} (${slice.contentHash.slice(0, 12)}):\n${slice.text}`),
      ].join('\n\n'),
      capability: 'nexus/reason',
      privacy: this.deps.policy.runtimePrivacy(policy),
    })) {
      if (event.type === 'execution') executionId = event.execution.id;
      if (event.type === 'assistant.delta' && event.text) text += event.text;
      if (event.type === 'assistant.completed' && event.text) text = event.text;
    }
    const artefact = await this.deps.files.createTextArtefact(actor, {
      projectId,
      text: text.trim() || 'No synthesis; retrieved slices and web hits remain the source of truth.',
      type: 'research.synthesis',
    });
    const note = await this.store(actor).create(actor, {
      workspaceId: projectId,
      dungeon: 'research',
      kind: 'synthesis',
      title: `Synthesis ${brief.title}`,
      status: 'completed',
      payload: {
        briefId: brief.id,
        executionId,
        citations: assembled.citations,
        queries: loop.queries,
        engines: loop.engines,
        waves: loop.waves,
        webHitCount: loop.hits.length,
        inspectedCount: loop.inspected.size,
        contradictions,
        strongest: strongest
          ? { title: strongest.title, url: strongest.canonicalUrl, sourceType: strongest.sourceType }
          : null,
        webSearch: this.deps.search ? (webAllowed ? 'used' : 'policy_blocked') : 'unavailable',
      },
      artefactId: artefact.id,
      contentHash: artefact.contentHash,
      conversationId: conversation.id,
      parentId: brief.id,
    });
    await this.deps.persistence.forActor(actor).provenance.record({
      artefactId: artefact.id,
      projectId,
      sourceInputs: [
        ...assembled.slices.flatMap((slice) => [slice.fileId, slice.contentHash, slice.chunkId]),
        ...loop.hits.map((hit) => hit.canonicalUrl),
      ],
      inputManifestHash: null,
      provider: 'atlas.research',
      model: 'synthesis',
      toolCalls: [],
      jobId: executionId,
      timestamp: new Date().toISOString(),
      traceId: `research:${brief.id}:${note.id}`,
      capability: 'research',
    });
    await this.store(actor).update(actor, brief.id, {
      status: 'completed',
      payload: { ...brief.payload, synthesisId: note.id, conversationId: conversation.id },
      conversationId: conversation.id,
      expectedRevision: brief.revision,
    });
    if (requestingConversationId) {
      await this.deps.runtime.postNotice(requestingConversationId, formatResearchNotice(question, loop, strongest, text), {
        tenantId: actor.tenantId,
        workspaceId: projectId,
      });
    }
    return {
      brief: await this.get(actor, brief.id),
      synthesis: note,
      context: assembled,
      findings,
      waves: loop.waves,
    };
  }

  private async iterateWeb(
    question: string,
    allowed: boolean,
  ): Promise<{
    queries: string[];
    engines: string[];
    hits: SearchHit[];
    inspected: Map<string, InspectedSource>;
    waves: ResearchWave[];
  }> {
    const waves: ResearchWave[] = [];
    const inspected = new Map<string, InspectedSource>();
    if (!allowed || !this.deps.search) {
      waves.push({
        queries: planQueries(question),
        hitCount: 0,
        coverage: 0,
        engines: [],
        gaps: [this.deps.search ? 'policy_blocked' : 'search_port_unavailable'],
      });
      return { queries: planQueries(question), engines: [], hits: [], inspected, waves };
    }
    const firstQueries = planQueries(question);
    const first = await this.deps.search.search({ queries: firstQueries, mode: 'research' });
    waves.push(waveFrom(first));
    let hits = first.hits;
    let engines = [...first.engines];
    const queries = [...first.queries];
    if (first.coverage.gaps.includes('coverage_below_stop') || first.coverage.gaps.includes('no_hits')) {
      const extra = planQueries(question, first.coverage.gaps.map((gap) => `${question} ${gap.replace(/_/g, ' ')}`));
      const second = await this.deps.search.search({ queries: extra.slice(0, 3), mode: 'research' });
      waves.push(waveFrom(second));
      hits = dedupeHits([...hits, ...second.hits]);
      engines = [...new Set([...engines, ...second.engines])];
      queries.push(...second.queries);
    }
    for (const hit of hits.slice(0, 5)) {
      const page = await this.deps.search.inspect({ url: hit.canonicalUrl });
      if (page) inspected.set(hit.canonicalUrl, page);
    }
    return { queries: [...new Set(queries)], engines, hits, inspected, waves };
  }

  private async persistFinding(
    actor: ResearchActor,
    projectId: string,
    briefId: string,
    hit: SearchHit,
    inspected: boolean,
  ): Promise<DungeonRecordRow> {
    const artefact = await this.deps.files.createTextArtefact(actor, {
      projectId,
      text: JSON.stringify({ ...hit, inspected }, null, 2),
      type: 'research.finding',
    });
    return this.store(actor).create(actor, {
      workspaceId: projectId,
      dungeon: 'research',
      kind: 'finding',
      title: hit.title.slice(0, 120),
      status: 'completed',
      payload: {
        url: hit.canonicalUrl,
        source: hit.engine,
        sourceType: hit.sourceType,
        snippet: hit.snippet,
        confidence: inspected ? 'likely' : 'possible',
        inspected,
      },
      artefactId: artefact.id,
      contentHash: artefact.contentHash,
      parentId: briefId,
    });
  }

  private webAllowed(
    actor: ResearchActor,
    policy: Awaited<ReturnType<ResearchService['boundPolicy']>>,
    workspaceId: string,
  ): boolean {
    const decision = this.deps.policy.authorize({
      principal: { principalId: actor.principalId, kind: 'user', tenantId: actor.tenantId, workspaceId },
      capability: 'network.public',
      dungeonId: 'research',
      policy,
      resource: { type: 'project', id: workspaceId, tenantId: actor.tenantId, workspaceId },
    });
    return decision.allowed;
  }

  private store(actor: ResearchActor) {
    return this.deps.persistence.forActor(actor).dungeonRecords;
  }

  private async requireProject(actor: ResearchActor, projectId: string, capability: 'artifact.read' | 'artifact.write') {
    if (!actor.tenantId || !actor.principalId) throw new ResearchError('permission_denied', GENERIC_DENY, 401);
    const project = await this.deps.projects.get(actor, projectId);
    if (!project) throw new ResearchError('not_found', GENERIC_DENY, 404);
    this.authorize(actor, capability, project.id, project.tenantId);
    return project;
  }

  private authorize(actor: ResearchActor, capability: 'artifact.read' | 'artifact.write', workspaceId: string, tenantId: string) {
    const verdict = this.deps.authority.decide({
      principal: { principalId: actor.principalId, kind: 'user', tenantId: actor.tenantId, workspaceId },
      capability,
      resource: { type: 'artifact', id: workspaceId, tenantId, workspaceId },
    });
    if (verdict.decision !== 'ALLOW') throw new ResearchError('permission_denied', GENERIC_DENY, 404);
  }

  private async boundPolicy(actor: ResearchActor) {
    return this.deps.policy.loadForDungeon(actor.tenantId, 'research', (dungeonId) =>
      this.deps.persistence.forActor(actor).privacy.getPolicy(actor, dungeonId),
    );
  }

  private assertPolicy(
    actor: ResearchActor,
    capability: string,
    policy: Awaited<ReturnType<ResearchService['boundPolicy']>>,
    workspaceId: string,
    tenantId: string,
  ) {
    const decision = this.deps.policy.authorize({
      principal: { principalId: actor.principalId, kind: 'user', tenantId: actor.tenantId, workspaceId },
      capability,
      dungeonId: 'research',
      policy,
      resource: { type: 'artifact', id: workspaceId, tenantId, workspaceId },
    });
    if (!decision.allowed) throw new ResearchError('permission_denied', GENERIC_DENY, 404);
  }
}

function waveFrom(report: SearchReport): ResearchWave {
  const coverage = coverageOf(report.hits, report.mode);
  return {
    queries: report.queries,
    hitCount: report.hits.length,
    coverage: coverage.score,
    engines: report.engines,
    gaps: coverage.gaps,
  };
}

function dedupeHits(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.canonicalUrl)) continue;
    seen.add(hit.canonicalUrl);
    out.push({ ...hit, rank: out.length + 1 });
  }
  return out;
}

function formatResearchNotice(
  question: string,
  loop: { queries: string[]; engines: string[]; hits: SearchHit[]; waves: ResearchWave[] },
  strongest: SearchHit | null,
  synthesis: string,
): string {
  const lines = [
    `## Research results`,
    `Question: ${question}`,
    `Searched (${loop.waves.length} wave${loop.waves.length === 1 ? '' : 's'}): ${loop.queries.join('; ')}`,
    `Engines: ${loop.engines.join(', ') || 'none'}`,
    strongest
      ? `Strongest finding: ${strongest.title} — ${strongest.canonicalUrl} (${strongest.sourceType}, ${strongest.engine})`
      : 'Strongest finding: none yet. Web acquisition did not return durable hits.',
    '',
    synthesis.trim() || 'Synthesis was empty; findings remain the source of truth.',
  ];
  if (loop.hits.length) {
    lines.splice(
      5,
      0,
      'Sources:',
      ...loop.hits.slice(0, 8).map((hit) => `- [${hit.title}](${hit.canonicalUrl}) — ${hit.snippet.slice(0, 180)}`),
    );
  }
  return lines.join('\n');
}
