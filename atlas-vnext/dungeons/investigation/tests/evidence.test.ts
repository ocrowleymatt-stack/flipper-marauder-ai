import { afterEach, describe, expect, it } from 'vitest';
import {
  EPISTEMIC_CLASSES,
  evidenceObjectSchema,
  factSchema,
  hypothesisSchema,
  inferenceSchema,
  sourceAssertionSchema,
} from '@atlas-vnext/contracts';
import type { PlatformPersistence } from '@atlas-vnext/persistence';
import { closePersistence, openDungeonStack } from '../../../tests/helpers/dungeon-stack.ts';
import {
  EPISTEMIC_BOUNDARY,
  EPISTEMIC_IMMUTABLE,
  EvidenceLedger,
  InvestigationError,
  InvestigationService,
  loadHarbourFixture,
} from '../src/index.ts';

const persistences: PlatformPersistence[] = [];

afterEach(async () => {
  while (persistences.length) {
    const item = persistences.pop();
    if (item) await closePersistence(item);
  }
});

function stackService(stack: Awaited<ReturnType<typeof openDungeonStack>>) {
  const investigation = new InvestigationService({
    persistence: stack.persistence,
    projects: stack.projects,
    files: stack.files,
    runtime: stack.runtime,
    authority: stack.authority,
    policy: stack.policy,
  });
  const ledger = new EvidenceLedger({
    persistence: stack.persistence,
    projects: stack.projects,
    files: stack.files,
    authority: stack.authority,
    policy: stack.policy,
  });
  return { investigation, ledger };
}

