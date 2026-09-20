import { randomUUID } from 'node:crypto';
import type { DungeonId, DungeonRegistration, SiteGeneratePort } from '@atlas-vnext/contracts';
import type { FilesService } from '@atlas-vnext/files';
import type { PersistenceActor, PlatformPersistence, SiteRecord, SiteRevisionRecord } from '@atlas-vnext/persistence';
import { AuthorityEngine, EffectivePolicyEngine } from '@atlas-vnext/permissions';
import type { ProjectService } from '@atlas-vnext/projects';
import { assembleSiteHtml } from './assemble.ts';
import { auditSiteHtml, sanitizeSiteHtml, type SiteAudit } from './audit.ts';
import {
  isWebsiteRegenerateFollowup,
  isWebsiteRevisionFollowup,
  libraryPathForSite,
  looksLikeWebsiteFollowup,
  looksLikeWebsiteRequest,
  titleFromBrief,
} from './intent.ts';
import { composeWebsiteReport, isAbortError, isContentFilterError } from './report.ts';

export const dungeonId: DungeonId = 'website';

export const websiteDungeon = {
  id: dungeonId,
  title: 'Website Studio',
  description: 'Site generation and audits over Atlas projects, CAS manifests, and Authority.',
} as const;

export const WEBSITE_DUNGEON: DungeonRegistration = {
  id: 'website',
  slug: 'website',
  title: 'Website Studio',
  navLabel: 'Website',
  description: 'Canonical site per project. Preview is ephemeral; production promote is Authority-gated.',
  surface: 'website-studio',
  routes: {
    list: '/api/projects/:projectId/sites',
    item: '/api/sites/:id',
    generate: '/api/sites/:id/generate',
    preview: '/api/sites/:id/preview',
    promote: '/api/sites/:id/promote',
  },
  capabilities: ['project.read', 'artifact.read', 'artifact.write', 'deployment.promote'],
  permissions: { read: 'artifact.read', write: 'artifact.write' },
  featureAvailable: true,
};

export const GENERIC_DENY = 'Permission denied.';

export class WebsiteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
    this.name = 'WebsiteError';
  }
}

export interface WebsiteActor extends PersistenceActor {
  principalId: string;
  tenantId: string;
}

export type SiteGenerateResult = {
  site: SiteRecord;
  revision: SiteRevisionRecord;
  html: string;
  source: 'model' | 'assembler';
  audit: SiteAudit;
  reportText: string;
  libraryOk: boolean;
};

export class WebsiteStudioService {
  constructor(
    private readonly deps: {
      persistence: PlatformPersistence;
      projects: ProjectService;
      files: FilesService;
      authority: AuthorityEngine;
      policy: EffectivePolicyEngine;
      generate?: SiteGeneratePort;
    },
  ) {}

  async list(actor: WebsiteActor, projectId: string): Promise<SiteRecord[]> {
    await this.requireProject(actor, projectId, 'artifact.read');
    return this.deps.persistence.forActor(actor).sites.list(actor, projectId);
  }

  async create(actor: WebsiteActor, input: { projectId: string; name: string; brief: string }) {
    const project = await this.requireProject(actor, input.projectId, 'artifact.write');
    const id = `site_${randomUUID()}`;
    return this.deps.persistence.forActor(actor).sites.create(actor, {
      id,
      workspaceId: project.id,
      name: input.name.trim() || titleFromBrief(input.brief) || 'Site',
      urn: `urn:atlas:site:${id}`,
    });
  }

  async get(actor: WebsiteActor, id: string): Promise<SiteRecord> {
    const site = await this.deps.persistence.forActor(actor).sites.get(actor, id);
    if (!site) throw new WebsiteError('not_found', GENERIC_DENY, 404);
    this.authorize(actor, 'artifact.read', site.workspaceId, site.tenantId);
    return site;
  }

  async maybeRunFromConversation(
    actor: WebsiteActor,
    input: {
      conversationId: string;
      projectId: string | null;
      question: string;
      signal?: AbortSignal;
    },
  ): Promise<{ handled: boolean; text?: string; failed?: boolean }> {
    if (!input.projectId) return { handled: false };
    if (input.signal?.aborted) {
      return { handled: true, failed: true, text: 'Website generation was cancelled.' };
    }
    const isRequest = looksLikeWebsiteRequest(input.question);
    const isFollowup = looksLikeWebsiteFollowup(input.question);
    if (!isRequest && !isFollowup) return { handled: false };
    try {
      if (isFollowup && !isRequest) {
        return this.answerFollowup(actor, {
          conversationId: input.conversationId,
          projectId: input.projectId,
          question: input.question,
          signal: input.signal,
        });
      }
      const site = await this.create(actor, {
        projectId: input.projectId,
        name: titleFromBrief(input.question),
        brief: input.question,
      });
      const generated = await this.generate(actor, site.id, input.question, {
        conversationId: input.conversationId,
        signal: input.signal,
      });
      return { handled: true, text: generated.reportText };
    } catch (err) {
      if (err instanceof WebsiteError && (err.code === 'permission_denied' || err.code === 'not_found')) {
        return { handled: true, failed: true, text: err.message };
      }
      if (isAbortError(err) || input.signal?.aborted) {
        return { handled: true, failed: true, text: 'Website generation was cancelled.' };
      }
      throw err;
    }
  }

