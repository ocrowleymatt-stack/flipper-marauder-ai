import type { DungeonId, DungeonRegistration } from '@atlas-vnext/contracts';
import type { ConversationRuntime } from '@atlas-vnext/conversation';
import type { FilesService } from '@atlas-vnext/files';
import type { DungeonRecordRow, PersistenceActor, PlatformPersistence } from '@atlas-vnext/persistence';
import { AuthorityEngine } from '@atlas-vnext/permissions';
import type { ProjectService } from '@atlas-vnext/projects';

export const dungeonId: DungeonId = 'music';

export const musicDungeon = {
  id: dungeonId,
  title: 'Music',
  description: 'Composition briefs and release notes. GPU runtimes stay in Execution.',
} as const;

export const MUSIC_DUNGEON: DungeonRegistration = {
  id: 'music',
  slug: 'music',
  title: 'Music',
  navLabel: 'Music',
  description: 'Compose structure and lyrics through Nexus. Does not lease GPUs or name cloud GPU vendors.',
  surface: 'music-studio',
  routes: {
    list: '/api/projects/:projectId/compositions',
    item: '/api/compositions/:id',
    compose: '/api/compositions/:id/compose',
  },
  capabilities: ['project.read', 'artifact.read', 'artifact.write'],
  permissions: { read: 'artifact.read', write: 'artifact.write' },
  featureAvailable: true,
};

export const GENERIC_DENY = 'Permission denied.';

export class MusicError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
    this.name = 'MusicError';
  }
}

export interface MusicActor extends PersistenceActor {
  principalId: string;
  tenantId: string;
}

export class MusicService {
  constructor(
    private readonly deps: {
      persistence: PlatformPersistence;
      projects: ProjectService;
      files: FilesService;
      runtime: ConversationRuntime;
      authority: AuthorityEngine;
    },
  ) {}

  async list(actor: MusicActor, projectId: string): Promise<DungeonRecordRow[]> {
    await this.requireProject(actor, projectId, 'artifact.read');
    return this.store(actor).list(actor, { workspaceId: projectId, dungeon: 'music', kind: 'composition' });
  }

  async create(actor: MusicActor, input: { projectId: string; title: string; brief: string }) {
    const project = await this.requireProject(actor, input.projectId, 'artifact.write');
    return this.store(actor).create(actor, {
      workspaceId: project.id,
      dungeon: 'music',
      kind: 'composition',
      title: input.title.trim() || 'Untitled composition',
      status: 'idle',
      payload: { brief: input.brief },
    });
  }

  async get(actor: MusicActor, id: string): Promise<DungeonRecordRow> {
    const row = await this.store(actor).get(actor, id);
    if (!row || row.dungeon !== 'music') throw new MusicError('not_found', GENERIC_DENY, 404);
    this.authorize(actor, 'artifact.read', row.workspaceId ?? row.id, row.tenantId);
    return row;
  }

  async compose(actor: MusicActor, id: string) {
    const record = await this.get(actor, id);
    this.authorize(actor, 'artifact.write', record.workspaceId ?? record.id, record.tenantId);
    const projectId = record.workspaceId;
    if (!projectId) throw new MusicError('malformed', 'Composition is missing a project.');
    const conversation = await this.deps.runtime.createConversation({ title: record.title, projectId });
    let text = '';
    let executionId: string | null = null;
    for await (const event of this.deps.runtime.sendMessage(conversation.id, {
      content: [
        'Produce a composition packet: tempo, structure, lyrics or motifs, and release notes.',
        'Do not mention GPU providers, RunPod, or infrastructure.',
        `Title: ${record.title}`,
        `Brief: ${String(record.payload.brief ?? '')}`,
      ].join('\n'),
      capability: 'nexus/reason',
    })) {
      if (event.type === 'execution') executionId = event.execution.id;
      if (event.type === 'assistant.delta' && event.text) text += event.text;
      if (event.type === 'assistant.completed' && event.text) text = event.text;
    }
    const artefact = await this.deps.files.createTextArtefact(actor, {
      projectId,
      text: text.trim() || 'Empty composition packet.',
      type: 'music.composition',
    });
    const updated = await this.store(actor).update(actor, record.id, {
      status: 'completed',
      artefactId: artefact.id,
      contentHash: artefact.contentHash,
      conversationId: conversation.id,
      payload: { ...record.payload, executionId },
      expectedRevision: record.revision,
    });
    await this.deps.persistence.forActor(actor).provenance.record({
      artefactId: artefact.id,
      projectId,
      sourceInputs: [record.id],
      inputManifestHash: null,
      provider: 'atlas.music',
      model: 'composition',
      toolCalls: [],
      jobId: executionId,
      timestamp: new Date().toISOString(),
      traceId: `music:${record.id}`,
      capability: 'music',
    });
    return updated;
  }

  private store(actor: MusicActor) {
    return this.deps.persistence.forActor(actor).dungeonRecords;
  }

  private async requireProject(actor: MusicActor, projectId: string, capability: 'artifact.read' | 'artifact.write') {
    if (!actor.tenantId || !actor.principalId) throw new MusicError('permission_denied', GENERIC_DENY, 401);
    const project = await this.deps.projects.get(actor, projectId);
    if (!project) throw new MusicError('not_found', GENERIC_DENY, 404);
    this.authorize(actor, capability, project.id, project.tenantId);
    return project;
  }

  private authorize(actor: MusicActor, capability: 'artifact.read' | 'artifact.write', workspaceId: string, tenantId: string) {
    const verdict = this.deps.authority.decide({
      principal: { principalId: actor.principalId, kind: 'user', tenantId: actor.tenantId, workspaceId },
      capability,
      resource: { type: 'artifact', id: workspaceId, tenantId, workspaceId },
    });
    if (verdict.decision !== 'ALLOW') throw new MusicError('permission_denied', GENERIC_DENY, 404);
  }
}
