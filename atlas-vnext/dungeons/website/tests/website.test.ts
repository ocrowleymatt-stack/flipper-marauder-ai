import { afterEach, describe, expect, it } from 'vitest';
import { WebsiteStudioService } from '../src/index.ts';
import { assembleSiteHtml } from '../src/assemble.ts';
import { auditSiteHtml } from '../src/audit.ts';
import { closePersistence, openDungeonStack } from '../../../tests/helpers/dungeon-stack.ts';
import type { PlatformPersistence } from '@atlas-vnext/persistence';
import type { SiteGeneratePort } from '@atlas-vnext/contracts';

const persistences: PlatformPersistence[] = [];

afterEach(async () => {
  while (persistences.length) {
    const item = persistences.pop();
    if (item) await closePersistence(item);
  }
});

function modelHtml(marker: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${marker}</title></head><body><h1>${marker}</h1><p>${marker} landing page with enough visible copy for the audit.</p></body></html>`;
}

describe('Website Studio dungeon', () => {
  it('escapes brief HTML so assembler pages cannot inject script', () => {
    const html = assembleSiteHtml('Build a website about <script>alert(1)</script> tents and cocoa');
    expect(html).not.toMatch(/<script>alert/);
    expect(html).toMatch(/&lt;script&gt;/);
    expect(auditSiteHtml(html).ok).toBe(true);
  });

  it('generates a CAS-backed preview and requires Authority plus effective policy for promote', async () => {
    const stack = await openDungeonStack('<!doctype html><html lang="en"><title>Studio</title><p>Hello</p></html>');
    persistences.push(stack.persistence);
    const website = new WebsiteStudioService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      authority: stack.authority,
      policy: stack.policy,
    });
    const site = await website.create(stack.actor, { projectId: stack.project.id, name: 'Studio', brief: 'Hello site' });
    const generated = await website.generate(stack.actor, site.id, 'A small accessible studio page.');
    expect(generated.revision.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    const preview = await website.preview(stack.actor, site.id);
    expect(preview.html.length).toBeGreaterThan(0);
    await expect(website.promote(stack.actor, site.id)).rejects.toMatchObject({ httpStatus: 404 });
    await stack.persistence.forActor(stack.actor).privacy.upsertPolicy(stack.actor, {
      dungeonId: null,
      payload: stack.policy.parse(stack.actor.tenantId, null, { repoWrite: true }),
      updatedBy: stack.actor.principalId,
    });
    const promoted = await website.promote(stack.actor, site.id);
    expect(promoted.revision.retentionClass).toBe('published');
  });

  it('refuses generate when stored autonomyCeiling is suggest', async () => {
    const stack = await openDungeonStack('<p>x</p>');
    persistences.push(stack.persistence);
    await stack.persistence.forActor(stack.actor).privacy.upsertPolicy(stack.actor, {
      dungeonId: null,
      payload: stack.policy.parse(stack.actor.tenantId, null, { autonomyCeiling: 'suggest' }),
      updatedBy: stack.actor.principalId,
    });
    const website = new WebsiteStudioService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      authority: stack.authority,
      policy: stack.policy,
    });
    const site = await website.create(stack.actor, { projectId: stack.project.id, name: 'Locked', brief: 'x' });
    await expect(website.generate(stack.actor, site.id, 'x')).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('does not promote without deployment.promote', async () => {
    const stack = await openDungeonStack('<p>x</p>');
    persistences.push(stack.persistence);
    const stranger = { tenantId: 'tenant_a', principalId: 'principal_other' };
    stack.authority.grantMembership(stranger.principalId, stranger.tenantId);
    stack.authority.grantTo({ principalId: stranger.principalId, tenantId: stranger.tenantId, capability: 'artifact.read' });
    stack.authority.grantTo({ principalId: stranger.principalId, tenantId: stranger.tenantId, capability: 'artifact.write' });
    const website = new WebsiteStudioService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      authority: stack.authority,
      policy: stack.policy,
    });
    const site = await website.create(stack.actor, { projectId: stack.project.id, name: 'Locked', brief: 'x' });
    await website.generate(stack.actor, site.id, 'x');
    await expect(website.promote(stranger, site.id)).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('uses host-injected HTML when the audit passes and does not call sendMessage', async () => {
    const stack = await openDungeonStack('should-not-appear');
    persistences.push(stack.persistence);
    let send = 0;
    const runtime = stack.runtime;
    const original = runtime.sendMessage?.bind(runtime);
    runtime.sendMessage = (async function* sendMessage() {
      send += 1;
      if (original) yield* original('ignored', { content: 'x' } as never);
    }) as typeof runtime.sendMessage;
    const generate: SiteGeneratePort = {
      async generateHtml() {
        return { html: modelHtml('Model Circus') };
      },
    };
    const website = new WebsiteStudioService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      authority: stack.authority,
      policy: stack.policy,
      generate,
    });
    const site = await website.create(stack.actor, { projectId: stack.project.id, name: 'Circus', brief: 'circus' });
    const generated = await website.generate(stack.actor, site.id, 'Build a website about a neighbourhood circus.');
    expect(generated.source).toBe('model');
    expect(generated.html).toMatch(/Model Circus/);
    expect(send).toBe(0);
  });

  it('returns a conversation result, publishes Library HTML, and revises the same site', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const website = new WebsiteStudioService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      authority: stack.authority,
      policy: stack.policy,
    });
    const first = await website.maybeRunFromConversation(stack.actor, {
      conversationId: 'con_site',
      projectId: stack.project.id,
      question: 'Build a website about a neighbourhood circus with tents, tickets, and cocoa.',
    });
    expect(first.handled).toBe(true);
    expect(first.text).toMatch(/^Website:/);
    expect(first.text).toMatch(/circus/i);
    const siteId = first.text?.match(/^Site:\s+(site_\S+)/m)?.[1];
    expect(siteId).toBeTruthy();
    const files = await stack.files.list(stack.actor, stack.project.id);
    const published = files.find((file) => file.path === `sites/${siteId}/index.html`);
    expect(published).toBeTruthy();
    expect(await stack.files.originFor(stack.actor, published!)).toBe('generated');

    const revised = await website.maybeRunFromConversation(stack.actor, {
      conversationId: 'con_site',
      projectId: stack.project.id,
      question: 'Make the hero shorter.',
    });
    expect(revised.handled).toBe(true);
    expect(revised.text).toMatch(/Revision: 2/);
    expect(revised.text).toContain(siteId);

    const other = await website.create(stack.actor, { projectId: stack.project.id, name: 'Other', brief: 'bakery' });
    await website.generate(stack.actor, other.id, 'A bakery site.', { conversationId: 'con_other' });
    const regenerated = await website.maybeRunFromConversation(stack.actor, {
      conversationId: 'con_site',
      projectId: stack.project.id,
      question: 'Regenerate the site',
    });
    expect(regenerated.text).toContain(siteId);
    expect(regenerated.text).not.toContain(other.id);
    const circus = await website.get(stack.actor, siteId!);
    expect(circus.currentRevisionId).toBeTruthy();
    const preview = await website.preview(stack.actor, siteId!);
    expect(preview.revision?.version).toBeGreaterThanOrEqual(2);
  });

  it('cancels before commit and does not fabricate success', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const controller = new AbortController();
    const generate: SiteGeneratePort = {
      async generateHtml(input) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 30_000);
          input.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            const error = new Error('aborted') as Error & { code: string };
            error.code = 'aborted';
            reject(error);
          });
        });
        return { html: modelHtml('Should not commit') };
      },
    };
    const website = new WebsiteStudioService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      authority: stack.authority,
      policy: stack.policy,
      generate,
    });
    const pending = website.maybeRunFromConversation(stack.actor, {
      conversationId: 'con_cancel',
      projectId: stack.project.id,
      question: 'Build a website about cancelled fireworks.',
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;
    expect(result.handled).toBe(true);
    expect(result.failed).toBe(true);
    expect(result.text).toMatch(/cancelled/i);
    const sites = await website.list(stack.actor, stack.project.id);
    expect(sites.every((site) => !site.currentRevisionId)).toBe(true);
  });

  it('keeps a committed site when later Library publication fails', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const original = stack.files.publishArtefactFile.bind(stack.files);
    stack.files.publishArtefactFile = async () => {
      throw new Error('library unavailable');
    };
    try {
      const website = new WebsiteStudioService({
        persistence: stack.persistence,
        projects: stack.projects,
        files: stack.files,
        authority: stack.authority,
        policy: stack.policy,
      });
      const site = await website.create(stack.actor, { projectId: stack.project.id, name: 'Keep', brief: 'keep' });
      const generated = await website.generate(stack.actor, site.id, 'A durable keep page with tents and cocoa.');
      expect(generated.libraryOk).toBe(false);
      expect(generated.reportText).toMatch(/preview ready/i);
      const preview = await website.preview(stack.actor, site.id);
      expect(preview.html).toMatch(/keep|tents|cocoa/i);
      expect((await website.get(stack.actor, site.id)).currentRevisionId).toBe(generated.revision.id);
    } finally {
      stack.files.publishArtefactFile = original;
    }
  });

  it('does not assemble a successful site after cancellation or swallow abort as a provider miss', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const generate: SiteGeneratePort = {
      async generateHtml() {
        const error = new Error('aborted') as Error & { code: string };
        error.code = 'aborted';
        throw error;
      },
    };
    const website = new WebsiteStudioService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      authority: stack.authority,
      policy: stack.policy,
      generate,
    });
    const site = await website.create(stack.actor, { projectId: stack.project.id, name: 'Abort', brief: 'abort' });
    await expect(website.generate(stack.actor, site.id, 'Build a website about abort semantics.')).rejects.toMatchObject({
      code: 'aborted',
    });
    expect((await website.get(stack.actor, site.id)).currentRevisionId).toBeNull();
  });

  it('fails closed across tenants and for read-only principals', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    await stack.persistence.ensureTenant({ id: 'tenant_b', name: 'B' });
    await stack.persistence.ensurePrincipal({ id: 'principal_b', displayName: 'B' });
    const other = { tenantId: 'tenant_b', principalId: 'principal_b' };
    stack.authority.grantMembership(other.principalId, other.tenantId);
    stack.authority.grantTo({ principalId: other.principalId, tenantId: other.tenantId, capability: 'artifact.read' });
    stack.authority.grantTo({ principalId: other.principalId, tenantId: other.tenantId, capability: 'artifact.write' });
    const reader = { tenantId: 'tenant_a', principalId: 'principal_reader' };
    stack.authority.grantMembership(reader.principalId, reader.tenantId);
    stack.authority.grantTo({ principalId: reader.principalId, tenantId: reader.tenantId, capability: 'artifact.read' });
    const website = new WebsiteStudioService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      authority: stack.authority,
      policy: stack.policy,
    });
    const site = await website.create(stack.actor, { projectId: stack.project.id, name: 'Private', brief: 'private' });
    await website.generate(stack.actor, site.id, 'A private harbour page.');
    await expect(website.get(other, site.id)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(website.preview(other, site.id)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(website.generate(other, site.id, 'steal')).rejects.toMatchObject({ httpStatus: 404 });
    await expect(website.generate(reader, site.id, 'no write')).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('does not steal manuscript or research publish prompts as website follow-ups', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const website = new WebsiteStudioService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      authority: stack.authority,
      policy: stack.policy,
    });
    const created = await website.maybeRunFromConversation(stack.actor, {
      conversationId: 'con_site',
      projectId: stack.project.id,
      question: 'Build a website about a neighbourhood circus with tents, tickets, and cocoa.',
    });
    expect(created.handled).toBe(true);
    const manuscript = await website.maybeRunFromConversation(stack.actor, {
      conversationId: 'con_site',
      projectId: stack.project.id,
      question: 'Publish my manuscript',
    });
    expect(manuscript.handled).toBe(false);
    const published = await website.maybeRunFromConversation(stack.actor, {
      conversationId: 'con_site',
      projectId: stack.project.id,
      question: 'Publish the site',
    });
    expect(published.handled).toBe(true);
    expect(published.text).toMatch(/Publishing is an owner action/i);
  });
});