  async generate(
    actor: WebsiteActor,
    id: string,
    brief: string,
    options: { conversationId?: string | null; signal?: AbortSignal; previousHtml?: string | null } = {},
  ): Promise<SiteGenerateResult> {
    if (options.signal?.aborted) throw abortError();
    const site = await this.get(actor, id);
    this.authorize(actor, 'artifact.write', site.workspaceId, site.tenantId);
    const policy = await this.effectivePolicy(actor);
    const write = this.deps.policy.authorize({
      principal: { principalId: actor.principalId, kind: 'user', tenantId: actor.tenantId, workspaceId: site.workspaceId },
      capability: 'artifact.write',
      dungeonId: 'website',
      policy,
      resource: { type: 'artifact', id: site.id, tenantId: site.tenantId, workspaceId: site.workspaceId },
    });
    if (!write.allowed) throw new WebsiteError('permission_denied', GENERIC_DENY, 404);

    const priorHtml = options.previousHtml ?? (await this.currentHtml(actor, site));
    const produced = await this.produceHtml(brief, options.signal, this.deps.policy.runtimePrivacy(policy), priorHtml);
    if (options.signal?.aborted) throw abortError();

    const artefact = await this.deps.files.createTextArtefact(actor, {
      projectId: site.workspaceId,
      text: produced.html,
      type: 'website.html',
    });
    if (!artefact.contentHash) throw new WebsiteError('malformed', 'Generated site is missing a content hash.');
    if (options.signal?.aborted) throw abortError();

    const sites = this.deps.persistence.forActor(actor).sites;
    const prior = site.currentRevisionId ? await sites.getRevision(actor, site.currentRevisionId) : null;
    const revision = await sites.createRevision(actor, {
      id: `srev_${randomUUID()}`,
      siteId: site.id,
      workspaceId: site.workspaceId,
      artefactId: artefact.id,
      parentId: prior?.id ?? null,
      version: (prior?.version ?? 0) + 1,
      manifestHash: artefact.contentHash,
      retentionClass: 'ephemeral',
      pinReason: null,
      retainedUntil: null,
    });
    await sites.replaceEntries(actor, revision.id, [
      {
        path: 'index.html',
        contentHash: artefact.contentHash,
        mimeType: 'text/html',
        sizeBytes: Buffer.byteLength(produced.html, 'utf8'),
      },
    ]);
    const next = await sites.setCurrentRevision(actor, site.id, revision.id);

    try {
      await this.deps.persistence.forActor(actor).provenance.record({
        artefactId: artefact.id,
        projectId: site.workspaceId,
        sourceInputs: [site.id, brief.slice(0, 64), produced.source],
        inputManifestHash: revision.manifestHash,
        provider: 'atlas.website',
        model: produced.source === 'model' ? 'site.generate.model' : 'site.assemble',
        toolCalls: [],
        jobId: null,
        timestamp: new Date().toISOString(),
        traceId: `website:${site.id}:${revision.id}`,
        capability: 'website',
      });
    } catch {
      // Provenance is derived; the committed revision remains the source of truth.
    }

    await this.deps.persistence.forActor(actor).dungeonRecords.create(actor, {
      workspaceId: site.workspaceId,
      dungeon: 'website',
      kind: 'site',
      title: next.name,
      status: 'completed',
      payload: {
        siteId: next.id,
        brief: brief.slice(0, 800),
        source: produced.source,
        audit: produced.audit,
        revision: revision.version,
      },
      artefactId: artefact.id,
      contentHash: artefact.contentHash,
      conversationId: options.conversationId ?? null,
    });

    const libraryOk = await this.publishLibraryFile(actor, next, artefact.id, artefact.contentHash, produced.html);
    const reportText = composeWebsiteReport({
      title: next.name,
      siteId: next.id,
      revision: revision.version,
      source: produced.source,
      note: produced.note,
      audit: produced.audit,
      html: produced.html,
      libraryOk,
    });
    return {
      site: next,
      revision,
      html: produced.html,
      source: produced.source,
      audit: produced.audit,
      reportText,
      libraryOk,
    };
  }

