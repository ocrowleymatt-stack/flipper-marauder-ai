import type { DungeonId, DungeonRegistration } from '@atlas-vnext/contracts';
import type { ConversationRuntime } from '@atlas-vnext/conversation';
import type { FilesService } from '@atlas-vnext/files';
import type { DungeonRecordRow, PersistenceActor, PlatformPersistence } from '@atlas-vnext/persistence';
import { AuthorityEngine, EffectivePolicyEngine } from '@atlas-vnext/permissions';
import type { ProjectService } from '@atlas-vnext/projects';

export const dungeonId: DungeonId = 'investigation';

export const investigationDungeon = {
  id: dungeonId,
  title: 'Investigation',
  description: 'Caseboards and evidential challenge loops over Atlas jobs, files, and provenance.',
} as const;

export const INVESTIGATION_DUNGEON: DungeonRegistration = {
  id: 'investigation',
  slug: 'investigation',
  title: 'Investigation',
  navLabel: 'Investigation',
  description: 'Caseboards, evidence, and multi-role challenge loops. Consumes OSINT findings by id.',
  surface: 'investigation-caseboard',
  routes: {
    list: '/api/projects/:projectId/cases',
    item: '/api/cases/:id',
    challenge: '/api/cases/:id/challenge',
  },
  capabilities: ['project.read', 'artifact.read', 'artifact.write', 'file.read'],
  permissions: { read: 'artifact.read', write: 'artifact.write' },
  featureAvailable: true,
};

export const GENERIC_DENY = 'Permission denied.';

export class InvestigationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
    this.name = 'InvestigationError';
  }
}

export interface InvestigationActor extends PersistenceActor {
  principalId: string;
  tenantId: string;
}

export class InvestigationService {
  constructor(
    private readonly deps: {
      persistence: PlatformPersistence;
      projects: ProjectService;
      files: FilesService;
      runtime: ConversationRuntime;
      authority: AuthorityEngine;
      policy: EffectivePolicyEngine;
    },
  ) {}

  async listCases(actor: InvestigationActor, projectId: string): Promise<DungeonRecordRow[]> {
    await this.requireProject(actor, projectId, 'artifact.read');
    return this.store(actor).list(actor, { workspaceId: projectId, dungeon: 'investigation', kind: 'case' });
  }

  async createCase(
    actor: InvestigationActor,
    input: { projectId: string; title: string; question: string; findingIds?: string[]; fileIds?: string[] },
  ): Promise<DungeonRecordRow> {
    const project = await this.requireProject(actor, input.projectId, 'artifact.write');
    const findings = await this.loadForeignFindings(actor, project.id, input.findingIds ?? []);
    return this.store(actor).create(actor, {
      workspaceId: project.id,
      dungeon: 'investigation',
      kind: 'case',
      title: input.title.trim() || 'Untitled case',
      status: 'idle',
      payload: {
        question: input.question,
        findingIds: findings.map((item) => item.id),
        fileIds: input.fileIds ?? [],
      },
    });
  }

  async get(actor: InvestigationActor, id: string): Promise<DungeonRecordRow> {
    const row = await this.store(actor).get(actor, id);
    if (!row || row.dungeon !== 'investigation') throw new InvestigationError('not_found', GENERIC_DENY, 404);
    this.authorize(actor, 'artifact.read', row.workspaceId ?? row.id, row.tenantId);
    return row;
  }

