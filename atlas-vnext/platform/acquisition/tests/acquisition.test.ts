import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXTRACTOR_ID, EXTRACTOR_VERSION, FilesService, IngestionError } from '@atlas-vnext/files';
import { openMemoryPersistence } from '@atlas-vnext/persistence';
import { AuthorityEngine } from '@atlas-vnext/permissions';
import { ProjectService } from '@atlas-vnext/projects';
import { openFilesystemCas, sha256Hex } from '@atlas-vnext/storage';
import {
  AcquisitionService,
  ArchiveAdapter,
  DirectoryAdapter,
  DeviceControlNotImplementedError,
  GENERIC_DENY,
  MessageExportAdapter,
  UnimplementedDeviceControl,
  deviceControl,
  hashAcquisitionOriginals,
} from '@atlas-vnext/acquisition';

async function openAcquisitionStack() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-acquisition-'));
  const persistence = await openMemoryPersistence();
  await persistence.ensureTenant({ id: 'tenant_a', name: 'A' });
  await persistence.ensurePrincipal({ id: 'principal_a', displayName: 'A' });
  await persistence.ensurePrincipal({ id: 'principal_denied', displayName: 'Denied' });
  const actor = { tenantId: 'tenant_a', principalId: 'principal_a' };
  const denied = { tenantId: 'tenant_a', principalId: 'principal_denied' };
  const cas = await openFilesystemCas(join(dir, 'cas'));
  const files = new FilesService(persistence, cas);
  const projects = new ProjectService(persistence);
  const authority = new AuthorityEngine();
  authority.grantMembership(actor.principalId, actor.tenantId);
  authority.grantMembership(denied.principalId, denied.tenantId);
  for (const cap of ['file.read', 'file.write', 'project.read', 'artifact.read'] as const) {
    authority.grantTo({ principalId: actor.principalId, tenantId: actor.tenantId, capability: cap });
  }
  authority.grantTo({ principalId: denied.principalId, tenantId: denied.tenantId, capability: 'file.read' });
  authority.grantTo({ principalId: denied.principalId, tenantId: denied.tenantId, capability: 'project.read' });
  const project = await projects.create(actor, { name: 'Acquisition Lab' });
  const acquisition = new AcquisitionService({ persistence, files, projects, authority });
  return { dir, persistence, files, projects, authority, actor, denied, project, acquisition, cas };
}

