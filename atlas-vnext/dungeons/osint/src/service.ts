import type { ConversationRuntime } from '@atlas-vnext/conversation';
import type { FilesService } from '@atlas-vnext/files';
import type { PersistenceActor, PlatformPersistence } from '@atlas-vnext/persistence';
import { AuthorityEngine, EffectivePolicyEngine } from '@atlas-vnext/permissions';
import type { ProjectService } from '@atlas-vnext/projects';
import type { DungeonRecordRow } from '@atlas-vnext/persistence';
import type { OsintTargetKind, PublicLookupResult, StructuredFailure } from '@atlas-vnext/contracts';
import type { PublicLookupPort } from './collector.ts';
import { DungeonError, GENERIC_DENY } from './errors.ts';
import { composeOsintReport, looksLikeOsintFollowup, looksLikeOsintRequest, strongestHit } from './report.ts';

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
    const rows = await this.records(actor).list(actor, {
      workspaceId: target.workspaceId,
      dungeon: 'osint',
      parentId: target.id,
    });
    return rows.filter((row) => row.kind === 'finding' || row.kind === 'correlation');
  }

  async maybeRunFromConversation(
    actor: OsintActor,
    input: {
      conversationId: string;
      projectId: string | null;
      question: string;
      signal?: AbortSignal;
    },
  ): Promise<{ handled: boolean; text?: string; failed?: boolean }> {
    if (!input.projectId) return { handled: false };
    try {
      if (looksLikeOsintFollowup(input.question) && !looksLikeOsintRequest(input.question)) {
        const text = await this.answerFollowup(actor, input.projectId, input.conversationId, input.question);
        return text ? { handled: true, text } : { handled: false };
      }
      const parsed = parseQuestionTarget(input.question);
      const result = await this.scan(actor, {
        projectId: input.projectId,
        kind: parsed.kind,
        value: parsed.value,
        synthesize: true,
        conversationId: input.conversationId,
        signal: input.signal,
      });
      const report = String(result.target.payload.reportText ?? '');
      return { handled: true, failed: result.target.status === 'failed', text: report };
    } catch (err) {
      if (err instanceof DungeonError && (err.code === 'permission_denied' || err.code === 'insufficient_evidence')) {
        return { handled: true, failed: true, text: err.message };
      }
      throw err;
    }
  }

  async scan(
    actor: OsintActor,
    input: {
      projectId: string;
      kind: OsintTargetKind;
      value: string;
      synthesize?: boolean;
      conversationId?: string | null;
      signal?: AbortSignal;
    },
  ): Promise<{ target: DungeonRecordRow; findings: DungeonRecordRow[]; dossier?: DungeonRecordRow; correlations: DungeonRecordRow[] }> {
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
    const write = this.deps.policy.authorize({
      principal: { principalId: actor.principalId, kind: 'user', tenantId: actor.tenantId, workspaceId: project.id },
      capability: 'artifact.write',
      dungeonId: 'osint',
      policy,
      resource: { type: 'artifact', id: project.id, tenantId: actor.tenantId, workspaceId: project.id },
    });
    if (!write.allowed) throw new DungeonError('permission_denied', GENERIC_DENY, 404);

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
      conversationId: input.conversationId ?? null,
    });

    try {
      const lookups = await this.deps.collector.lookup({
        kind: input.kind,
        value: input.value.trim(),
        signal: input.signal,
      });
      const blockedPrivate = lookups.some((hit) => {
        if (hit.status !== 'blocked') return false;
        if (hit.probe === 'ip.validate' || hit.probe === 'url.validate' || hit.source === 'ssrf' || hit.source === 'ip.ssrf') {
          return true;
        }
        if (hit.probe === 'dns.a' || hit.probe === 'dns.aaaa') {
          const hasPublic = lookups.some(
            (row) => (row.probe === 'dns.a' || row.probe === 'dns.aaaa') && row.status === 'confirmed',
          );
          return !hasPublic;
        }
        return false;
      });
      if (blockedPrivate) {
        throw new DungeonError('permission_denied', GENERIC_DENY, 404);
      }
      const probed = lookups.filter((hit) => (hit.epistemicKind ?? 'observation') !== 'hypothesis');
      if (probed.length === 0) {
        throw new DungeonError(
          'insufficient_evidence',
          composeOsintReport({ kind: input.kind, value: input.value, hits: lookups, failed: true }),
          422,
        );
      }

      const findings: DungeonRecordRow[] = [];
      const correlations: DungeonRecordRow[] = [];
      for (const hit of lookups) {
        const row = await this.persistFinding(actor, project.id, target.id, job.id, hit, input.conversationId);
        if (hit.epistemicKind === 'correlation') correlations.push(row);
        else findings.push(row);
      }
      const reportText = composeOsintReport({ kind: input.kind, value: input.value, hits: lookups, failed: false });
      let dossier: DungeonRecordRow | undefined;
      if (input.synthesize !== false) {
        dossier = await this.persistDossier(actor, project.id, target, findings, reportText, input.conversationId, job.id);
      }
      const updated = await this.records(actor).update(actor, target.id, {
        status: 'completed',
        payload: {
          ...target.payload,
          findingCount: findings.length,
          correlationCount: correlations.length,
          dossierId: dossier?.id ?? null,
          reportText,
          strongest: strongestObservation(lookups),
        },
        expectedRevision: target.revision,
      });
      await jobs.complete(actor, job.id);
      return { target: updated, findings, dossier, correlations };
    } catch (err) {
      if (err instanceof DungeonError && err.code === 'permission_denied') {
        await this.failJob(actor, target, job.id, err);
        throw err;
      }
      const failure: StructuredFailure = {
        code: err instanceof DungeonError ? err.code : 'osint_failed',
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
        at: new Date().toISOString(),
      };
      await this.records(actor).update(actor, target.id, {
        status: 'failed',
        failure,
        payload: { ...target.payload, reportText: failure.message },
        expectedRevision: (await this.records(actor).get(actor, target.id))?.revision ?? target.revision,
      });
      await jobs.fail(actor, job.id, failure);
      if (err instanceof DungeonError && err.code === 'insufficient_evidence') throw err;
      throw err;
    }
  }

  private async answerFollowup(
    actor: OsintActor,
    projectId: string,
    conversationId: string,
    question: string,
  ): Promise<string | null> {
    await this.requireProject(actor, projectId, 'artifact.read');
    const targets = await this.records(actor).list(actor, { workspaceId: projectId, dungeon: 'osint', kind: 'target' });
    const latest = [...targets]
      .filter((row) => row.conversationId === conversationId && row.status === 'completed')
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .at(-1);
    if (!latest) return null;
    const otherDungeons = ['research', 'writing', 'investigation', 'website', 'music'] as const;
    const laterLists = await Promise.all(
      otherDungeons.map((dungeon) => this.records(actor).list(actor, { workspaceId: projectId, dungeon })),
    );
    const laterWork = laterLists.flat().some(
      (row) =>
        row.conversationId === conversationId && row.status === 'completed' && row.updatedAt > latest.updatedAt,
    );
    if (laterWork) return null;
    const children = await this.listFindings(actor, latest.id);
    const observations = children.filter((row) => row.kind === 'finding' && row.payload.epistemicKind !== 'hypothesis');
    const confirmed = observations.filter(
      (row) => row.payload.status === 'confirmed' || row.payload.confidence === 'confirmed',
    );
    const q = question.toLowerCase();
    if (/\bstrongest\b/.test(q)) {
      const stored = latest.payload.strongest as { summary?: string; url?: string; source?: string } | null;
      const best = stored?.summary
        ? stored
        : confirmed[0]
          ? {
              summary: String(confirmed[0].payload.summary ?? confirmed[0].title),
              url: typeof confirmed[0].payload.url === 'string' ? confirmed[0].payload.url : undefined,
              source: String(confirmed[0].payload.source ?? ''),
            }
          : null;
      if (!best?.summary) return `No confirmed OSINT finding is stored for this conversation (target ${latest.id}).`;
      return `Strongest finding: ${best.summary}${best.url ? ` (${best.url})` : ''}${best.source ? ` source=${best.source}` : ''}.`;
    }
    if (/\bsource/.test(q)) {
      const sources = observations
        .filter((row) => typeof row.payload.url === 'string' || row.payload.source)
        .slice(0, 12)
        .map((row) => `- ${String(row.payload.source ?? row.title)}${row.payload.url ? ` (${row.payload.url})` : ''} [${String(row.payload.status ?? row.payload.confidence)}]`);
      return sources.length
        ? `Sources supporting the OSINT scan of \`${latest.title}\`:\n${sources.join('\n')}`
        : `No source URLs are stored for target ${latest.id}.`;
    }
    const ordinal = /\bsecond\b|\b2nd\b/.test(q) ? 1 : /\bthird\b|\b3rd\b/.test(q) ? 2 : /\blast\b/.test(q) ? observations.length - 1 : 0;
    const picked = (confirmed.length ? confirmed : observations)[ordinal];
    if (!picked) return `There is no observation at that position for target ${latest.id}.`;
    return `Opened ${ordinal + 1 === 1 ? 'first' : ordinal + 1 === 2 ? 'second' : 'that'} observation: ${String(picked.payload.summary ?? picked.title)}${picked.payload.url ? ` (${picked.payload.url})` : ''} id=${picked.id}.`;
  }

  private async persistFinding(
    actor: OsintActor,
    projectId: string,
    targetId: string,
    jobId: string,
    hit: PublicLookupResult,
    conversationId?: string | null,
  ): Promise<DungeonRecordRow> {
    const artefact = await this.deps.files.createTextArtefact(actor, {
      projectId,
      text: hit.evidence,
      type: hit.epistemicKind === 'correlation' ? 'osint.correlation' : 'osint.evidence',
    });
    const row = await this.records(actor).create(actor, {
      workspaceId: projectId,
      dungeon: 'osint',
      kind: hit.epistemicKind === 'correlation' ? 'correlation' : 'finding',
      title: hit.summary.slice(0, 120),
      status: 'completed',
      payload: {
        source: hit.source,
        confidence: hit.confidence,
        summary: hit.summary,
        url: hit.url ?? hit.canonicalUrl ?? null,
        status: hit.status ?? (hit.confidence === 'confirmed' ? 'confirmed' : 'possible'),
        probe: hit.probe ?? hit.source,
        observedAt: hit.observedAt ?? new Date().toISOString(),
        contentHash: hit.contentHash ?? artefact.contentHash,
        httpStatus: hit.httpStatus ?? null,
        epistemicKind: hit.epistemicKind ?? 'observation',
      },
      artefactId: artefact.id,
      contentHash: artefact.contentHash,
      jobId,
      parentId: targetId,
      conversationId: conversationId ?? null,
    });
    await this.deps.persistence.forActor(actor).provenance.record({
      artefactId: artefact.id,
      projectId,
      sourceInputs: [targetId, hit.source, hit.url ?? hit.probe ?? ''],
      inputManifestHash: hit.contentHash ?? null,
      provider: 'atlas.osint',
      model: hit.probe ?? 'public-lookup',
      toolCalls: [],
      jobId,
      timestamp: hit.observedAt ?? new Date().toISOString(),
      traceId: `osint:${targetId}:${row.id}`,
      capability: 'osint',
    });
    return row;
  }

  private async persistDossier(
    actor: OsintActor,
    projectId: string,
    target: DungeonRecordRow,
    findings: DungeonRecordRow[],
    reportText: string,
    conversationId: string | null | undefined,
    jobId: string,
  ): Promise<DungeonRecordRow> {
    const artefact = await this.deps.files.createTextArtefact(actor, {
      projectId,
      text: reportText,
      type: 'osint.dossier',
    });
    return this.records(actor).create(actor, {
      workspaceId: projectId,
      dungeon: 'osint',
      kind: 'dossier',
      title: `Dossier ${target.title}`,
      status: 'completed',
      payload: { targetId: target.id, deterministic: true, findingCount: findings.length },
      artefactId: artefact.id,
      contentHash: artefact.contentHash,
      conversationId: conversationId ?? null,
      parentId: target.id,
      jobId,
    });
  }

  private async failJob(actor: OsintActor, target: DungeonRecordRow, jobId: string, err: DungeonError) {
    const failure: StructuredFailure = {
      code: err.code,
      message: err.message,
      retryable: false,
      at: new Date().toISOString(),
    };
    await this.records(actor).update(actor, target.id, {
      status: 'failed',
      failure,
      expectedRevision: (await this.records(actor).get(actor, target.id))?.revision ?? target.revision,
    });
    await this.deps.persistence.forActor(actor).jobs.fail(actor, jobId, failure);
  }

  private records(actor: OsintActor) {
    return this.deps.persistence.forActor(actor).dungeonRecords;
  }

  private async effectivePolicy(actor: OsintActor) {
    return this.deps.policy.loadForDungeon(actor.tenantId, 'osint', (dungeonId) =>
      this.deps.persistence.forActor(actor).privacy.getPolicy(actor, dungeonId),
    );
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

export function parseQuestionTarget(question: string): { kind: OsintTargetKind; value: string } {
  const trimmed = question.trim();
  const url = trimmed.match(/https?:\/\/[^\s]+/i);
  if (url) return { kind: 'url', value: url[0]! };
  const email = trimmed.match(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/);
  if (email) return { kind: 'email', value: email[0]! };
  for (const token of trimmed.split(/\s+/)) {
    const candidate = token.replace(/^\[/, '').replace(/\][,.]?$/, '').replace(/,$/, '');
    if (looksLikeIpLiteral(candidate)) return { kind: 'ip', value: candidate };
  }
  const ip = trimmed.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  if (ip) return { kind: 'ip', value: ip[0]! };
  const domain = trimmed.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/i);
  if (domain && !trimmed.includes('@')) return { kind: 'domain', value: domain[0]!.toLowerCase() };
  const handle = trimmed.match(/@([A-Za-z0-9_]{2,32})/);
  if (handle) return { kind: 'username', value: handle[1]! };
  const afterOn = trimmed.match(/\b(?:on|for|against)\s+([A-Za-z0-9._-]{2,64})\s*$/i);
  if (afterOn) return { kind: 'username', value: afterOn[1]!.replace(/^@/, '') };
  return { kind: 'username', value: trimmed.replace(/^.*\b(osint|scan|footprint)\s+(on\s+)?/i, '').trim() || trimmed };
}

function looksLikeIpLiteral(value: string): boolean {
  if (!value) return false;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return true;
  if (!value.includes(':')) return false;
  return /^[0-9a-f:.]+$/i.test(value) && (value.match(/:/g)?.length ?? 0) >= 2;
}

function strongestObservation(hits: PublicLookupResult[]): { summary: string; url?: string; source: string } | null {
  const best = strongestHit(hits);
  if (!best) return null;
  return { summary: best.summary, url: best.url ?? best.canonicalUrl, source: best.source };
}