  async preview(actor: WebsiteActor, id: string): Promise<{ html: string; revision: SiteRevisionRecord | null }> {
    const site = await this.get(actor, id);
    if (!site.currentRevisionId) return { html: '<!doctype html><p>No preview.</p>', revision: null };
    const revision = await this.deps.persistence.forActor(actor).sites.getRevision(actor, site.currentRevisionId);
    if (!revision?.artefactId) return { html: '<!doctype html><p>No preview artefact.</p>', revision };
    const html = await this.deps.files.readArtefactText(actor, revision.artefactId);
    return { html, revision };
  }

  async promote(actor: WebsiteActor, id: string) {
    const site = await this.get(actor, id);
    const policy = await this.effectivePolicy(actor);
    const verdict = this.deps.policy.authorize({
      principal: { principalId: actor.principalId, kind: 'user', tenantId: actor.tenantId, workspaceId: site.workspaceId },
      capability: 'deployment.promote',
      dungeonId: 'website',
      policy,
      resource: { type: 'artifact', id: site.id, tenantId: site.tenantId, workspaceId: site.workspaceId },
    });
    if (!verdict.allowed) throw new WebsiteError('permission_denied', GENERIC_DENY, 404);
    if (!site.currentRevisionId) throw new WebsiteError('malformed', 'Nothing to promote.');
    const revision = await this.deps.persistence.forActor(actor).sites.setRetentionClass(
      actor,
      site.currentRevisionId,
      'published',
      'production-promote',
    );
    return { site, revision };
  }

