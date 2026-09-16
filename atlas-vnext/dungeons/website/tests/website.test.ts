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
