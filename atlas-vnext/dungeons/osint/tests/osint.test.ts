import { afterEach, describe, expect, it } from 'vitest';
import { OsintService } from '../src/index.ts';
import type { PublicLookupPort } from '../src/collector.ts';
import { closePersistence, openDungeonStack } from '../../../tests/helpers/dungeon-stack.ts';
import type { PlatformPersistence } from '@atlas-vnext/persistence';

const persistences: PlatformPersistence[] = [];

afterEach(async () => {
  while (persistences.length) {
    const item = persistences.pop();
    if (item) await closePersistence(item);
  }
});

function collector(): PublicLookupPort {
  return {
    async lookup() {
      return [
        {
          source: 'dns.a',
          summary: 'example.test resolves to 192.0.2.1',
          confidence: 'confirmed',
          evidence: '{"domain":"example.test","addresses":["192.0.2.1"]}',
        },
      ];
    },
  };
}

describe('OSINT dungeon', () => {
  it('scans through jobs, persists findings and provenance, and synthesises via Nexus', async () => {
    const stack = await openDungeonStack('Dossier: example.test is a documentation domain.');
    persistences.push(stack.persistence);
    const osint = new OsintService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      runtime: stack.runtime,
      authority: stack.authority,
      policy: stack.policy,
      collector: collector(),
    });
    const result = await osint.scan(stack.actor, {
      projectId: stack.project.id,
      kind: 'domain',
      value: 'example.test',
      synthesize: true,
    });
    expect(result.target.dungeon).toBe('osint');
    expect(result.target.status).toBe('completed');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe('finding');
    expect(result.dossier?.kind).toBe('dossier');
    const listed = await osint.listFindings(stack.actor, result.target.id);
    expect(listed).toHaveLength(1);
    const job = await stack.persistence.forActor(stack.actor).jobs.get(stack.actor, result.target.jobId!);
    expect(job?.status).toBe('completed');
    const artefactId = result.findings[0]?.artefactId;
    expect(artefactId).toBeTruthy();
    const provenance = await stack.persistence.forActor(stack.actor).provenance.forArtefact(artefactId!);
    expect(Array.isArray(provenance) ? provenance.length : provenance ? 1 : 0).toBeGreaterThan(0);
  });

  it('does not leak a missing target as another tenant object', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const osint = new OsintService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      runtime: stack.runtime,
      authority: stack.authority,
      policy: stack.policy,
      collector: collector(),
    });
    await expect(osint.get(stack.actor, 'rec_missing')).rejects.toMatchObject({ httpStatus: 404, message: 'Permission denied.' });
  });
});
