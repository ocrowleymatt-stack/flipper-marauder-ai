import type { ConversationRuntime } from '@atlas-vnext/conversation';
import type { FilesService } from '@atlas-vnext/files';
import type { PersistenceActor, PlatformPersistence } from '@atlas-vnext/persistence';
import { AuthorityEngine, EffectivePolicyEngine } from '@atlas-vnext/permissions';
import type { ProjectService } from '@atlas-vnext/projects';
import type { DungeonRecordRow } from '@atlas-vnext/persistence';
import type { OsintTargetKind, PublicLookupResult, StructuredFailure } from '@atlas-vnext/contracts';
import type { PublicLookupPort } from './collector.ts';
import { DungeonError, GENERIC_DENY } from './errors.ts';

export interface OsintActor extends PersistenceActor {
  principalId: string;
  tenantId: string;
}

export class OsintService {
  constructor(
    private readonly deps: {
      persistence: PlatformPersistence;
      projects: ProjectService;
      files: FilesService;
      runtime: ConversationRuntime;
      authority: AuthorityEngine;
      policy: EffectivePolicyEngine;
      collector: PublicLookupPort;
    },
  ) {}

  async listTargets(actor: OsintActor, projectId: string): Promise<DungeonRecordRow[]> {
    await this.requireProject(actor, projectId, 'artifact.read');
    return this.records(actor).list(actor, { workspaceId: projectId, dungeon: 'osint', kind: 'target' });
  }

  async get(actor: OsintActor, id: string): Promise<DungeonRecordRow> {
    const row = await this.records(actor).get(actor, id);
    if (!row || row.dungeon !== 'osint') throw new DungeonError('not_found', GENERIC_DENY, 404);
    this.authorize(actor, 'artifact.read', row.workspaceId ?? row.id, row.tenantId);
    return row;
  }

  async listFindings(actor: OsintActor, targetId: string): Promise<DungeonRecordRow[]> {
    const target = await this.get(actor, targetId);
    return this.records(actor).list(actor, {
      workspaceId: target.workspaceId,
      dungeon: 'osint',
      kind: 'finding',
      parentId: target.id,
    });
  }

  async scan(
    actor: OsintActor,
    input: { projectId: string; kind: OsintTargetKind; value: string; synthesize?: boolean },
  ): Promise<{ target: DungeonRecordRow; findings: DungeonRecordRow[]; dossier?: DungeonRecordRow }> {
    const project = await this.requireProject(actor, input.projectId, 'artifact.write');
    const policy = await this.effectivePolicy(actor);
    const network = this.deps.policy.authorize({
      principal: { principalId: actor.principalId, kind: 'user', tenantId: actor.tenantId, workspaceId: project.id },
      capability: 'network.public',
      dungeonId: 'osint',
      policy,
      resource: { type: 'project', id: project.id, tenantId: actor.tenantId, workspaceId: project.id },
    });
    if (!network.allowed) throw new DungeonError('permission_denied', GENERIC_DENY, 404);

    const jobs = this.deps.persistence.forActor(actor).jobs;
    const job = await jobs.enqueue(actor, {
      projectId: project.id,
      workspaceId: project.id,
      dungeon: 'osint',
      type: 'osint.scan',
      checkpoint: { kind: input.kind, value: input.value },
    });
    await jobs.waitForRuntime(actor, job.id);
    await jobs.resumeFromRuntime(actor, job.id);

    const target = await this.records(actor).create(actor, {
      workspaceId: project.id,
      dungeon: 'osint',
      kind: 'target',
      title: input.value,
      status: 'running',
      payload: { kind: input.kind, value: input.value },
      jobId: job.id,
    });

    try {
      const lookups = await this.deps.collector.lookup({ kind: input.kind, value: input.value.trim() });
      const findings: DungeonRecordRow[] = [];
      for (const hit of lookups) {
        findings.push(await this.persistFinding(actor, project.id, target.id, job.id, hit));
      }
      let dossier: DungeonRecordRow | undefined;
      if (input.synthesize !== false) {
        dossier = await this.synthesize(actor, project.id, target, findings);
      }
      const updated = await this.records(actor).update(actor, target.id, {
        status: 'completed',
        payload: { ...target.payload, findingCount: findings.length, dossierId: dossier?.id ?? null },
        expectedRevision: target.revision,
      });
      await jobs.complete(actor, job.id);
      return { target: updated, findings, dossier };
    } catch (err) {
      const failure: StructuredFailure = {
        code: 'osint_failed',
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
        at: new Date().toISOString(),
      };
      await this.records(actor).update(actor, target.id, {
        status: 'failed',
        failure,
        expectedRevision: (await this.records(actor).get(actor, target.id))?.revision ?? target.revision,
      });
      await jobs.fail(actor, job.id, failure);
      throw err;
    }
  }

