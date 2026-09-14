import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilesystemCas } from '@atlas-vnext/storage';
import { FilesService } from '@atlas-vnext/files';
import { ContextService } from '@atlas-vnext/context';
import { ProjectService } from '@atlas-vnext/projects';
import { openTestKernel, tenantA, tenantB } from '../../persistence/tests/postgres/harness.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function drain(files: FilesService, actor: { tenantId: string }) {
  for (let i = 0; i < 16; i += 1) {
    if (!(await files.processNextJob(actor, `w-${i}`))) break;
  }
}

describe('postgres files restart and isolation', () => {
  it('survives a full process restart against the same PostgreSQL schema and CAS root', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    const casRoot = mkdtempSync(join(tmpdir(), 'atlas-cas-pg-'));
    const cas = new FilesystemCas({ root: casRoot });
    const actor = tenantA;
    await handle.kernel.ensureTenant({ id: actor.tenantId, name: 'A' });
    const projects = new ProjectService(handle.kernel);
    const files = new FilesService(handle.kernel, cas);
    const project = await projects.create(actor, { name: 'Durable workspace', dungeon: 'writing' });
    const bound = handle.kernel.forActor(actor);
    const conversation = await bound.conversations.create({ title: 'Notes', projectId: project.id });
    const file = await files.ingest(actor, {
      projectId: project.id,
      path: 'chapter.md',
      bytes: new TextEncoder().encode('# Chapter\n\nThe lighthouse keeper recorded a copper kettle at dusk.'),
    });
    await drain(files, actor);
    await files.attachToConversation(actor, { conversationId: conversation.id, fileId: file.id });
    await files.createTextArtefact(actor, {
      projectId: project.id,
      id: 'art_keep',
      text: 'Durable artefact body',
    });
    await handle.kernel.close();

    const restarted = await openTestKernel(handle.schema);
    cleanups.push(async () => {
      await restarted.kernel.close();
    });
    const cas2 = new FilesystemCas({ root: casRoot });
    const files2 = new FilesService(restarted.kernel, cas2);
    const projects2 = new ProjectService(restarted.kernel);
    const context2 = new ContextService(restarted.kernel);
    const again = await projects2.get(actor, project.id);
    expect(again?.name).toBe('Durable workspace');
    const bound2 = restarted.kernel.forActor(actor);
    expect(await bound2.conversations.get(conversation.id)).toBeTruthy();
    expect(new TextDecoder().decode(await files2.readBytes(actor, file.id))).toContain('copper kettle');
    expect(await files2.readArtefactText(actor, 'art_keep')).toBe('Durable artefact body');
    const assembled = await context2.assemble(actor, {
      projectId: project.id,
      query: 'lighthouse kettle',
      tokenBudget: 200,
      conversationId: conversation.id,
    });
    expect(assembled.slices.some((slice) => slice.text.includes('copper kettle'))).toBe(true);
    expect(assembled.citations[0]?.confidence).toBe('sourced');
  });

  it('does not grant access by file id or content hash across tenants', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    const cas = new FilesystemCas({ root: mkdtempSync(join(tmpdir(), 'atlas-cas-iso-')) });
    await handle.kernel.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    await handle.kernel.ensureTenant({ id: tenantB.tenantId, name: 'B' });
    const projects = new ProjectService(handle.kernel);
    const files = new FilesService(handle.kernel, cas);
    const projectA = await projects.create(tenantA, { name: 'A' });
    const projectB = await projects.create(tenantB, { name: 'B' });
    const fileA = await files.ingest(tenantA, {
      projectId: projectA.id,
      path: 'a.txt',
      bytes: new TextEncoder().encode('alpha-only payload'),
    });
    await drain(files, tenantA);
    expect(await handle.kernel.forActor(tenantB).files.get(tenantB, fileA.id)).toBeNull();
    await expect(files.readBytes(tenantB, fileA.id)).rejects.toThrow(/not visible|does not grant/i);
    await expect(files.readByHash(tenantB, fileA.contentHash)).rejects.toThrow(/does not grant/i);
    const fileB = await files.ingest(tenantB, {
      projectId: projectB.id,
      path: 'a.txt',
      bytes: new TextEncoder().encode('alpha-only payload'),
    });
    expect(fileB.contentHash).toBe(fileA.contentHash);
    expect(new TextDecoder().decode(await files.readBytes(tenantB, fileB.id))).toBe('alpha-only payload');
  });
});
