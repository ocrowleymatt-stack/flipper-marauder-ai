import type { DungeonId, DungeonRegistration } from '@atlas-vnext/contracts';
import type { ConversationRuntime } from '@atlas-vnext/conversation';
import type { ContextService } from '@atlas-vnext/context';
import type { FilesService } from '@atlas-vnext/files';
import type { DungeonRecordRow, PersistenceActor, PlatformPersistence } from '@atlas-vnext/persistence';
import { AuthorityEngine, EffectivePolicyEngine } from '@atlas-vnext/permissions';
import type { ProjectService } from '@atlas-vnext/projects';

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
    },
  ) {}

  async list(actor: ResearchActor, projectId: string): Promise<DungeonRecordRow[]> {
    await this.requireProject(actor, projectId, 'artifact.read');
    return this.store(actor).list(actor, { workspaceId: projectId, dungeon: 'research', kind: 'brief' });
  }

  async create(actor: ResearchActor, input: { projectId: string; question: string; fileIds?: string[] }) {
    const project = await this.requireProject(actor, input.projectId, 'artifact.write');
    return this.store(actor).create(actor, {
      workspaceId: project.id,
      dungeon: 'research',
      kind: 'brief',
      title: input.question.trim().slice(0, 120) || 'Research brief',
      status: 'idle',
      payload: { question: input.question, fileIds: input.fileIds ?? [] },
    });
  }

  async get(actor: ResearchActor, id: string): Promise<DungeonRecordRow> {
    const row = await this.store(actor).get(actor, id);
    if (!row || row.dungeon !== 'research') throw new ResearchError('not_found', GENERIC_DENY, 404);
    this.authorize(actor, 'artifact.read', row.workspaceId ?? row.id, row.tenantId);
    return row;
  }

  async run(actor: ResearchActor, id: string) {
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
    const conversation = await this.deps.runtime.createConversation({ title: brief.title, projectId });
    let text = '';
    let executionId: string | null = null;
    for await (const event of this.deps.runtime.sendMessage(conversation.id, {
      content: [
        this.deps.policy.scopedModelInstructions(policy),
        'Synthesise an answer using only the retrieved slices. Cite paths and hashes. If evidence is missing, say so.',
        `Question: ${question}`,
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
      text: text.trim() || 'No synthesis; retrieval slices remain the source of truth.',
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
      },
      artefactId: artefact.id,
      contentHash: artefact.contentHash,
      conversationId: conversation.id,
      parentId: brief.id,
    });
    await this.deps.persistence.forActor(actor).provenance.record({
      artefactId: artefact.id,
      projectId,
      sourceInputs: assembled.slices.flatMap((slice) => [slice.fileId, slice.contentHash, slice.chunkId]),
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
      payload: { ...brief.payload, synthesisId: note.id },
      expectedRevision: brief.revision,
    });
    return { brief: await this.get(actor, brief.id), synthesis: note, context: assembled };
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
