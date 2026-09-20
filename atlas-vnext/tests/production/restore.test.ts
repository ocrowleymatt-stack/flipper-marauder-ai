import { mkdtempSync } from 'node:fs';
import { cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilesService } from '@atlas-vnext/files';
import { openFilesystemCas } from '@atlas-vnext/storage';
import { AuthorityEngine } from '@atlas-vnext/permissions';
import { PLATFORM_TOOL_CATALOGUE, ToolEngine, ToolRegistry } from '@atlas-vnext/tools';
import { openTestKernel, postgresUrl } from '../../platform/persistence/tests/postgres/harness.ts';

const hasPostgres = Boolean(process.env.ATLAS_DATABASE_URL || process.env.DATABASE_URL || postgresUrl());
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe.skipIf(!hasPostgres)('backup restore drill', () => {
  it('restores project, file, provenance, conversation, tool approval, and document after reopen + CAS copy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-restore-'));
    const casRoot = join(dir, 'cas');
    const first = await openTestKernel();
    cleanups.push(first.close);
    await first.kernel.ensureTenant({ id: 'tenant_a', name: 'A' });
    await first.kernel.ensurePrincipal({ id: 'principal_a' });
    const actor = { tenantId: 'tenant_a', principalId: 'principal_a' };
    const project = await first.kernel.ensureWorkspace(actor, { name: 'Restore', dungeon: 'writing' });
    const cas = await openFilesystemCas(casRoot);
    const files = new FilesService(first.kernel, cas);
    const file = await files.ingest(actor, {
      projectId: project.id,
      path: 'source.md',
      bytes: new TextEncoder().encode('restore-me'),
    });
    expect(file.artefactId).toBeTruthy();
    const artefactId = file.artefactId as string;
    const bound = first.kernel.forActor(actor);
    const conversation = await bound.conversations.create({ title: 'Run', projectId: project.id });
    await bound.provenance.record({
      artefactId,
      projectId: project.id,
      sourceInputs: [file.id],
      inputManifestHash: null,
      provider: 'openai',
      model: 'gpt-4o',
      toolCalls: [],
      jobId: null,
      timestamp: new Date().toISOString(),
      traceId: 'trc_restore',
    });
    const document = await bound.documents.create(actor, { workspaceId: project.id, title: 'Chapter' });
    await bound.documents.addVersion(actor, document.id, {
      contentHash: file.contentHash,
      artefactId,
      title: 'Chapter',
      operation: 'create',
      expectedRevision: document.revision,
    });
    const registry = new ToolRegistry();
    for (const def of PLATFORM_TOOL_CATALOGUE) registry.register(def);
    const authority = new AuthorityEngine();
    authority.grantMembership(actor.principalId, actor.tenantId);
    authority.grantTo({ principalId: actor.principalId, tenantId: actor.tenantId, capability: 'filesystem.write' });
    authority.grantTo({ principalId: actor.principalId, tenantId: actor.tenantId, capability: 'file.write' });
    authority.grantTo({ principalId: actor.principalId, tenantId: actor.tenantId, capability: 'tool.invoke.external_write' });
    const engine = new ToolEngine({
      registry,
      invocations: bound.toolInvocations,
      approvals: bound.toolApprovals,
      authority,
    });
    const pending = await engine.invoke(actor, { toolId: 'fs.write', arguments: { path: 'x.txt', content: 'hi' } });
    expect(pending.invocation.status).toBe('awaiting_approval');

    const replica = join(dir, 'cas-replica');
    cpSync(casRoot, replica, { recursive: true });
    await first.kernel.close();

    const second = await openTestKernel(first.schema);
    cleanups.push(async () => {
      await second.kernel.close();
    });
    const restoredCas = await openFilesystemCas(replica);
    const restoredFiles = new FilesService(second.kernel, restoredCas);
    const rebound = second.kernel.forActor(actor);
    expect((await rebound.workspaces.get(actor, project.id))?.name).toBe('Restore');
    expect(new TextDecoder().decode(await restoredFiles.readBytes(actor, file.id))).toBe('restore-me');
    expect((await rebound.conversations.get(conversation.id))?.title).toBe('Run');
    expect((await rebound.provenance.forArtefact(artefactId)).length).toBeGreaterThan(0);
    expect((await rebound.documents.get(actor, document.id))?.currentVersion).toBe(1);
    expect((await rebound.toolInvocations.get(actor.tenantId, pending.invocation.id))?.status).toBe('awaiting_approval');
    expect((await rebound.toolApprovals.getByInvocation(actor.tenantId, pending.invocation.id))?.decision).toBe('pending');
  });

  it('restores dungeon_records and generated WAV artefacts after CAS copy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-restore-music-'));
    const casRoot = join(dir, 'cas');
    const first = await openTestKernel();
    cleanups.push(first.close);
    await first.kernel.ensureTenant({ id: 'tenant_a', name: 'A' });
    await first.kernel.ensurePrincipal({ id: 'principal_a' });
    const actor = { tenantId: 'tenant_a', principalId: 'principal_a' };
    const project = await first.kernel.ensureWorkspace(actor, { name: 'Restore music', dungeon: 'music' });
    const cas = await openFilesystemCas(casRoot);
    const files = new FilesService(first.kernel, cas);
    const wav = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00,
      0x00, 0x01, 0x00, 0x02, 0x00, 0x22, 0x56, 0x00, 0x00, 0x88, 0x58, 0x01, 0x00, 0x04, 0x00, 0x10, 0x00, 0x64, 0x61,
      0x74, 0x61, 0x00, 0x00, 0x00, 0x00,
    ]);
    const artefact = await files.createBinaryArtefact(actor, {
      projectId: project.id,
      bytes: wav,
      mimeType: 'audio/wav',
      type: 'audition',
    });
    const record = await first.kernel.forActor(actor).dungeonRecords.create(actor, {
      id: 'cmp_restore_keep',
      workspaceId: project.id,
      dungeon: 'music',
      kind: 'composition',
      title: 'Restored harbour',
      status: 'completed',
      artefactId: artefact.id,
      contentHash: artefact.contentHash,
      payload: { revision: 1, tempoBpm: 90 },
    });

    const replica = join(dir, 'cas-replica');
    cpSync(casRoot, replica, { recursive: true });
    await first.kernel.close();

    const second = await openTestKernel(first.schema);
    cleanups.push(async () => {
      await second.kernel.close();
    });
    const restoredCas = await openFilesystemCas(replica);
    const restoredFiles = new FilesService(second.kernel, restoredCas);
    const rebound = second.kernel.forActor(actor);
    const restored = await rebound.dungeonRecords.get(actor, record.id);
    expect(restored?.title).toBe('Restored harbour');
    expect(restored?.artefactId).toBe(artefact.id);
    const bytes = await restoredFiles.readArtefactBytes(actor, artefact.id);
    expect(Buffer.from(bytes.subarray(0, 4)).toString('ascii')).toBe('RIFF');
    expect(Buffer.from(bytes).equals(Buffer.from(wav))).toBe(true);
  });
});
