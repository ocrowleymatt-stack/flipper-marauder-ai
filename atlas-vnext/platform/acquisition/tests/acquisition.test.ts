import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXTRACTOR_ID, EXTRACTOR_VERSION, FilesService } from '@atlas-vnext/files';
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
    const source = listed.find((file) => file.path === `acquisition/${begun.id}/meta.json`);
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
    const acceptedOriginal = before.find((file) => file.path === `acquisition/${accepted.id}/watch.txt`);
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
    expect(afterFail.find((file) => file.path === `acquisition/${accepted.id}/watch.txt`)?.contentHash).toBe(
      acceptedOriginalHash,
    );
    expect(afterFail.some((file) => file.path === `acquisition/${failed.id}/keep.txt`)).toBe(true);
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
  });
});
