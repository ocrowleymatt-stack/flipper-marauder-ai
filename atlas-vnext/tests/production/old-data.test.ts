import { afterEach, describe, expect, it } from 'vitest';
import { FilesService } from '@atlas-vnext/files';
import { openFilesystemCas } from '@atlas-vnext/storage';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURRENT_SCHEMA_VERSION } from '../../platform/persistence/src/postgres/migrate.ts';
import { openTestKernel, postgresUrl } from '../../platform/persistence/tests/postgres/harness.ts';

const hasPostgres = Boolean(process.env.ATLAS_DATABASE_URL || process.env.DATABASE_URL || postgresUrl());
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

/**
 * Public production is frozen at 68603a4, which already ships schema v9.
 * Waves 1–6 added no SQL. Freeze-era rows must remain readable and
 * Wave 6 binary artefacts must attach without rewriting those rows.
 */
describe.skipIf(!hasPostgres)('old-data compatibility with freeze schema v9', () => {
  it('reads freeze-era project, file, conversation, document rows after current reopen', async () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(9);
    const dir = mkdtempSync(join(tmpdir(), 'atlas-old-data-'));
    const first = await openTestKernel();
    cleanups.push(first.close);
    await first.kernel.ensureTenant({ id: 'tenant_a', name: 'A' });
    await first.kernel.ensurePrincipal({ id: 'principal_a' });
    const actor = { tenantId: 'tenant_a', principalId: 'principal_a' };
    const project = await first.kernel.ensureWorkspace(actor, { name: 'Freeze harbour', dungeon: 'writing' });
    const cas = await openFilesystemCas(join(dir, 'cas'));
    const files = new FilesService(first.kernel, cas);
    const file = await files.ingest(actor, {
      projectId: project.id,
      path: 'notes.md',
      bytes: new TextEncoder().encode('freeze-era note'),
    });
    const bound = first.kernel.forActor(actor);
    const conversation = await bound.conversations.create({ title: 'Freeze thread', projectId: project.id });
    const document = await bound.documents.create(actor, { workspaceId: project.id, title: 'Freeze chapter' });
    const versions = await first.kernel.tx.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM schema_migrations');
    expect(versions.rows[0]?.n).toBe(9);

    const schema = first.schema;
    await first.kernel.close();

    const second = await openTestKernel(schema);
    cleanups.push(async () => {
      await second.kernel.close();
    });
    const restoredCas = await openFilesystemCas(join(dir, 'cas'));
    const restoredFiles = new FilesService(second.kernel, restoredCas);
    const rebound = second.kernel.forActor(actor);
    expect((await rebound.workspaces.get(actor, project.id))?.name).toBe('Freeze harbour');
    expect(new TextDecoder().decode(await restoredFiles.readBytes(actor, file.id))).toBe('freeze-era note');
    expect((await rebound.conversations.get(conversation.id))?.title).toBe('Freeze thread');
    expect((await rebound.documents.get(actor, document.id))?.title).toBe('Freeze chapter');
    const again = await second.kernel.tx.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM schema_migrations');
    expect(again.rows[0]?.n).toBe(9);
  });
});
