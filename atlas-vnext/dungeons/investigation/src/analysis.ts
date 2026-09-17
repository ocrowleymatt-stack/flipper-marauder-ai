import {
  claimSchema,
  contradictionSchema,
  entitySchema,
  evidenceLinkSchema,
  evidenceObjectSchema,
  factSchema,
  hypothesisSchema,
  sourceAssertionSchema,
  type EvidenceClaim,
  type EvidenceEntity,
  type EvidenceEvent,
  type EvidenceLink,
  type EvidenceObject,
  type Fact,
  type Hypothesis,
  type SourceAssertion,
} from '@atlas-vnext/contracts';
import type { InvestigationActor } from './errors.ts';
import { EVIDENCE_KINDS, EvidenceLedger } from './ledger.ts';

const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/;

export interface CommunicationThread {
  sourceId: string;
  objectIds: string[];
  timestamps: Array<string | null>;
}

export interface CaseAnalysis {
  chronology: EvidenceEvent[];
  duplicateOriginalHashes: string[];
  threads: CommunicationThread[];
  facts: Fact[];
  assertions: SourceAssertion[];
  contradictions: Array<{ id: string; leftId: string; rightId: string; statement: string }>;
  unsupportedHypotheses: Hypothesis[];
  claimsWithoutSupport: EvidenceClaim[];
  ambiguousEntities: EvidenceEntity[];
}

/**
 * Deterministic A2 primitives over the evidential ledger.
 * No model calls. Does not dump the estate into a prompt.
 */
export class InvestigationAnalysis {
  constructor(private readonly ledger: EvidenceLedger) {}

  async analyze(actor: InvestigationActor, caseId: string): Promise<CaseAnalysis> {
    const [chronology, duplicates, objects, assertions, facts, contradictions, hypotheses, claims, links, entities] =
      await Promise.all([
        this.ledger.chronology(actor, caseId),
        this.ledger.duplicatesByOriginalHash(actor, caseId),
        this.objects(actor, caseId),
        this.parseKind(actor, caseId, EVIDENCE_KINDS.assertion, sourceAssertionSchema),
        this.parseKind(actor, caseId, EVIDENCE_KINDS.fact, factSchema),
        this.parseKind(actor, caseId, EVIDENCE_KINDS.contradiction, contradictionSchema),
        this.parseKind(actor, caseId, EVIDENCE_KINDS.hypothesis, hypothesisSchema),
        this.parseKind(actor, caseId, EVIDENCE_KINDS.claim, claimSchema),
        this.parseKind(actor, caseId, EVIDENCE_KINDS.link, evidenceLinkSchema),
        this.parseKind(actor, caseId, EVIDENCE_KINDS.entity, entitySchema),
      ]);

    const supported = new Set<string>();
    for (const link of links) {
      if (link.role === 'supports' || link.role === 'corroborates') {
        supported.add(link.fromId);
        supported.add(link.toId);
      }
    }
    for (const fact of facts) {
      for (const id of fact.corroboratedBy) supported.add(id);
    }

    return {
      chronology,
      duplicateOriginalHashes: [...duplicates.keys()],
      threads: reconstructThreads(objects),
      facts,
      assertions,
      contradictions: contradictions.map((row) => ({
        id: row.id,
        leftId: row.leftId,
        rightId: row.rightId,
        statement: row.statement,
      })),
      unsupportedHypotheses: hypotheses.filter((item) => item.status === 'unsupported' || item.dependsOn.length === 0),
      claimsWithoutSupport: claims.filter((claim) => !supported.has(claim.id)),
      ambiguousEntities: entities.filter((entity) => entity.status === 'ambiguous'),
    };
  }

  async retrieveUnderlyingEvidence(actor: InvestigationActor, id: string): Promise<EvidenceObject[]> {
    const start = await this.ledger.getRecord(actor, id);
    const caseId = start.kind === 'case' ? start.id : String(start.payload.caseId ?? '');
    const rows = await this.ledger.listCase(actor, caseId);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const seen = new Set<string>();
    const queue = [id, ...asStringArray(start.payload.dependsOn)];
    const objects: EvidenceObject[] = [];
    while (queue.length) {
      const next = queue.shift();
      if (!next || seen.has(next)) continue;
      seen.add(next);
      const row = byId.get(next);
      if (!row) continue;
      if (row.kind === EVIDENCE_KINDS.object) {
        objects.push(evidenceObjectSchema.parse(row.payload));
      }
      queue.push(...asStringArray(row.payload.dependsOn));
    }
    return objects;
  }

  private async objects(actor: InvestigationActor, caseId: string): Promise<EvidenceObject[]> {
    return this.parseKind(actor, caseId, EVIDENCE_KINDS.object, evidenceObjectSchema);
  }

  private async parseKind<T>(
    actor: InvestigationActor,
    caseId: string,
    kind: string,
    schema: { parse: (value: unknown) => T },
  ): Promise<T[]> {
    const rows = await this.ledger.listKind(actor, caseId, kind);
    return rows.map((row) => schema.parse(row.payload));
  }
}

export function reconstructThreads(objects: EvidenceObject[]): CommunicationThread[] {
  const communicative = objects.filter(
    (object) => object.kind === 'message' || object.kind === 'transcript' || object.kind === 'call_record',
  );
  const groups = new Map<string, EvidenceObject[]>();
  for (const object of communicative) {
    const list = groups.get(object.sourceId) ?? [];
    list.push(object);
    groups.set(object.sourceId, list);
  }
  const threads: CommunicationThread[] = [];
  for (const [sourceId, items] of groups) {
    const decorated = items.map((item) => ({
      item,
      timestamp: item.sourceLocation.timestampStart ?? firstTimestamp(item.text),
    }));
    decorated.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? '') || a.item.id.localeCompare(b.item.id));
    threads.push({
      sourceId,
      objectIds: decorated.map((row) => row.item.id),
      timestamps: decorated.map((row) => row.timestamp),
    });
  }
  return threads.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}

export function firstTimestamp(text: string): string | null {
  const match = text.match(ISO_TIMESTAMP);
  return match?.[0] ?? null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
