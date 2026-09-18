import { afterEach, describe, expect, it } from 'vitest';
import {
  communicationTurnSchema,
  hypothesisTestSchema,
  investigationViewsSchema,
} from '@atlas-vnext/contracts';
import type { PlatformPersistence } from '@atlas-vnext/persistence';
import { closePersistence, openDungeonStack } from '../../../tests/helpers/dungeon-stack.ts';
import {
  EvidenceLedger,
  InvestigationAnalysis,
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
    context: stack.context,
  });
  const ledger = new EvidenceLedger({
    persistence: stack.persistence,
    projects: stack.projects,
    files: stack.files,
    authority: stack.authority,
    policy: stack.policy,
  });
  const analysis = new InvestigationAnalysis({ ledger, context: stack.context });
  return { investigation, ledger, analysis };
}

describe('Investigation A2 analysis', () => {
  it('reconstructs threads, chronology groups, alias candidates, matrix, corroboration, contradiction, gap, targeted retrieval, and a sourced finding', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const { investigation, ledger, analysis } = stackService(stack);
    const fixture = await loadHarbourFixture(stack.actor, {
      investigation,
      ledger,
      files: stack.files,
      projectId: stack.project.id,
    });

    const threads = await analysis.threads(stack.actor, fixture.caseId);
    expect(threads.length).toBeGreaterThanOrEqual(2);
    const slack = threads.find((item) => item.evidenceObjectId === fixture.objectIds.messages);
    expect(slack).toBeDefined();
    expect(slack!.turns.length).toBeGreaterThanOrEqual(4);
    expect(slack!.turns.map((turn) => turn.speaker)).toEqual(
      expect.arrayContaining(['jordanh', 'maya.chen', 'priya.shah']),
    );
    expect(slack!.turns.every((turn) => turn.epistemicClass === 'source_assertion')).toBe(true);
    expect(slack!.turns.every((turn) => communicationTurnSchema.parse(turn) && turn.sourceLocation.offsetStart !== null)).toBe(
      true,
    );
    const ordered = [...slack!.turns].sort((a, b) => (a.occurredAt ?? '').localeCompare(b.occurredAt ?? ''));
    expect(slack!.turns.map((turn) => turn.occurredAt)).toEqual(ordered.map((turn) => turn.occurredAt));

    const timeline = await analysis.timeline(stack.actor, fixture.caseId);
    const dates = timeline.groups.map((group) => group.date);
    expect(dates).toEqual([...dates].sort());
    expect(timeline.groups.some((group) => group.date === '2026-03-12')).toBe(true);
    expect(timeline.groups.some((group) => group.date === '2026-03-13')).toBe(true);
    const fridayClaim = timeline.groups
      .flatMap((group) => group.items)
      .find((item) => item.description.includes('Friday'));
    expect(fridayClaim?.epistemicClass).toBe('source_assertion');
    expect(fridayClaim?.epistemicClass).not.toBe('fact');

    const candidates = await analysis.proposeAliasCandidates(stack.actor, fixture.caseId);
    const jordanPair = candidates.find(
      (item) =>
        (item.leftEntityId === fixture.entityIds.jordan && item.rightEntityId === fixture.entityIds.jordanhHandle) ||
        (item.leftEntityId === fixture.entityIds.jordanhHandle && item.rightEntityId === fixture.entityIds.jordan),
    );
    expect(jordanPair).toBeDefined();
    expect(jordanPair!.status).toBe('proposed');
    expect(jordanPair!.confidence).toBeGreaterThan(0);
    expect(jordanPair!.evidenceObjectIds.length).toBeGreaterThan(0);
    expect(jordanPair!.producer === 'deterministic' || jordanPair!.producer === 'model').toBe(true);

    const accepted = await analysis.acceptAlias(stack.actor, jordanPair!.id);
    expect(accepted.status).toBe('accepted');
    const jordan = await stack.persistence.forActor(stack.actor).dungeonRecords.get(stack.actor, fixture.entityIds.jordan);
    expect(jordan?.kind).toBe('entity');
    expect(jordan?.payload.epistemicClass).toBeUndefined();
    const reverted = await analysis.revertAlias(stack.actor, accepted.id);
    expect(reverted.status).toBe('reverted');

    const matrix = await analysis.claimMatrix(stack.actor, fixture.caseId);
    expect(matrix.claims.some((item) => item.id === fixture.claimId)).toBe(true);
    expect(matrix.cells.some((cell) => cell.claimId === fixture.claimId && cell.role === 'supports')).toBe(true);
    expect(matrix.unmappedEvidenceIds.length).toBeGreaterThan(0);

    const relations = await analysis.relations(stack.actor, fixture.caseId);
    expect(relations.some((item) => item.kind === 'corroboration' && item.epistemicClass === 'fact')).toBe(true);
    expect(relations.some((item) => item.kind === 'contradiction' && item.id === fixture.contradictionId)).toBe(true);

    const gaps = await analysis.gaps(stack.actor, fixture.caseId);
    expect(gaps.some((item) => item.kind === 'unsupported_hypothesis' && item.relatedIds.includes(fixture.hypothesisId))).toBe(
      true,
    );

    const test = await analysis.testHypothesis(stack.actor, fixture.caseId, fixture.hypothesisId);
    expect(hypothesisTestSchema.parse(test).result).toBe('unsupported');
    expect(test.producer).toBe('deterministic');
    const asFact = await stack.persistence.forActor(stack.actor).dungeonRecords.get(stack.actor, test.id);
    expect(asFact?.kind).toBe('hypothesis_test');
    expect(asFact?.payload.epistemicClass).not.toBe('fact');

    const working = await analysis.compileFocusedWorkingSet(stack.actor, fixture.caseId, {
      focus: 'contradiction',
      id: fixture.contradictionId,
      tokenBudget: 800,
    });
    expect(working.tokenCount).toBeLessThanOrEqual(800);
    expect(working.items.some((item) => item.kind === 'evidence' && item.sourceRef)).toBe(true);
    expect(working.items.length).toBeLessThan(20);
    const tiny = await analysis.compileFocusedWorkingSet(stack.actor, fixture.caseId, {
      focus: 'contradiction',
      tokenBudget: 40,
    });
    expect(tiny.truncated || tiny.omitted.length > 0).toBe(true);

    const sourced = await stack.persistence.forActor(stack.actor).dungeonRecords.get(stack.actor, fixture.findingIds.presence);
    expect(sourced?.payload.epistemicClass).toBe('fact');

    const views = investigationViewsSchema.parse(await analysis.views(stack.actor, fixture.caseId));
    expect(views.timeline.threads.length).toBeGreaterThan(0);
    expect(views.network.nodes.some((node) => node.id === fixture.entityIds.jordan)).toBe(true);
    expect(views.matrix.claims.length).toBeGreaterThan(0);
  });

  it('does not leak another tenant’s analysis views', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const { investigation, ledger, analysis } = stackService(stack);
    const fixture = await loadHarbourFixture(stack.actor, {
      investigation,
      ledger,
      files: stack.files,
      projectId: stack.project.id,
    });
    await stack.persistence.ensureTenant({ id: 'tenant_b', name: 'B' });
    await stack.persistence.ensurePrincipal({ id: 'principal_b', displayName: 'B' });
    const other = { tenantId: 'tenant_b', principalId: 'principal_b' };
    await expect(analysis.views(other, fixture.caseId)).rejects.toBeInstanceOf(InvestigationError);
    await expect(analysis.proposeAliasCandidates(other, fixture.caseId)).rejects.toBeInstanceOf(InvestigationError);
  });

  it('does not copy alias candidates across projects', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const { investigation, ledger, analysis } = stackService(stack);
    const home = await investigation.createCase(stack.actor, {
      projectId: stack.project.id,
      title: 'Home',
      question: 'q',
    });
    const otherProject = await stack.projects.create(stack.actor, { name: 'Other Lab' });
    const away = await investigation.createCase(stack.actor, {
      projectId: otherProject.id,
      title: 'Away',
      question: 'q',
    });
    const foreign = await ledger.addEntity(stack.actor, {
      caseId: away.id,
      kind: 'person',
      canonicalName: 'Foreign',
    });
    const local = await ledger.addEntity(stack.actor, {
      caseId: home.id,
      kind: 'person',
      canonicalName: 'Local',
    });
    await expect(
      ledger.recordAliasCandidate(stack.actor, {
        caseId: home.id,
        leftEntityId: local.id,
        rightEntityId: foreign.id,
        surface: 'Foreign',
        confidence: 0.9,
        confidenceBasis: 'alias_overlap',
        producer: 'deterministic',
        status: 'proposed',
        evidenceObjectIds: [],
        addedAlias: null,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const listed = await analysis.listAliasCandidates(stack.actor, home.id);
    expect(listed).toEqual([]);
  });

  it('refuses to treat a hypothesis test as a fact', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const { investigation, ledger, analysis } = stackService(stack);
    const created = await investigation.createCase(stack.actor, {
      projectId: stack.project.id,
      title: 'Boundary',
      question: 'q',
    });
    const hypothesis = await ledger.recordHypothesis(stack.actor, {
      caseId: created.id,
      statement: 'The clerk hid the invoice.',
      status: 'unsupported',
    });
    const test = await analysis.testHypothesis(stack.actor, created.id, hypothesis.id);
    await expect(
      ledger.recordFact(stack.actor, {
        caseId: created.id,
        statement: 'Treat the test as a fact.',
        producer: 'deterministic',
        corroboratedBy: [test.id],
      }),
    ).rejects.toMatchObject({ code: 'epistemic_boundary' });
  });
});
