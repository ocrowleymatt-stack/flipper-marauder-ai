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
  it('generates a CAS-backed preview and requires Authority for promote', async () => {
    const stack = await openDungeonStack('<!doctype html><html lang="en"><title>Studio</title><p>Hello</p></html>');
    persistences.push(stack.persistence);
    const website = new WebsiteStudioService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      runtime: stack.runtime,
      authority: stack.authority,
    });
    const site = await website.create(stack.actor, { projectId: stack.project.id, name: 'Studio', brief: 'Hello site' });
    const generated = await website.generate(stack.actor, site.id, 'A small accessible studio page.');
    expect(generated.revision.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    const preview = await website.preview(stack.actor, site.id);
    expect(preview.html.length).toBeGreaterThan(0);
    const promoted = await website.promote(stack.actor, site.id);
    expect(promoted.revision.retentionClass).toBe('published');
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
    });
    const site = await website.create(stack.actor, { projectId: stack.project.id, name: 'Locked', brief: 'x' });
    await website.generate(stack.actor, site.id, 'x');
    await expect(website.promote(stranger, site.id)).rejects.toMatchObject({ httpStatus: 404 });
  });
});
