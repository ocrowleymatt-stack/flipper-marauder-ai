import { afterEach, describe, expect, it } from 'vitest';
import { WebsiteStudioService } from '../src/index.ts';
import { closePersistence, openDungeonStack } from '../../../tests/helpers/dungeon-stack.ts';
import type { PlatformPersistence } from '@atlas-vnext/persistence';

const persistences: PlatformPersistence[] = [];

afterEach(async () => {
  while (persistences.length) {
    const item = persistences.pop();
    if (item) await closePersistence(item);
  }
});

describe('Website Studio dungeon', () => {
  it('generates a CAS-backed preview and requires Authority plus effective policy for promote', async () => {
    const stack = await openDungeonStack('<!doctype html><html lang="en"><title>Studio</title><p>Hello</p></html>');
    persistences.push(stack.persistence);
    const website = new WebsiteStudioService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      runtime: stack.runtime,
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
      runtime: stack.runtime,
      authority: stack.authority,
      policy: stack.policy,
    });
    const site = await website.create(stack.actor, { projectId: stack.project.id, name: 'Locked', brief: 'x' });
    await expect(website.generate(stack.actor, site.id, 'x')).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('assembles a real preview when the model is content-filtered', async () => {
    const stack = await openDungeonStack('<p>x</p>');
    persistences.push(stack.persistence);
    const website = new WebsiteStudioService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      runtime: stack.runtime,
      authority: stack.authority,
      policy: stack.policy,
      generate: {
        async generateHtml() {
          const err = new Error('The response was filtered by the content filter.') as Error & { code: string };
          err.code = 'content_filter';
          throw err;
        },
      },
    });
    const site = await website.create(stack.actor, {
      projectId: stack.project.id,
      name: 'Circus',
      brief: 'Build a website about a neighbourhood circus',
    });
    const generated = await website.generate(stack.actor, site.id, 'Build a website about a neighbourhood circus');
    expect(generated.source).toBe('assembler');
    expect(generated.audit.ok).toBe(true);
    expect(generated.html).toMatch(/neighbourhood circus/i);
    expect(generated.html).not.toMatch(/<script/i);
    expect(generated.reportText).toMatch(/declined this brief|assembled a first draft/i);
    const preview = await website.preview(stack.actor, site.id);
    expect(preview.html).toMatch(/<!doctype html>/i);
  });

  it('uses model HTML when it passes audit', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const html =
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Lantern Fair</title></head><body><h1>Lantern Fair</h1><p>A quiet evening market of paper lights and cocoa.</p></body></html>';
    const website = new WebsiteStudioService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      runtime: stack.runtime,
      authority: stack.authority,
      policy: stack.policy,
      generate: { async generateHtml() { return { html }; } },
    });
    const site = await website.create(stack.actor, { projectId: stack.project.id, name: 'Fair', brief: 'lantern fair' });
    const generated = await website.generate(stack.actor, site.id, 'Build a website about a lantern fair');
    expect(generated.source).toBe('model');
    expect(generated.html).toMatch(/Lantern Fair/);
  });

  it('handles conversation website requests and preview follow-ups', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const website = new WebsiteStudioService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      runtime: stack.runtime,
      authority: stack.authority,
      policy: stack.policy,
    });
    const conversation = await stack.runtime.createConversation({ title: 'Chat', projectId: stack.project.id });
    const run = await website.maybeRunFromConversation(stack.actor, {
      conversationId: conversation.id,
      projectId: stack.project.id,
      question: 'Build a website about a neighbourhood circus with tents and tickets',
    });
    expect(run.handled).toBe(true);
    expect(run.text).toMatch(/circus/i);
    const follow = await website.maybeRunFromConversation(stack.actor, {
      conversationId: conversation.id,
      projectId: stack.project.id,
      question: 'Show the preview',
    });
    expect(follow.handled).toBe(true);
    expect(follow.text).toMatch(/preview is ready/i);
  });

  it('does not treat ordinary research questions as website work', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const website = new WebsiteStudioService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      runtime: stack.runtime,
      authority: stack.authority,
      policy: stack.policy,
    });
    const skipped = await website.maybeRunFromConversation(stack.actor, {
      conversationId: 'con_x',
      projectId: stack.project.id,
      question: 'Research the history of the World Wide Web using multiple independent sources.',
    });
    expect(skipped.handled).toBe(false);
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
      runtime: stack.runtime,
      authority: stack.authority,
      policy: stack.policy,
    });
    const site = await website.create(stack.actor, { projectId: stack.project.id, name: 'Locked', brief: 'x' });
    await website.generate(stack.actor, site.id, 'x');
    await expect(website.promote(stranger, site.id)).rejects.toMatchObject({ httpStatus: 404 });
  });
});