describe('Investigation evidential substrate', () => {
  it('keeps fact, assertion, inference, hypothesis, and contradiction as disjoint classes', () => {
    expect([...EPISTEMIC_CLASSES].sort()).toEqual(
      ['contradiction', 'fact', 'hypothesis', 'inference', 'source_assertion'].sort(),
    );
    expect(factSchema.shape.epistemicClass.value).toBe('fact');
    expect(sourceAssertionSchema.shape.epistemicClass.value).toBe('source_assertion');
    expect(inferenceSchema.shape.epistemicClass.value).toBe('inference');
    expect(hypothesisSchema.shape.epistemicClass.value).toBe('hypothesis');
  });

  it('loads the harbour fixture with provenance, duplicates, chronology, corroboration, contradiction, and an unsupported hypothesis', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const { investigation, ledger } = stackService(stack);
    const fixture = await loadHarbourFixture(stack.actor, {
      investigation,
      ledger,
      files: stack.files,
      projectId: stack.project.id,
    });

    const invoice = evidenceObjectSchema.parse(
      (await stack.persistence.forActor(stack.actor).dungeonRecords.get(stack.actor, fixture.objectIds.invoice))
        ?.payload,
    );
    const invoiceCopy = evidenceObjectSchema.parse(
      (await stack.persistence.forActor(stack.actor).dungeonRecords.get(stack.actor, fixture.objectIds.invoiceCopy))
        ?.payload,
    );
    expect(invoice.originalCasHash).toBe(invoiceCopy.originalCasHash);
    expect(invoice.originalCasHash).toHaveLength(64);
    expect(invoice.extractionCasHash === null || invoice.extractionCasHash !== invoice.originalCasHash).toBe(true);

    const duplicates = await ledger.duplicatesByOriginalHash(stack.actor, fixture.caseId);
    expect([...duplicates.values()].some((group) => group.length >= 2)).toBe(true);

    const chronology = await ledger.chronology(stack.actor, fixture.caseId);
    expect(chronology.map((event) => event.occurredAt)).toEqual(
      [...chronology].sort((a, b) => (a.occurredAt ?? '').localeCompare(b.occurredAt ?? '')).map((event) => event.occurredAt),
    );
    expect(chronology[0]?.occurredAt).toBe('2026-03-12T16:18:00Z');

    const fact = factSchema.parse(
      (await stack.persistence.forActor(stack.actor).dungeonRecords.get(stack.actor, fixture.factId))?.payload,
    );
    expect(fact.epistemicClass).toBe('fact');
    expect(fact.producer).not.toBe('model');
    expect(fact.corroboratedBy).toEqual(
      expect.arrayContaining([fixture.assertionIds.swipe, fixture.assertionIds.gps]),
    );

    const contradiction = await stack.persistence
      .forActor(stack.actor)
      .dungeonRecords.get(stack.actor, fixture.contradictionId);
    expect(contradiction?.kind).toBe('contradiction');
    expect(contradiction?.payload.epistemicClass).toBe('contradiction');

    const hypothesis = hypothesisSchema.parse(
      (await stack.persistence.forActor(stack.actor).dungeonRecords.get(stack.actor, fixture.hypothesisId))?.payload,
    );
    expect(hypothesis.status).toBe('unsupported');
    expect(hypothesis.dependsOn).toEqual([]);

    const inference = inferenceSchema.parse(
      (await stack.persistence.forActor(stack.actor).dungeonRecords.get(stack.actor, fixture.inferenceId))?.payload,
    );
    expect(inference.epistemicClass).toBe('inference');
    expect(inference.producer).toBe('model');

    const jordan = await stack.persistence.forActor(stack.actor).dungeonRecords.get(stack.actor, fixture.entityIds.jordan);
    expect(jordan?.payload.status).toBe('ambiguous');
    expect(jordan?.payload.aliases).toEqual(expect.arrayContaining(['jordanh', 'J. Hale']));

    const sourceFile = await stack.files.getMetadata(stack.actor, fixture.fileIds.messages);
    const provenance = await stack.persistence
      .forActor(stack.actor)
      .provenance.forArtefact(sourceFile?.artefactId ?? fixture.sourceIds.messages);
    expect(provenance.some((row) => row.provider === 'atlas.investigation' && row.model === 'deterministic')).toBe(true);
    expect(provenance[0]?.sourceInputs.length).toBeGreaterThan(0);
  });

  it('refuses to turn an inference into a fact, including via reclassify', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const { investigation, ledger } = stackService(stack);
    const created = await investigation.createCase(stack.actor, {
      projectId: stack.project.id,
      title: 'Boundary',
      question: 'q',
    });
    const inference = await ledger.recordInference(stack.actor, {
      caseId: created.id,
      statement: 'The clerk hid the invoice.',
      producer: 'model',
      dependsOn: [],
    });
    await expect(
      ledger.recordFact(stack.actor, {
        caseId: created.id,
        statement: 'The clerk hid the invoice.',
        producer: 'deterministic',
        corroboratedBy: [inference.id],
      }),
    ).rejects.toMatchObject({ code: EPISTEMIC_BOUNDARY });
    await expect(ledger.reclassify(stack.actor, inference.id, 'fact')).rejects.toMatchObject({
      code: EPISTEMIC_IMMUTABLE,
    });
    await expect(
      ledger.recordFinding(stack.actor, {
        caseId: created.id,
        statement: 'Treat the inference as a fact.',
        epistemicClass: 'fact',
        linkedIds: [inference.id],
      }),
    ).rejects.toMatchObject({ code: EPISTEMIC_BOUNDARY });
    const still = await stack.persistence.forActor(stack.actor).dungeonRecords.get(stack.actor, inference.id);
    expect(still?.kind).toBe('inference');
    expect(still?.payload.epistemicClass).toBe('inference');
  });

  it('stales derived findings when a source generation is bumped, without rewriting the whole case', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const { investigation, ledger } = stackService(stack);
    const fixture = await loadHarbourFixture(stack.actor, {
      investigation,
      ledger,
      files: stack.files,
      projectId: stack.project.id,
    });
    const before = await ledger.listCase(stack.actor, fixture.caseId);
    const { staleIds } = await ledger.bumpSourceGeneration(stack.actor, fixture.sourceIds.swipe);
    expect(staleIds.length).toBeGreaterThan(0);
    expect(staleIds).toContain(fixture.objectIds.swipe);
    expect(staleIds).toContain(fixture.assertionIds.swipe);
    const after = await ledger.listCase(stack.actor, fixture.caseId);
    expect(after).toHaveLength(before.length);
    const swipeObject = after.find((row) => row.id === fixture.objectIds.swipe);
    expect(swipeObject?.payload.staleAt).toBeTruthy();
    const messagesObject = after.find((row) => row.id === fixture.objectIds.messages);
    expect(messagesObject?.payload.staleAt).toBeNull();
    const hypothesis = after.find((row) => row.id === fixture.hypothesisId);
    expect(hypothesis?.payload.staleAt).toBeNull();
  });

  it('does not leak another tenant’s evidential rows', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const { investigation, ledger } = stackService(stack);
    const fixture = await loadHarbourFixture(stack.actor, {
      investigation,
      ledger,
      files: stack.files,
      projectId: stack.project.id,
    });
    await stack.persistence.ensureTenant({ id: 'tenant_b', name: 'B' });
    await stack.persistence.ensurePrincipal({ id: 'principal_b', displayName: 'B' });
    const other = { tenantId: 'tenant_b', principalId: 'principal_b' };
    await expect(ledger.chronology(other, fixture.caseId)).rejects.toBeInstanceOf(InvestigationError);
  });
});
