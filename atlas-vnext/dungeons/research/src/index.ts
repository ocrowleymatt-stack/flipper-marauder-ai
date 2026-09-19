import type {
  DungeonId,
  DungeonRegistration,
  FederatedSearchPort,
  InspectedSource,
  ResearchFinding,
  SearchHit,
  SourceInspectPort,
} from '@atlas-vnext/contracts';
import type { ConversationRuntime } from '@atlas-vnext/conversation';
import type { ContextService } from '@atlas-vnext/context';
import type { FilesService } from '@atlas-vnext/files';
import type { DungeonRecordRow, PersistenceActor, PlatformPersistence } from '@atlas-vnext/persistence';
import { AuthorityEngine, EffectivePolicyEngine } from '@atlas-vnext/permissions';
import type { ProjectService } from '@atlas-vnext/projects';
import {
  coverageScore,
  detectContradictions,
  hostOf,
  looksLikeResearchRequest,
  planQueries,
  strongestFinding,
} from '@atlas-vnext/search';

export const dungeonId: DungeonId = 'research';

export const researchDungeon = {
  id: dungeonId,
  title: 'Research',
  description: 'Federated search and synthesis over Atlas context, files, Nexus, and provenance.',
} as const;

export const RESEARCH_DUNGEON: DungeonRegistration = {
  id: 'research',
  slug: 'research',
  title: 'Research',
  navLabel: 'Research',
  description: 'Query, retrieve, and synthesise with honest citations. Does not own a retrieval stack.',
  surface: 'research-desk',
  routes: {
    list: '/api/projects/:projectId/research',
    item: '/api/research/:id',
    run: '/api/research/:id/run',
  },
  capabilities: ['project.read', 'file.read', 'artifact.read', 'artifact.write'],
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

export interface ResearchRunResult {
  brief: DungeonRecordRow;
  synthesis: DungeonRecordRow;
  context: Awaited<ReturnType<ContextService['assemble']>>;
  reportText: string;
  findings: ResearchFinding[];
  engines: string[];
  waves: number;
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
      search?: FederatedSearchPort;
      inspect?: SourceInspectPort;
    },
  ) {}

  async list(actor: ResearchActor, projectId: string): Promise<DungeonRecordRow[]> {
    await this.requireProject(actor, projectId, 'artifact.read');
    return this.store(actor).list(actor, { workspaceId: projectId, dungeon: 'research', kind: 'brief' });
  }

  async create(
    actor: ResearchActor,
    input: { projectId: string; question: string; fileIds?: string[]; conversationId?: string | null },
  ) {
    const project = await this.requireProject(actor, input.projectId, 'artifact.write');
    return this.store(actor).create(actor, {
      workspaceId: project.id,
      dungeon: 'research',
      kind: 'brief',
      title: input.question.trim().slice(0, 120) || 'Research brief',
      status: 'idle',
      payload: { question: input.question, fileIds: input.fileIds ?? [] },
      conversationId: input.conversationId ?? null,
    });
  }

  async get(actor: ResearchActor, id: string): Promise<DungeonRecordRow> {
    const row = await this.store(actor).get(actor, id);
    if (!row || row.dungeon !== 'research') throw new ResearchError('not_found', GENERIC_DENY, 404);
    this.authorize(actor, 'artifact.read', row.workspaceId ?? row.id, row.tenantId);
    return row;
  }

  async maybeRunFromConversation(
    actor: ResearchActor,
    input: {
      conversationId: string;
      projectId: string | null;
      question: string;
      signal?: AbortSignal;
    },
  ): Promise<{ handled: boolean; text?: string; failed?: boolean }> {
    if (!this.deps.search || !this.deps.inspect) return { handled: false };
    if (!looksLikeResearchRequest(input.question)) return { handled: false };
    if (!input.projectId) return { handled: false };
    const brief = await this.create(actor, {
      projectId: input.projectId,
      question: input.question,
      conversationId: input.conversationId,
    });
    try {
      const result = await this.run(actor, brief.id, {
        conversationId: input.conversationId,
        signal: input.signal,
      });
      return { handled: true, text: result.reportText };
    } catch (err) {
      if (err instanceof ResearchError && (err.code === 'insufficient_evidence' || err.code === 'permission_denied')) {
        return { handled: true, failed: true, text: err.message };
      }
      throw err;
    }
  }

  async run(
    actor: ResearchActor,
    id: string,
    options: { conversationId?: string | null; signal?: AbortSignal } = {},
  ): Promise<ResearchRunResult> {
    const brief = await this.get(actor, id);
    this.authorize(actor, 'artifact.write', brief.workspaceId ?? brief.id, brief.tenantId);
    const projectId = brief.workspaceId;
    if (!projectId) throw new ResearchError('malformed', 'Brief is missing a project.');
    const policy = await this.boundPolicy(actor);
    this.assertPolicy(actor, 'artifact.write', policy, projectId, brief.tenantId);
    const question = String(brief.payload.question ?? '');
    const fileIds = Array.isArray(brief.payload.fileIds) ? (brief.payload.fileIds as string[]) : [];
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

    const requestingConversationId =
      options.conversationId ?? brief.conversationId ?? null;

    let web: WebResearch = emptyWeb();
    if (this.deps.search && this.deps.inspect) {
      const net = this.deps.policy.authorize({
        principal: { principalId: actor.principalId, kind: 'user', tenantId: actor.tenantId, workspaceId: projectId },
        capability: 'network.public',
        dungeonId: 'research',
        policy,
        resource: { type: 'artifact', id: projectId, tenantId: brief.tenantId, workspaceId: projectId },
      });
      if (net.allowed) {
        web = await this.conductWebResearch(question, options.signal);
      } else {
        web.errors.push({ engine: 'authority', message: 'Public network access denied.' });
      }
    }

    let text = '';
    let executionId: string | null = null;
    const canWeb = Boolean(this.deps.search && this.deps.inspect);
    if (!canWeb) {
      const conversation = await this.deps.runtime.createConversation({ title: brief.title, projectId });
      for await (const event of this.deps.runtime.sendMessage(conversation.id, {
        content: [
          this.deps.policy.scopedModelInstructions(policy),
          'Synthesise an answer using only the retrieved slices. Cite paths and hashes. If evidence is missing, say so.',
          `Question: ${question}`,
          ...assembled.slices.map((slice) => `File ${slice.path} (${slice.contentHash.slice(0, 12)}):\n${slice.text}`),
        ].join('\n\n'),
        capability: 'nexus/reason',
        privacy: this.deps.policy.runtimePrivacy(policy),
        principalId: actor.principalId,
        tenantId: actor.tenantId,
      })) {
        if (event.type === 'execution') executionId = event.execution.id;
        if (event.type === 'assistant.delta' && event.text) text += event.text;
        if (event.type === 'assistant.completed' && event.text) text = event.text;
      }
      text = text.trim() || 'No synthesis; retrieval slices remain the source of truth.';
    } else {
      text = composeReport({ question, assembled, web });
      if (web.findings.length === 0) {
        await this.store(actor).update(actor, brief.id, {
          status: 'failed',
          payload: { ...brief.payload, engines: web.engines, errors: web.errors },
          expectedRevision: brief.revision,
        });
        throw new ResearchError('insufficient_evidence', text, 422);
      }
    }

    const artefact = await this.deps.files.createTextArtefact(actor, {
      projectId,
      text,
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
        findings: web.findings,
        contradictions: web.contradictions,
        engines: web.engines,
        waves: web.waves,
        strongest: strongestFinding(web.findings),
      },
      artefactId: artefact.id,
      contentHash: artefact.contentHash,
      conversationId: requestingConversationId ?? undefined,
      parentId: brief.id,
    });
    await this.deps.persistence.forActor(actor).provenance.record({
      artefactId: artefact.id,
      projectId,
      sourceInputs: [
        ...assembled.slices.flatMap((slice) => [slice.fileId, slice.contentHash, slice.chunkId]),
        ...web.findings.map((item) => item.canonicalUrl),
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
      payload: { ...brief.payload, synthesisId: note.id, engines: web.engines, waves: web.waves },
      conversationId: requestingConversationId ?? undefined,
      expectedRevision: brief.revision,
    });
    return {
      brief: await this.get(actor, brief.id),
      synthesis: note,
      context: assembled,
      reportText: text,
      findings: web.findings,
      engines: web.engines,
      waves: web.waves,
    };
  }

  private async conductWebResearch(objective: string, signal?: AbortSignal): Promise<WebResearch> {
    const search = this.deps.search!;
    const inspect = this.deps.inspect!;
    const findings: ResearchFinding[] = [];
    const errors: Array<{ engine: string; message: string }> = [];
    const engines = new Set<string>();
    const seen = new Set<string>();
    let waves = 1;

    const consume = async (query: string, wave: number) => {
      const report = await search.search({ query, count: 8, signal });
      for (const id of report.engines) engines.add(id);
      errors.push(...report.errors);
      for (const hit of report.hits.slice(0, 6)) {
        if (seen.has(hit.canonicalUrl)) continue;
        seen.add(hit.canonicalUrl);
        try {
          const page = await inspect.inspect({ url: hit.url, signal });
          const text = stripHtml(page.text);
          if (!page.ok || !text) {
            errors.push({
              engine: hit.engine,
              message: `inspect ${hit.url}: ${page.ok ? 'empty body' : `HTTP ${page.status}`}`,
            });
            continue;
          }
          findings.push(toFinding(hit, page, wave, text));
        } catch (err) {
          errors.push({
            engine: hit.engine,
            message: `inspect ${hit.url}: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    };

    const queries = planQueries(objective);
    const primary = queries[0];
    if (primary) await consume(primary, 1);
    const firstCoverage = coverageScore(
      objective,
      findings.map((item) => item.host),
      findings.map((item) => `${item.title} ${item.summary}`),
    );
    if (!firstCoverage.adequate) {
      waves = 2;
      const missing = firstCoverage.terms.filter(
        (term) => !findings.some((item) => item.summary.toLowerCase().includes(term) || item.title.toLowerCase().includes(term)),
      );
      const extras = [
        ...queries.slice(1, 3),
        missing.length ? `${objective} ${missing.slice(0, 4).join(' ')} primary sources` : `${objective} additional independent sources`,
      ];
      for (const extra of extras.slice(0, 2)) {
        await consume(extra, 2);
      }
    }

    return {
      findings,
      contradictions: detectContradictions(findings),
      engines: [...engines],
      errors,
      waves,
      coverage: coverageScore(
        objective,
        findings.map((item) => item.host),
        findings.map((item) => `${item.title} ${item.summary}`),
      ),
    };
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

interface WebResearch {
  findings: ResearchFinding[];
  contradictions: Array<{ topic: string; left: string; right: string }>;
  engines: string[];
  errors: Array<{ engine: string; message: string }>;
  waves: number;
  coverage: ReturnType<typeof coverageScore>;
}

function emptyWeb(): WebResearch {
  return {
    findings: [],
    contradictions: [],
    engines: [],
    errors: [],
    waves: 0,
    coverage: { independentHosts: 0, termHits: 0, terms: [], adequate: false },
  };
}

const TRUSTED_RESEARCH_HOSTS = ['wikipedia.org', 'w3.org', 'cern.ch'] as const;

function isTrustedResearchHost(host: string): boolean {
  return TRUSTED_RESEARCH_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function toFinding(hit: SearchHit, page: InspectedSource, wave: number, text: string): ResearchFinding {
  const title = page.text.match(/<title[^>]*>([^<]+)/i)?.[1]?.trim() || hit.title;
  const quote = firstSentence(text);
  const summary = (quote || text).slice(0, 600);
  const host = hostOf(page.finalUrl || hit.url);
  const confidence = isTrustedResearchHost(host) ? 'confirmed' : 'likely';
  return {
    id: `finding_${wave}_${hit.rank}_${host.replace(/[^a-z0-9]+/g, '_')}`.slice(0, 80),
    title,
    url: hit.url,
    canonicalUrl: hit.canonicalUrl,
    summary,
    quote: quote.slice(0, 400),
    engine: hit.engine,
    host,
    confidence,
    wave,
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8_000);
}

function firstSentence(text: string): string {
  const match = text.match(/[A-Z][^.!?]{12,220}[.!?]/);
  return match?.[0]?.trim() ?? text.slice(0, 220).trim();
}

function composeReport(input: {
  question: string;
  assembled: { slices: Array<{ path: string; text: string; contentHash: string }>; citations: unknown };
  web: WebResearch;
}): string {
  const strongest = strongestFinding(input.web.findings);
  const sources = input.web.findings
    .map(
      (item, index) =>
        `${index + 1}. [${item.title}](${item.url}) — ${item.host} via ${item.engine}, wave ${item.wave}, ${item.confidence}`,
    )
    .join('\n');
  const findings = input.web.findings
    .map((item) => `- **${item.title}** (${item.confidence})\n  ${item.summary}\n  Citation: ${item.url}`)
    .join('\n');
  const conflicts = input.web.contradictions.length
    ? input.web.contradictions.map((row) => `- ${row.topic}: ${row.left} vs ${row.right}`).join('\n')
    : '- No explicit contradictions were detected in the inspected sources.';
  const files = input.assembled.slices.length
    ? input.assembled.slices.map((slice) => `- ${slice.path} (${slice.contentHash.slice(0, 12)})`).join('\n')
    : '- No project files were included.';
  const established = input.web.findings.filter((item) => item.confidence === 'confirmed');
  const uncertain = input.web.coverage.adequate
    ? 'Remaining uncertainty is limited to interpretation at the edges of the record.'
    : `Coverage is incomplete (${input.web.coverage.independentHosts} independent hosts). Additional independent sources would strengthen this brief.`;
  return [
    `Researching: ${input.question}`,
    '',
    `Engines: ${input.web.engines.join(', ') || 'none'}. Waves: ${input.web.waves}.`,
    '',
    '## Sources inspected',
    sources || '- None.',
    '',
    '## Project files',
    files,
    '',
    '## Findings',
    findings || '- No durable web findings.',
    '',
    '## Strongly established',
    established.length
      ? established.map((item) => `- ${item.title} — ${item.url}`).join('\n')
      : '- Nothing met the confirmed threshold; see likely findings above.',
    '',
    '## Where sources disagree',
    conflicts,
    '',
    '## Uncertainty',
    uncertain,
    '',
    `Strongest finding: ${strongest ? `${strongest.title} (${strongest.confidence}) ${strongest.url}` : 'none'}`,
    '',
    '## Synthesis',
    input.web.findings.length
      ? `The brief used ${input.web.findings.length} inspected sources across ${new Set(input.web.findings.map((item) => item.host)).size} hosts. Citations above are the evidence; Atlas did not treat provider success as completion.`
      : 'Web acquisition did not yield inspectable sources.',
    input.web.errors.length ? `\nSearch notes: ${input.web.errors.map((row) => `${row.engine}: ${row.message}`).join('; ')}` : '',
  ].join('\n');
}
