import { randomUUID } from 'node:crypto';
import type { DungeonId, DungeonRegistration } from '@atlas-vnext/contracts';
import type { ConversationRuntime } from '@atlas-vnext/conversation';
import type { FilesService } from '@atlas-vnext/files';
import type { PersistenceActor, PlatformPersistence, SiteRecord, SiteRevisionRecord } from '@atlas-vnext/persistence';
import { AuthorityEngine, EffectivePolicyEngine } from '@atlas-vnext/permissions';
import type { ProjectService } from '@atlas-vnext/projects';

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

export class WebsiteStudioService {
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
      name: input.name.trim() || 'Site',
      urn: `urn:atlas:site:${id}`,
    });
  }

  async get(actor: WebsiteActor, id: string): Promise<SiteRecord> {
    const site = await this.deps.persistence.forActor(actor).sites.get(actor, id);
    if (!site) throw new WebsiteError('not_found', GENERIC_DENY, 404);
    this.authorize(actor, 'artifact.read', site.workspaceId, site.tenantId);
    return site;
  }

  async generate(actor: WebsiteActor, id: string, brief: string) {
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
    const conversation = await this.deps.runtime.createConversation({ title: site.name, projectId: site.workspaceId });
    let html = '';
    let executionId: string | null = null;
    for await (const event of this.deps.runtime.sendMessage(conversation.id, {
      content: `${this.deps.policy.scopedModelInstructions(policy)}\n\nGenerate a complete, accessible HTML document for this site brief. Return HTML only.\n\n${brief}`,
      capability: 'nexus/code',
      privacy: this.deps.policy.runtimePrivacy(policy),
    })) {
      if (event.type === 'execution') executionId = event.execution.id;
      if (event.type === 'assistant.delta' && event.text) html += event.text;
      if (event.type === 'assistant.completed' && event.text) html = event.text;
    }
    const cleaned = stripFences(html.trim()) || '<!doctype html><html lang="en"><title>Empty site</title><p>No HTML produced.</p></html>';
    const artefact = await this.deps.files.createTextArtefact(actor, {
      projectId: site.workspaceId,
      text: cleaned,
      type: 'website.html',
    });
    if (!artefact.contentHash) throw new WebsiteError('malformed', 'Generated site is missing a content hash.');
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
        sizeBytes: cleaned.length,
      },
    ]);
    await sites.setCurrentRevision(actor, site.id, revision.id);
    await this.deps.persistence.forActor(actor).provenance.record({
      artefactId: artefact.id,
      projectId: site.workspaceId,
      sourceInputs: [site.id, brief.slice(0, 64)],
      inputManifestHash: revision.manifestHash,
      provider: 'atlas.website',
      model: 'site.generate',
      toolCalls: [],
      jobId: executionId,
      timestamp: new Date().toISOString(),
      traceId: `website:${site.id}:${revision.id}`,
      capability: 'website',
    });
    return { site: await this.get(actor, site.id), revision, html: cleaned, executionId };
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
    const verdict = this.deps.authority.decide({
      principal: { principalId: actor.principalId, kind: 'user', tenantId: actor.tenantId, workspaceId },
      capability,
      resource: { type: 'artifact', id: workspaceId, tenantId, workspaceId },
    });
    if (verdict.decision !== 'ALLOW') throw new WebsiteError('permission_denied', GENERIC_DENY, 404);
  }
}

function stripFences(text: string): string {
  return text.replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
}