  async challenge(actor: InvestigationActor, id: string, stance: 'advocate' | 'challenger' | 'arbiter' = 'challenger') {
    const record = await this.get(actor, id);
    this.authorize(actor, 'artifact.write', record.workspaceId ?? record.id, record.tenantId);
    const projectId = record.workspaceId;
    if (!projectId) throw new InvestigationError('malformed', 'Case is missing a project.');
    const policy = await this.boundPolicy(actor);
    this.assertPolicy(actor, 'artifact.write', policy, projectId, record.tenantId);
    const findingIds = Array.isArray(record.payload.findingIds) ? (record.payload.findingIds as string[]) : [];
    const findings = await this.loadForeignFindings(actor, projectId, findingIds);
    const conversation = await this.deps.runtime.createConversation({ title: record.title, projectId });
    let text = '';
    let executionId: string | null = null;
    for await (const event of this.deps.runtime.sendMessage(conversation.id, {
      content: [
        this.deps.policy.scopedModelInstructions(policy),
        `You are the ${stance} in an evidential challenge loop. Do not invent evidence.`,
        `Case question: ${String(record.payload.question ?? '')}`,
        'Findings:',
        ...findings.map((item) => `- ${item.id}: ${JSON.stringify(item.payload)}`),
      ].join('\n'),
      capability: 'nexus/reason',
      privacy: this.deps.policy.runtimePrivacy(policy),
    })) {
      if (event.type === 'execution') executionId = event.execution.id;
      if (event.type === 'assistant.delta' && event.text) text += event.text;
      if (event.type === 'assistant.completed' && event.text) text = event.text;
    }
    const artefact = await this.deps.files.createTextArtefact(actor, {
      projectId,
      text: text.trim() || 'No challenge text produced.',
      type: 'investigation.challenge',
    });
    const challenge = await this.store(actor).create(actor, {
      workspaceId: projectId,
      dungeon: 'investigation',
      kind: 'challenge',
      title: `${stance} ${record.title}`,
      status: 'completed',
      payload: { stance, executionId },
      artefactId: artefact.id,
      contentHash: artefact.contentHash,
      conversationId: conversation.id,
      parentId: record.id,
    });
    await this.deps.persistence.forActor(actor).provenance.record({
      artefactId: artefact.id,
      projectId,
      sourceInputs: [record.id, ...findingIds],
      inputManifestHash: null,
      provider: 'atlas.investigation',
      model: `challenge.${stance}`,
      toolCalls: [],
      jobId: executionId,
      timestamp: new Date().toISOString(),
      traceId: `investigation:${record.id}:${challenge.id}`,
      capability: 'investigation',
    });
    return challenge;
  }

  private async loadForeignFindings(actor: InvestigationActor, projectId: string, ids: string[]): Promise<DungeonRecordRow[]> {
    const out: DungeonRecordRow[] = [];
    for (const id of ids) {
      const row = await this.store(actor).get(actor, id);
      if (!row || row.workspaceId !== projectId) throw new InvestigationError('not_found', GENERIC_DENY, 404);
      if (row.dungeon !== 'osint' || row.kind !== 'finding') throw new InvestigationError('malformed', 'Investigation consumes OSINT findings by id only.');
      out.push(row);
    }
    return out;
  }

  private store(actor: InvestigationActor) {
    return this.deps.persistence.forActor(actor).dungeonRecords;
  }

  private async requireProject(actor: InvestigationActor, projectId: string, capability: 'artifact.read' | 'artifact.write') {
    if (!actor.tenantId || !actor.principalId) throw new InvestigationError('permission_denied', GENERIC_DENY, 401);
    const project = await this.deps.projects.get(actor, projectId);
    if (!project) throw new InvestigationError('not_found', GENERIC_DENY, 404);
    this.authorize(actor, capability, project.id, project.tenantId);
    return project;
  }

  private authorize(actor: InvestigationActor, capability: 'artifact.read' | 'artifact.write', workspaceId: string, tenantId: string) {
    const verdict = this.deps.authority.decide({
      principal: { principalId: actor.principalId, kind: 'user', tenantId: actor.tenantId, workspaceId },
      capability,
      resource: { type: 'artifact', id: workspaceId, tenantId, workspaceId },
    });
    if (verdict.decision !== 'ALLOW') throw new InvestigationError('permission_denied', GENERIC_DENY, 404);
  }

  private async boundPolicy(actor: InvestigationActor) {
    return this.deps.policy.loadForDungeon(actor.tenantId, 'investigation', (dungeonId) =>
      this.deps.persistence.forActor(actor).privacy.getPolicy(actor, dungeonId),
    );
  }

  private assertPolicy(
    actor: InvestigationActor,
    capability: string,
    policy: Awaited<ReturnType<InvestigationService['boundPolicy']>>,
    workspaceId: string,
    tenantId: string,
  ) {
    const decision = this.deps.policy.authorize({
      principal: { principalId: actor.principalId, kind: 'user', tenantId: actor.tenantId, workspaceId },
      capability,
      dungeonId: 'investigation',
      policy,
      resource: { type: 'artifact', id: workspaceId, tenantId, workspaceId },
    });
    if (!decision.allowed) throw new InvestigationError('permission_denied', GENERIC_DENY, 404);
  }
}
