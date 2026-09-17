import { afterEach, describe, expect, it } from 'vitest';
import type { PlatformPersistence } from '@atlas-vnext/persistence';
import { closePersistence, openDungeonStack } from '../../../tests/helpers/dungeon-stack.ts';
import {
  EvidenceLedger,
  InvestigationAnalysis,
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

describe('Investigation deterministic analysis (A2)', () => {
  it('reconstructs chronology and threads, finds duplicates, gaps, contradiction, and an unsupported hypothesis without collapsing epistemic classes', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
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
    const fixture = await loadHarbourFixture(stack.actor, {
      investigation,
      ledger,
      files: stack.files,
      projectId: stack.project.id,
    });
    const analysis = new InvestigationAnalysis(ledger);
    const report = await analysis.analyze(stack.actor, fixture.caseId);

    expect(report.chronology.map((event) => event.occurredAt)).toEqual([
      '2026-03-12T16:18:00Z',
      '2026-03-12T16:22:08Z',
      '2026-03-13T08:12:44Z',
    ]);
    expect(report.duplicateOriginalHashes.length).toBeGreaterThan(0);
    expect(report.threads.some((thread) => thread.objectIds.includes(fixture.objectIds.messages))).toBe(true);
    expect(report.threads.some((thread) => thread.objectIds.includes(fixture.objectIds.calls))).toBe(true);
    expect(report.facts.some((fact) => fact.id === fixture.factId && fact.epistemicClass === 'fact')).toBe(true);
    expect(report.assertions.every((item) => item.epistemicClass === 'source_assertion')).toBe(true);
    expect(report.contradictions.some((item) => item.id === fixture.contradictionId)).toBe(true);
    expect(report.unsupportedHypotheses.some((item) => item.id === fixture.hypothesisId)).toBe(true);
    expect(report.claimsWithoutSupport.length).toBeGreaterThan(0);
    expect(report.ambiguousEntities.some((item) => item.id === fixture.entityIds.jordan)).toBe(true);

    const evidence = await analysis.retrieveUnderlyingEvidence(stack.actor, fixture.factId);
    expect(evidence.some((item) => item.id === fixture.objectIds.swipe)).toBe(true);
    expect(evidence.some((item) => item.id === fixture.objectIds.gps)).toBe(true);
    expect(evidence.every((item) => item.originalCasHash.length === 64)).toBe(true);
  });
});