  private async persistFinding(
    actor: OsintActor,
    projectId: string,
    targetId: string,
    jobId: string,
    hit: PublicLookupResult,
  ): Promise<DungeonRecordRow> {
    const artefact = await this.deps.files.createTextArtefact(actor, {
      projectId,
      text: hit.evidence,
      type: 'osint.evidence',
    });
    const row = await this.records(actor).create(actor, {
      workspaceId: projectId,
      dungeon: 'osint',
      kind: 'finding',
      title: hit.summary.slice(0, 120),
      status: 'completed',
      payload: { source: hit.source, confidence: hit.confidence, summary: hit.summary },
      artefactId: artefact.id,
      contentHash: artefact.contentHash,
      jobId,
      parentId: targetId,
    });
    await this.deps.persistence.forActor(actor).provenance.record({
      artefactId: artefact.id,
      projectId,
      sourceInputs: [targetId, hit.source],
      inputManifestHash: null,
      provider: 'atlas.osint',
      model: 'public-lookup',
      toolCalls: [],
      jobId,
      timestamp: new Date().toISOString(),
      traceId: `osint:${targetId}:${row.id}`,
      capability: 'osint',
    });
    return row;
  }

  private async synthesize(
    actor: OsintActor,
    projectId: string,
    target: DungeonRecordRow,
    findings: DungeonRecordRow[],
  ): Promise<DungeonRecordRow> {
    const conversation = await this.deps.runtime.createConversation({
      title: `OSINT ${target.title}`,
      projectId,
    });
    let text = '';
    let executionId: string | null = null;
    const prompt = [
      'Produce a concise OSINT dossier from the findings. Do not invent sources. Cite only supplied findings.',
      `Target: ${JSON.stringify(target.payload)}`,
      ...findings.map((item) => `- ${item.payload.confidence}: ${item.payload.summary} (${item.payload.source})`),
    ].join('\n');
    for await (const event of this.deps.runtime.sendMessage(conversation.id, {
      content: prompt,
      capability: 'nexus/reason',
      privacy: 'any',
    })) {
      if (event.type === 'execution') executionId = event.execution.id;
      if (event.type === 'assistant.delta' && event.text) text += event.text;
      if (event.type === 'assistant.completed' && event.text) text = event.text;
    }
    const artefact = await this.deps.files.createTextArtefact(actor, {
      projectId,
      text: text.trim() || 'No synthesised dossier; findings remain the source of truth.',
      type: 'osint.dossier',
    });
    return this.records(actor).create(actor, {
      workspaceId: projectId,
      dungeon: 'osint',
      kind: 'dossier',
      title: `Dossier ${target.title}`,
      status: 'completed',
      payload: { targetId: target.id, executionId },
      artefactId: artefact.id,
      contentHash: artefact.contentHash,
      conversationId: conversation.id,
      parentId: target.id,
    });
  }

  private records(actor: OsintActor) {
    return this.deps.persistence.forActor(actor).dungeonRecords;
  }

  private async effectivePolicy(actor: OsintActor) {
    const bound = this.deps.persistence.forActor(actor).privacy;
    const tenantRow = await bound.getPolicy(actor, null);
    const dungeonRow = await bound.getPolicy(actor, 'osint');
    const tenant = this.deps.policy.parse(actor.tenantId, null, tenantRow?.payload ?? {});
    const dungeon = dungeonRow ? this.deps.policy.parse(actor.tenantId, 'osint', dungeonRow.payload) : null;
    return this.deps.policy.overlay(tenant, dungeon);
  }

  private async requireProject(actor: OsintActor, projectId: string, capability: 'artifact.read' | 'artifact.write') {
    this.assertActor(actor);
    const project = await this.deps.projects.get(actor, projectId);
    if (!project) throw new DungeonError('not_found', GENERIC_DENY, 404);
    this.authorize(actor, capability, project.id, project.tenantId);
    return project;
  }

  private authorize(actor: OsintActor, capability: 'artifact.read' | 'artifact.write', workspaceId: string, tenantId: string): void {
    const verdict = this.deps.authority.decide({
      principal: { principalId: actor.principalId, kind: 'user', tenantId: actor.tenantId, workspaceId },
      capability,
      resource: { type: 'artifact', id: workspaceId, tenantId, workspaceId },
    });
    if (verdict.decision !== 'ALLOW') throw new DungeonError('permission_denied', GENERIC_DENY, 404);
  }

  private assertActor(actor: OsintActor): void {
    if (!actor.tenantId?.trim() || !actor.principalId?.trim()) {
      throw new DungeonError('permission_denied', GENERIC_DENY, 401);
    }
  }
}
