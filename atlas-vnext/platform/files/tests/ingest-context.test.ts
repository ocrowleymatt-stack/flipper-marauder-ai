import { describe, expect, it } from 'vitest';
import { openMemoryPersistence, OwnershipError } from '@atlas-vnext/persistence';
import { MemoryCas } from '@atlas-vnext/storage';
import {
  FilesService,
  buildSimplePdf,
  FilesAccessError,
  IngestionError,
  PathSafetyError,
  UnsupportedMediaError,
} from '@atlas-vnext/files';
import { ContextService } from '@atlas-vnext/context';
import { ProjectService } from '@atlas-vnext/projects';
import { logPlatform } from '@atlas-vnext/observability';

async function drain(files: FilesService, actor: { tenantId: string }, worker = 'worker-1') {
  for (let i = 0; i < 16; i += 1) {
    const processed = await files.processNextJob(actor, worker);
    if (!processed) break;
  }
}

describe('files ingest, retrieval, context, artefacts', () => {
  it('ingests sources, extracts via jobs, assembles budgeted context with citations, and isolates tenants', async () => {
    const persistence = openMemoryPersistence();
    const cas = new MemoryCas();
    const files = new FilesService(persistence, cas);
    const projects = new ProjectService(persistence);
    const context = new ContextService(persistence);
    const a = { tenantId: 'tenant_a' };
    const b = { tenantId: 'tenant_b' };
    await persistence.ensureTenant({ id: 'tenant_a', name: 'A' });
    await persistence.ensureTenant({ id: 'tenant_b', name: 'B' });
    const project = await projects.create(a, { name: 'Workspace One', dungeon: 'research' });
    const other = await projects.create(b, { name: 'Secret', dungeon: 'osint' });

    const notes = await files.ingest(a, {
      projectId: project.id,
      path: 'sources/brief.md',
      bytes: new TextEncoder().encode('# Brief\n\nThe copper kettle was observed at dawn near the quay.'),
    });
    await files.ingest(a, {
      projectId: project.id,
      path: 'sources/meta.json',
      bytes: new TextEncoder().encode(JSON.stringify({ vessel: 'Marauder', berth: 'east-quay' })),
    });
    await files.ingest(a, {
      projectId: project.id,
      path: 'sources/memo.pdf',
      bytes: buildSimplePdf(['Harbour watch logged a copper kettle on the east quay.']),
    });
    await drain(files, a);

    await expect(
      files.ingest(a, { projectId: project.id, path: '../escape.md', bytes: new TextEncoder().encode('nope') }),
    ).rejects.toBeInstanceOf(PathSafetyError);
    await expect(
      files.ingest(a, {
        projectId: project.id,
        path: 'evil.js',
        bytes: new TextEncoder().encode('alert(1)'),
        declaredMime: 'application/javascript',
      }),
    ).rejects.toBeInstanceOf(UnsupportedMediaError);

    expect(await files.readByHash(b, notes.contentHash).catch((err) => err)).toBeInstanceOf(FilesAccessError);
    expect(await persistence.forActor(b).files.get(b, notes.id)).toBeNull();

    const secret = await files.ingest(b, {
      projectId: other.id,
      path: 'hidden.txt',
      bytes: new TextEncoder().encode('tenant B only: classified lighthouse code'),
    });
    await drain(files, b);
    await expect(files.readBytes(a, secret.id)).rejects.toBeInstanceOf(FilesAccessError);

    const bound = persistence.forActor(a);
    const conversation = await bound.conversations.create({ title: 'Review', projectId: project.id });
    const attachment = await files.attachToConversation(a, { conversationId: conversation.id, fileId: notes.id });
    const assembled = await context.assemble(a, {
      projectId: project.id,
      query: 'copper kettle quay',
      tokenBudget: 80,
      conversationId: conversation.id,
    });
    expect(assembled.slices.length).toBeGreaterThan(0);
    expect(assembled.slices[0]?.source).toBe('attachment');
    expect(assembled.tokenCount).toBeLessThanOrEqual(assembled.tokenBudget);
    expect(assembled.citations.every((citation) => citation.confidence === 'sourced')).toBe(true);
    const unknown = context.cite('the minister secretly approved a nuclear option', assembled.slices);
    expect(unknown.confidence).toBe('unknown');
    expect(unknown.fileId).toBeNull();
    const sourced = context.cite('copper kettle', assembled.slices);
    expect(sourced.confidence).toBe('sourced');
    expect(sourced.path).toBe('sources/brief.md');

    const tiny = await context.assemble(a, { projectId: project.id, query: 'quay', tokenBudget: 12 });
    expect(tiny.truncated).toBe(true);

    const detached = await files.detachFromConversation(a, attachment.id);
    expect(detached.detachedAt).toBeTruthy();
    expect(await bound.files.get(a, notes.id)).toBeTruthy();
    expect(new TextDecoder().decode(await files.readBytes(a, notes.id))).toContain('copper kettle');

    const artefact = await files.createTextArtefact(a, {
      projectId: project.id,
      text: 'Version one of the quay synthesis.',
      type: 'note',
    });
    const v2 = await files.versionTextArtefact(a, artefact.id, {
      text: 'Version two of the quay synthesis.',
      expectedVersion: 1,
    });
    expect(v2.version).toBe(2);
    expect(v2.parentId).toBe(artefact.id);
    expect(await files.readArtefactText(a, v2.id)).toContain('Version two');
    expect(await persistence.artefacts.get(b, artefact.id)).toBeNull();

    const hits = await context.search(a, project.id, 'Marauder');
    expect(hits.some((hit) => hit.text.includes('Marauder'))).toBe(true);
    await expect(context.search(b, project.id, 'Marauder')).rejects.toBeInstanceOf(OwnershipError);

    const same = await files.ingest(a, {
      projectId: project.id,
      path: 'sources/brief-copy.md',
      bytes: new TextEncoder().encode('# Brief\n\nThe copper kettle was observed at dawn near the quay.'),
    });
    await drain(files, a);
    expect(same.contentHash).toBe(notes.contentHash);
    const deleted = await files.logicalDelete(a, same.id);
    expect(deleted.deletedAt).toBeTruthy();
    expect(await cas.has(notes.contentHash)).toBe(true);

    const lines: string[] = [];
    logPlatform('files.ingest.committed', { content: 'should not appear', fileId: notes.id }, 'info', (line) =>
      lines.push(line),
    );
    expect(lines[0]).not.toContain('should not appear');
    expect(lines[0]).toContain(notes.id);
  });

  it('reserves acquisition/ from ordinary ingest and never updates an accepted original', async () => {
    const persistence = openMemoryPersistence();
    const cas = new MemoryCas();
    const files = new FilesService(persistence, cas);
    const projects = new ProjectService(persistence);
    const actor = { tenantId: 'tenant_a' };
    await persistence.ensureTenant({ id: 'tenant_a', name: 'A' });
    const project = await projects.create(actor, { name: 'Reserved', dungeon: 'research' });
    const original = new TextEncoder().encode('harbour original');
    const overwrite = new TextEncoder().encode('tampered original');
    const path = 'acquisition/acq_reserved/originals/watch.txt';

    await expect(
      files.ingest(actor, { projectId: project.id, path, bytes: original }),
    ).rejects.toBeInstanceOf(IngestionError);
    await expect(
      files.ingestRawOriginal(actor, { projectId: project.id, path, bytes: original }),
    ).rejects.toBeInstanceOf(IngestionError);

    const stored = await files.ingestAcquisitionOriginal(
      actor,
      { projectId: project.id, path, bytes: original },
      true,
    );
    expect(stored.contentHash).toHaveLength(64);
    await expect(
      files.ingest(actor, { projectId: project.id, path, bytes: overwrite }),
    ).rejects.toBeInstanceOf(IngestionError);
    await expect(
      files.ingestAcquisitionOriginal(actor, { projectId: project.id, path, bytes: overwrite }, true),
    ).rejects.toMatchObject({ name: 'IngestionError', message: /append-only/ });
    await expect(
      files.ingestAcquisitionOriginal(
        actor,
        { projectId: project.id, path: 'notes/not-reserved.txt', bytes: original },
        true,
      ),
    ).rejects.toMatchObject({ name: 'IngestionError', message: /acquisition\// });

    const listed = await files.list(actor, project.id);
    expect(listed.find((file) => file.path === path)?.contentHash).toBe(stored.contentHash);
    expect(new TextDecoder().decode(await files.readBytes(actor, stored.id))).toBe('harbour original');
    await expect(files.logicalDelete(actor, stored.id)).rejects.toMatchObject({
      name: 'IngestionError',
      message: /append-only/,
    });
    await files.gcUnreferenced();
    expect(new TextDecoder().decode(await files.readBytes(actor, stored.id))).toBe('harbour original');
    await persistence.close();
  });

  it('exposes ingest origin from provenance, not from the file path', async () => {
    const persistence = openMemoryPersistence();
    const cas = new MemoryCas();
    const files = new FilesService(persistence, cas);
    const projects = new ProjectService(persistence);
    const actor = { tenantId: 'tenant_a' };
    await persistence.ensureTenant({ id: 'tenant_a', name: 'A' });
    const project = await projects.create(actor, { name: 'Library', dungeon: 'research' });
    const uploaded = await files.ingest(actor, {
      projectId: project.id,
      path: 'research/notes.md',
      bytes: new TextEncoder().encode('Path looks generated. Provenance says ingest.'),
    });
    expect(await files.originFor(actor, uploaded)).toBe('uploaded');
    await persistence.close();
  });
});