  private async answerFollowup(
    actor: WebsiteActor,
    input: { conversationId: string; projectId: string; question: string; signal?: AbortSignal },
  ): Promise<{ handled: boolean; text?: string; failed?: boolean }> {
    try {
      await this.requireProject(actor, input.projectId, 'artifact.read');
    } catch (err) {
      if (err instanceof WebsiteError && (err.code === 'permission_denied' || err.code === 'not_found')) {
        return { handled: true, failed: true, text: err.message };
      }
      throw err;
    }
    const bound = await this.siteForConversation(actor, input.projectId, input.conversationId);
    if (!bound) return { handled: false };
    const siteId = bound.siteId;
    const storedBrief = bound.brief;
    const q = input.question;
    if (isWebsiteRegenerateFollowup(q)) {
      const generated = await this.generate(actor, siteId, storedBrief || q, {
        conversationId: input.conversationId,
        signal: input.signal,
      });
      return { handled: true, text: generated.reportText };
    }
    if (isWebsiteRevisionFollowup(q)) {
      const generated = await this.generate(
        actor,
        siteId,
        `Revise the existing site.\nInstruction: ${q}\nOriginal brief: ${storedBrief || bound.title}`,
        { conversationId: input.conversationId, signal: input.signal },
      );
      return { handled: true, text: generated.reportText };
    }
    if (/\bpublish|promote\b/i.test(q)) {
      return {
        handled: true,
        text: 'Publishing is an owner action in Website. Preview is stored; production still needs deployment.promote and repository write.',
      };
    }
    const preview = await this.preview(actor, siteId);
    const excerpt = preview.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 280);
    return {
      handled: true,
      text: composeWebsiteReport({
        title: bound.title,
        siteId,
        revision: preview.revision?.version ?? bound.revision,
        source: 'model',
        audit: { ok: true, findings: [] },
        html: preview.html,
        libraryOk: true,
        note: excerpt ? undefined : 'Preview is ready.',
      }),
    };
  }

  private async siteForConversation(actor: WebsiteActor, projectId: string, conversationId: string) {
    const records = await this.deps.persistence.forActor(actor).dungeonRecords.list(actor, {
      workspaceId: projectId,
      dungeon: 'website',
      kind: 'site',
    });
    const mine = records
      .filter((row) => row.conversationId === conversationId && row.status === 'completed')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const latest = mine[0];
    if (!latest) return null;
    const siteId = typeof latest.payload.siteId === 'string' ? latest.payload.siteId : null;
    if (!siteId) return null;
    return {
      siteId,
      title: latest.title,
      brief: typeof latest.payload.brief === 'string' ? latest.payload.brief : '',
      revision: typeof latest.payload.revision === 'number' ? latest.payload.revision : 1,
    };
  }

  private async currentHtml(actor: WebsiteActor, site: SiteRecord): Promise<string | null> {
    if (!site.currentRevisionId) return null;
    const revision = await this.deps.persistence.forActor(actor).sites.getRevision(actor, site.currentRevisionId);
    if (!revision?.artefactId) return null;
    try {
      return await this.deps.files.readArtefactText(actor, revision.artefactId);
    } catch {
      return null;
    }
  }

  private async produceHtml(
    brief: string,
    signal: AbortSignal | undefined,
    privacy: 'any' | 'local_only',
    previousHtml: string | null,
  ): Promise<{ html: string; source: 'model' | 'assembler'; audit: SiteAudit; note?: string }> {
    if (signal?.aborted) throw abortError();
    let note: string | undefined;
    let html = '';
    let source: 'model' | 'assembler' = 'assembler';
    if (this.deps.generate) {
      try {
        const generated = await this.deps.generate.generateHtml({
          brief,
          previousHtml,
          signal,
          privacy,
        });
        if (signal?.aborted) throw abortError();
        html = sanitizeSiteHtml(generated.html);
        source = 'model';
      } catch (err) {
        if (isAbortError(err) || signal?.aborted) throw isAbortError(err) ? err : abortError();
        if (isContentFilterError(err) || isEmptyHtmlError(err)) {
          source = 'assembler';
          note = isContentFilterError(err)
            ? 'The model declined this brief. Atlas assembled a first draft instead of failing the run.'
            : 'The model returned no usable HTML. Atlas assembled a first draft from the brief.';
        } else {
          throw err;
        }
      }
    }
    let audit = html ? auditSiteHtml(html) : { ok: false, findings: ['No HTML.'] };
    if (!audit.ok) {
      html = assembleSiteHtml(brief);
      source = 'assembler';
      audit = auditSiteHtml(html);
      note ??= 'Atlas assembled a first-draft page from the brief.';
    }
    if (!audit.ok) throw new WebsiteError('malformed', 'Website HTML failed audit.');
    return { html, source, audit, note };
  }

  private async publishLibraryFile(
    actor: WebsiteActor,
    site: SiteRecord,
    artefactId: string,
    contentHash: string,
    html: string,
  ): Promise<boolean> {
    try {
      await this.deps.files.publishArtefactFile(actor, {
        projectId: site.workspaceId,
        path: libraryPathForSite(site.id),
        displayName: `${site.name}.html`,
        artefactId,
        contentHash,
        mimeType: 'text/html',
        sizeBytes: Buffer.byteLength(html, 'utf8'),
      });
      return true;
    } catch {
      return false;
    }
  }

  private async effectivePolicy(actor: WebsiteActor) {
    return this.deps.policy.loadForDungeon(actor.tenantId, 'website', (dungeonId) =>
      this.deps.persistence.forActor(actor).privacy.getPolicy(actor, dungeonId),
    );
  }

  private async requireProject(actor: WebsiteActor, projectId: string, capability: 'artifact.read' | 'artifact.write') {
    if (!actor.tenantId || !actor.principalId) throw new WebsiteError('permission_denied', GENERIC_DENY, 401);
    const project = await this.deps.projects.get(actor, projectId);
    if (!project) throw new WebsiteError('not_found', GENERIC_DENY, 404);
    this.authorize(actor, capability, project.id, project.tenantId);
    return project;
  }

  private authorize(actor: WebsiteActor, capability: 'artifact.read' | 'artifact.write', workspaceId: string, tenantId: string) {
    if (actor.tenantId !== tenantId) throw new WebsiteError('permission_denied', GENERIC_DENY, 404);
    const verdict = this.deps.authority.decide({
      principal: { principalId: actor.principalId, kind: 'user', tenantId: actor.tenantId, workspaceId },
      capability,
      resource: { type: 'artifact', id: workspaceId, tenantId, workspaceId },
    });
    if (verdict.decision !== 'ALLOW') throw new WebsiteError('permission_denied', GENERIC_DENY, 404);
  }
}

export { looksLikeWebsiteFollowup, looksLikeWebsiteRequest, titleFromBrief, libraryPathForSite, siteIdFromLibraryPath } from './intent.ts';
export { assembleSiteHtml, escapeHtml } from './assemble.ts';
export { auditSiteHtml, sanitizeSiteHtml } from './audit.ts';

function abortError(): Error & { code: string } {
  const error = new Error('aborted') as Error & { code: string };
  error.code = 'aborted';
  return error;
}

function isEmptyHtmlError(err: unknown): boolean {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: string }).code) : '';
  const message = err instanceof Error ? err.message : String(err);
  return code === 'empty_html' || /no html|empty html/i.test(message);
}