describe('local data acquisition substrate', () => {
  it('hashes originals, keeps manifest hashes stable, and dedupes identical CAS bytes', async () => {
    const stack = await openAcquisitionStack();
    const notes = new TextEncoder().encode('# Brief\n\nThe copper kettle was observed at dawn.');
    const copy = new TextEncoder().encode('# Brief\n\nThe copper kettle was observed at dawn.');
    const prepared = new DirectoryAdapter().prepare({
      title: 'Notes folder',
      acquiredFrom: 'caller-supplied tree',
      entries: [
        { path: 'notes/brief.md', bytes: notes },
        { path: 'notes/brief-copy.md', bytes: copy },
      ],
    });

    const first = await stack.acquisition.begin(stack.actor, {
      projectId: stack.project.id,
      sourceKind: prepared.plan.sourceKind,
      title: prepared.plan.title,
      acquiredFrom: prepared.plan.acquiredFrom,
      items: prepared.items,
    });

    expect(first.status).toBe('accepted');
    expect(first.failure).toBeNull();
    expect(first.generation).toBe(1);
    expect(first.entries).toHaveLength(2);
    expect(first.entries[0]?.sha256).toBe(sha256Hex(notes));
    expect(first.entries[1]?.sha256).toBe(sha256Hex(copy));
    expect(first.entries[0]?.sha256).toBe(first.entries[1]?.sha256);
    expect(first.originalCasHash).toBe(hashAcquisitionOriginals(first.entries));
    expect(hashAcquisitionOriginals(first.entries)).toBe(first.originalCasHash);

    const listed = await stack.files.list(stack.actor, stack.project.id);
    const originalA = listed.find((file) => file.path.endsWith('notes/brief.md'));
    const originalB = listed.find((file) => file.path.endsWith('notes/brief-copy.md'));
    const manifestFile = listed.find((file) => file.path === `acquisition/${first.id}/manifest.json`);
    expect(originalA?.contentHash).toBe(originalB?.contentHash);
    expect(manifestFile?.contentHash).toHaveLength(64);
    expect(manifestFile?.contentHash).not.toBe(originalA?.contentHash);

    const second = await stack.acquisition.begin(stack.actor, {
      projectId: stack.project.id,
      sourceKind: 'directory',
      title: 'Notes folder again',
      acquiredFrom: 'caller-supplied tree',
      items: prepared.items,
    });
    expect(second.id).not.toBe(first.id);
    expect(second.originalCasHash).toBe(first.originalCasHash);
    expect(second.status).toBe('accepted');

    const after = await stack.files.list(stack.actor, stack.project.id);
    const firstManifest = after.find((file) => file.path === `acquisition/${first.id}/manifest.json`);
    expect(firstManifest?.contentHash).toBe(manifestFile?.contentHash);
    const reloaded = await stack.acquisition.get(stack.actor, first.id);
    expect(reloaded.status).toBe('accepted');
    expect(reloaded.entries).toEqual(first.entries);
    expect(new TextDecoder().decode(await stack.files.readBytes(stack.actor, firstManifest!.id))).toContain(first.id);

    await stack.persistence.close();
  });

  it('stores transformed derived text with a hash distinct from the original', async () => {
    const stack = await openAcquisitionStack();
    const original = new TextEncoder().encode(JSON.stringify({ vessel: 'Marauder', berth: 'east-quay' }));
    const begun = await stack.acquisition.begin(stack.actor, {
      projectId: stack.project.id,
      sourceKind: 'documents',
      title: 'Harbour meta',
      acquiredFrom: 'caller',
      items: [{ path: 'meta.json', bytes: original, mime: 'application/json' }],
    });
    expect(begun.status).toBe('accepted');
    const originalHash = begun.entries[0]?.sha256;
    expect(originalHash).toBe(sha256Hex(original));

    const processed = await stack.acquisition.processNext(stack.actor, 'acq-worker');
    expect(processed).toBeTruthy();

    const listed = await stack.files.list(stack.actor, stack.project.id);
    const source = listed.find((file) => file.path === `acquisition/${begun.id}/originals/meta.json`);
    expect(source).toBeTruthy();
    await stack.acquisition.extract(stack.actor, source!.id);
    const extraction = await stack.persistence
      .forActor(stack.actor)
      .extractions.getByHash(stack.actor, source!.contentHash, EXTRACTOR_ID, EXTRACTOR_VERSION);
    expect(extraction?.status).toBe('succeeded');
    expect(extraction?.textHash).toBeTruthy();
    expect(extraction?.textHash).not.toBe(originalHash);

    const derived = await stack.files.createTextArtefact(stack.actor, {
      projectId: stack.project.id,
      text: 'MARAUDER at EAST-QUAY',
      type: 'extraction-note',
    });
    expect(derived.contentHash).not.toBe(originalHash);

    const provenance = await stack.persistence.forActor(stack.actor).provenance.forArtefact(source!.artefactId ?? '');
    const manifestListed = listed.find((file) => file.path === `acquisition/${begun.id}/manifest.json`);
    const manifestProv = await stack.persistence
      .forActor(stack.actor)
      .provenance.forArtefact(manifestListed!.artefactId ?? manifestListed!.id);
    expect(manifestProv.some((row) => row.provider === 'atlas.acquisition' && row.model === 'deterministic')).toBe(
      true,
    );
    expect(manifestProv.some((row) => row.capability === 'acquisition')).toBe(true);
    expect(provenance.every((row) => row.model !== 'llm')).toBe(true);

    await stack.persistence.close();
  });

  it('does not flip an accepted acquisition when a later begin fails, and does not mutate the first manifest', async () => {
    const stack = await openAcquisitionStack();
    const payload = new TextEncoder().encode('authorised notes from the quay watch');
    const accepted = await stack.acquisition.begin(stack.actor, {
      projectId: stack.project.id,
      sourceKind: 'documents',
      title: 'Accepted pack',
      acquiredFrom: 'caller',
      items: [{ path: 'watch.txt', bytes: payload }],
    });
    expect(accepted.status).toBe('accepted');
    const before = await stack.files.list(stack.actor, stack.project.id);
    const acceptedManifest = before.find((file) => file.path === `acquisition/${accepted.id}/manifest.json`);
    const acceptedOriginal = before.find((file) => file.path === `acquisition/${accepted.id}/originals/watch.txt`);
    const acceptedManifestHash = acceptedManifest!.contentHash;
    const acceptedOriginalHash = acceptedOriginal!.contentHash;

    const failed = await stack.acquisition.begin(stack.actor, {
      projectId: stack.project.id,
      sourceKind: 'other',
      title: 'Partial pack',
      acquiredFrom: 'caller',
      items: [
        { path: 'keep.txt', bytes: payload },
        {
          path: 'evil.js',
          bytes: new TextEncoder().encode('alert(1)'),
          mime: 'application/javascript',
        },
      ],
    });
    expect(failed.status).toBe('failed');
    expect(failed.id).not.toBe(accepted.id);
    expect(failed.failure?.code).toBeTruthy();

    const still = await stack.acquisition.get(stack.actor, accepted.id);
    expect(still.status).toBe('accepted');
    expect(still.originalCasHash).toBe(accepted.originalCasHash);
    expect(still.entries).toEqual(accepted.entries);

    const afterFail = await stack.files.list(stack.actor, stack.project.id);
    expect(afterFail.find((file) => file.path === `acquisition/${accepted.id}/manifest.json`)?.contentHash).toBe(
      acceptedManifestHash,
    );
    expect(afterFail.find((file) => file.path === `acquisition/${accepted.id}/originals/watch.txt`)?.contentHash).toBe(
      acceptedOriginalHash,
    );
    expect(afterFail.some((file) => file.path === `acquisition/${failed.id}/originals/keep.txt`)).toBe(true);
    expect(await stack.cas.has(acceptedOriginalHash)).toBe(true);

    const replay = await stack.acquisition.begin(stack.actor, {
      projectId: stack.project.id,
      sourceKind: 'documents',
      title: 'Accepted pack copy',
      acquiredFrom: 'caller',
      items: [{ path: 'watch.txt', bytes: payload }],
    });
    expect(replay.id).not.toBe(accepted.id);
    expect(replay.status).toBe('accepted');
    const afterReplay = await stack.files.list(stack.actor, stack.project.id);
    expect(afterReplay.find((file) => file.path === `acquisition/${accepted.id}/manifest.json`)?.contentHash).toBe(
      acceptedManifestHash,
    );
    const firstBytes = new TextDecoder().decode(await stack.files.readBytes(stack.actor, acceptedManifest!.id));
    expect(JSON.parse(firstBytes).id).toBe(accepted.id);
    expect(JSON.parse(firstBytes).status).toBe('accepted');

    await stack.persistence.close();
  });

  it('denies begin without file.write using a generic 404-style message', async () => {
    const stack = await openAcquisitionStack();
    await expect(
      stack.acquisition.begin(stack.denied, {
        projectId: stack.project.id,
        sourceKind: 'documents',
        title: 'Denied',
        acquiredFrom: 'caller',
        items: [{ path: 'secret.txt', bytes: new TextEncoder().encode('nope') }],
      }),
    ).rejects.toMatchObject({ httpStatus: 404, message: GENERIC_DENY, code: 'permission_denied' });
    await expect(stack.acquisition.get(stack.denied, 'acq_missing')).rejects.toMatchObject({
      httpStatus: 404,
      message: GENERIC_DENY,
    });
    await stack.persistence.close();
  });

  it('refuses DeviceControlPort and does not crawl the host', async () => {
    const stub = new UnimplementedDeviceControl();
    await expect(deviceControl.connect({ locator: 'usb:1' })).rejects.toBeInstanceOf(DeviceControlNotImplementedError);
    await expect(deviceControl.listDevices()).rejects.toBeInstanceOf(DeviceControlNotImplementedError);
    await expect(stub.pullExport({ locator: '/var/lib/phones' })).rejects.toBeInstanceOf(
      DeviceControlNotImplementedError,
    );

    const messages = new MessageExportAdapter().prepare({
      title: 'SMS export',
      acquiredFrom: 'caller-supplied bytes',
      bytes: new TextEncoder().encode(JSON.stringify([{ from: 'A', text: 'quay' }])),
    });
    expect(messages.plan.sourceKind).toBe('messages');
    expect(messages.items[0]?.bytes.byteLength).toBeGreaterThan(0);

    const archive = new ArchiveAdapter().prepare({
      entries: [{ path: 'inbox/note.txt', bytes: new TextEncoder().encode('packed') }],
    });
    expect(archive.plan.sourceKind).toBe('backup');
    expect(archive.plan.items[0]?.path).toBe('inbox/note.txt');

    const zipBlob = new ArchiveAdapter().prepare({
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      filename: 'export.zip',
    });
    expect(zipBlob.items[0]?.mime).toBe('application/zip');
    const opaqueBlob = new ArchiveAdapter().prepare({ bytes: new Uint8Array([1, 2, 3]) });
    expect(opaqueBlob.items[0]?.mime).toBe('application/octet-stream');
  });

  it('reconstructs get() from the stored manifest after process-local state is gone', async () => {
    const stack = await openAcquisitionStack();
    const notes = new TextEncoder().encode('quay watch notes');
    const first = await stack.acquisition.begin(stack.actor, {
      projectId: stack.project.id,
      sourceKind: 'documents',
      title: 'Persisted pack',
      acquiredFrom: 'caller',
      items: [{ path: 'watch.txt', bytes: notes }],
    });
    const restarted = new AcquisitionService({
      persistence: stack.persistence,
      files: stack.files,
      projects: stack.projects,
      authority: stack.authority,
    });
    const loaded = await restarted.get(stack.actor, first.id);
    expect(loaded.status).toBe('accepted');
    expect(loaded.entries).toEqual(first.entries);
    expect(loaded.originalCasHash).toBe(first.originalCasHash);
    await stack.persistence.close();
  });

  it('does not let a caller item named manifest.json overwrite the acquisition manifest', async () => {
    const stack = await openAcquisitionStack();
    const original = new TextEncoder().encode(JSON.stringify({ lookalike: true, body: 'caller original' }));
    const begun = await stack.acquisition.begin(stack.actor, {
      projectId: stack.project.id,
      sourceKind: 'documents',
      title: 'Collision',
      acquiredFrom: 'caller',
      items: [{ path: 'manifest.json', bytes: original }],
    });
    const listed = await stack.files.list(stack.actor, stack.project.id);
    const storedOriginal = listed.find((file) => file.path === `acquisition/${begun.id}/originals/manifest.json`);
    const storedManifest = listed.find((file) => file.path === `acquisition/${begun.id}/manifest.json`);
    expect(storedOriginal?.contentHash).toBe(sha256Hex(original));
    expect(storedManifest?.contentHash).not.toBe(storedOriginal?.contentHash);
    const processed = await stack.acquisition.processNext(stack.actor, 'acq-worker');
    expect(Array.isArray(processed) ? processed[0]?.id : processed?.id).toBe(storedOriginal?.id);
    await stack.persistence.close();
  });

  it('does not claim or fail unrelated queued jobs', async () => {
    const stack = await openAcquisitionStack();
    const foreign = await stack.persistence.forActor(stack.actor).jobs.enqueue(stack.actor, {
      dungeon: 'writing',
      type: 'commission',
      priority: 999,
    });
    await stack.acquisition.begin(stack.actor, {
      projectId: stack.project.id,
      sourceKind: 'documents',
      title: 'Later',
      acquiredFrom: 'caller',
      items: [{ path: 'note.txt', bytes: new TextEncoder().encode('ok') }],
    });
    const processed = await stack.acquisition.processNext(stack.actor, 'acq-worker');
    expect(processed).toBeTruthy();
    const still = await stack.persistence.forActor(stack.actor).jobs.get(stack.actor, foreign.id);
    expect(still?.status).toBe('queued');
    expect(still?.failureReason).toBeNull();
    await stack.persistence.close();
  });

  it('requires file.read before extract', async () => {
    const stack = await openAcquisitionStack();
    await stack.persistence.ensurePrincipal({ id: 'principal_noread', displayName: 'NoRead' });
    const noRead = { tenantId: 'tenant_a', principalId: 'principal_noread' };
    stack.authority.grantMembership(noRead.principalId, noRead.tenantId);
    const begun = await stack.acquisition.begin(stack.actor, {
      projectId: stack.project.id,
      sourceKind: 'documents',
      title: 'Needs read',
      acquiredFrom: 'caller',
      items: [{ path: 'note.txt', bytes: new TextEncoder().encode('secret') }],
    });
    const listed = await stack.files.list(stack.actor, stack.project.id);
    const source = listed.find((file) => file.path === `acquisition/${begun.id}/originals/note.txt`);
    await expect(stack.acquisition.extract(noRead, source!.id)).rejects.toMatchObject({
      httpStatus: 404,
      message: GENERIC_DENY,
    });
    await expect(stack.acquisition.processNext(noRead, 'acq-worker')).rejects.toMatchObject({
      httpStatus: 404,
      message: GENERIC_DENY,
      code: 'permission_denied',
    });
    const processed = await stack.acquisition.processNext(stack.actor, 'acq-worker');
    expect(Array.isArray(processed) ? processed[0]?.id : processed?.id).toBe(source!.id);
    await stack.persistence.close();
  });
  it('rejects normalized duplicate paths before storing originals', async () => {
    const stack = await openAcquisitionStack();
    await expect(stack.acquisition.begin(stack.actor, {
      projectId: stack.project.id, sourceKind: 'documents', title: 'Duplicate', acquiredFrom: 'caller',
      items: [
        { path: 'folder/note.txt', bytes: new TextEncoder().encode('first') },
        { path: 'folder//./note.txt', bytes: new TextEncoder().encode('second') },
      ],
    })).rejects.toMatchObject({ code: 'malformed' });
    expect(await stack.files.list(stack.actor, stack.project.id)).toEqual([]);
    await stack.persistence.close();
  });

  it('reconstructs acquisitions in archived projects after restart', async () => {
    const stack = await openAcquisitionStack();
    const first = await stack.acquisition.begin(stack.actor, {
      projectId: stack.project.id, sourceKind: 'documents', title: 'Archived', acquiredFrom: 'caller',
      items: [{ path: 'note.txt', bytes: new TextEncoder().encode('original') }],
    });
    await stack.projects.archive(stack.actor, stack.project.id);
    expect(await new AcquisitionService(stack).get(stack.actor, first.id)).toEqual(first);
    await stack.persistence.close();
  });

  it.each([
    ['export.zip', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 255]), 'application/zip'],
    ['backup.bin', new Uint8Array([0, 255, 128, 1]), 'application/octet-stream'],
  ])('preserves raw %s and isolates acquisition jobs from the files worker', async (filename, bytes, mime) => {
    const stack = await openAcquisitionStack();
    const prepared = new ArchiveAdapter().prepare({ filename, bytes });
    const begun = await stack.acquisition.begin(stack.actor, {
      projectId: stack.project.id, ...prepared.plan, items: prepared.items,
    });
    expect(begun.status).toBe('accepted');
    const listed = await stack.files.list(stack.actor, stack.project.id);
    const original = listed.find(file => file.path.endsWith(`/originals/${filename}`))!;
    expect(original.mimeType).toBe(mime);
    expect(new Uint8Array(await stack.files.readBytes(stack.actor, original.id))).toEqual(bytes);
    const bound = stack.persistence.forActor(stack.actor);
    const acquisitionJob = await bound.jobs.enqueue(stack.actor, {
      dungeon: 'platform', type: 'acquisition.process',
      idempotencyKey: `acquisition.process:${begun.id}:${begun.originalCasHash}`,
    });
    while (await stack.files.processNextJob(stack.actor, 'files-worker')) { /* drain supported jobs */ }
    expect((await bound.jobs.get(stack.actor, acquisitionJob.id))?.status).toBe('queued');
    expect(await stack.acquisition.processNext(stack.actor, 'acq-worker')).toMatchObject({ id: original.id });
    expect((await bound.jobs.get(stack.actor, acquisitionJob.id))?.status).toBe('completed');
    expect(await bound.extractions.getByHash(stack.actor, original.contentHash, EXTRACTOR_ID, EXTRACTOR_VERSION)).toBeNull();
    await stack.files.gcUnreferenced();
    expect(new Uint8Array(await stack.files.readBytes(stack.actor, original.id))).toEqual(bytes);
    await stack.persistence.close();
  });

  it('refuses ordinary files.ingest into reserved acquisition paths and keeps originals through GC', async () => {
    const stack = await openAcquisitionStack();
    const payload = new TextEncoder().encode('authorised notes from the quay watch');
    const begun = await stack.acquisition.begin(stack.actor, {
      projectId: stack.project.id,
      sourceKind: 'documents',
      title: 'Immutable pack',
      acquiredFrom: 'caller',
      items: [{ path: 'watch.txt', bytes: payload }],
    });
    expect(begun.status).toBe('accepted');
    const originalPath = `acquisition/${begun.id}/originals/watch.txt`;
    const manifestPath = `acquisition/${begun.id}/manifest.json`;
    const listed = await stack.files.list(stack.actor, stack.project.id);
    const original = listed.find((file) => file.path === originalPath)!;
    const manifest = listed.find((file) => file.path === manifestPath)!;
    const overwrite = new TextEncoder().encode('tampered after accept');

    await expect(
      stack.files.ingest(stack.actor, { projectId: stack.project.id, path: originalPath, bytes: overwrite }),
    ).rejects.toBeInstanceOf(IngestionError);
    await expect(
      stack.files.ingest(stack.actor, { projectId: stack.project.id, path: manifestPath, bytes: overwrite }),
    ).rejects.toBeInstanceOf(IngestionError);
    await expect(
      stack.files.ingestRawOriginal(stack.actor, {
        projectId: stack.project.id,
        path: originalPath,
        bytes: overwrite,
      }),
    ).rejects.toBeInstanceOf(IngestionError);

    const after = await stack.files.list(stack.actor, stack.project.id);
    expect(after.find((file) => file.path === originalPath)?.contentHash).toBe(original.contentHash);
    expect(after.find((file) => file.path === manifestPath)?.contentHash).toBe(manifest.contentHash);
    expect(new TextDecoder().decode(await stack.files.readBytes(stack.actor, original.id))).toBe(
      'authorised notes from the quay watch',
    );

    await expect(stack.files.logicalDelete(stack.actor, original.id)).rejects.toBeInstanceOf(IngestionError);
    await expect(stack.files.logicalDelete(stack.actor, manifest.id)).rejects.toBeInstanceOf(IngestionError);
    await stack.files.gcUnreferenced();
    expect(await stack.cas.has(original.contentHash)).toBe(true);
    expect(new TextDecoder().decode(await stack.files.readBytes(stack.actor, original.id))).toBe(
      'authorised notes from the quay watch',
    );
    await stack.persistence.close();
  });

});
