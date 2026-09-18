import {
  aliasCandidateSchema,
  claimSchema,
  contradictionSchema,
  entityMentionSchema,
  entitySchema,
  evidenceLinkSchema,
  evidenceObjectSchema,
  evidenceSourceSchema,
  factSchema,
  findingSchema,
  hypothesisSchema,
  hypothesisTestSchema,
  relationshipSchema,
  sourceAssertionSchema,
  type AliasCandidate,
  type AnalysisGap,
  type AnalysisRelation,
  type ChronologyGroup,
  type ChronologyItem,
  type ClaimMatrix,
  type CommunicationThread,
  type CompiledWorkingSet,
  type ContextCompileRequest,
  type EvidenceEntity,
  type EvidenceObject,
  type HypothesisTest,
  type InvestigationViews,
  type NetworkView,
  type TimelineView,
} from '@atlas-vnext/contracts';
import { ContextCompiler } from '@atlas-vnext/context';
import type { ContextService } from '@atlas-vnext/context';
import { EvidenceLedger, EVIDENCE_KINDS } from './ledger.ts';
import { GENERIC_DENY, InvestigationError, type InvestigationActor } from './errors.ts';
import { reconstructThreads, timestampMs, utcDate } from './threads.ts';

type AnalysisDeps = {
  ledger: EvidenceLedger;
  compiler?: ContextCompiler;
  context?: ContextService | null;
};

/**
 * Deterministic investigation analysis. AI may only appear as a typed producer
 * on alias candidates (model_proposal); it never writes facts.
 */
export class InvestigationAnalysis {
  private readonly compiler: ContextCompiler;

  constructor(private readonly deps: AnalysisDeps) {
    this.compiler = deps.compiler ?? new ContextCompiler();
  }

  async views(actor: InvestigationActor, caseId: string): Promise<InvestigationViews> {
    const [timeline, network, matrix, relations, gaps, tests] = await Promise.all([
      this.timeline(actor, caseId),
      this.network(actor, caseId),
      this.claimMatrix(actor, caseId),
      this.relations(actor, caseId),
      this.gaps(actor, caseId),
      this.listHypothesisTests(actor, caseId),
    ]);
    return { timeline, network, matrix, relations, gaps, hypothesisTests: tests };
  }

  async timeline(actor: InvestigationActor, caseId: string): Promise<TimelineView> {
    const threads = await this.threads(actor, caseId);
    const events = await this.deps.ledger.chronology(actor, caseId);
    const items: ChronologyItem[] = [
      ...events.map((event) => ({
        id: event.id,
        kind: 'event' as const,
        occurredAt: event.occurredAt,
        description: event.description,
        epistemicClass: event.epistemicClass,
        evidenceObjectIds: event.evidenceObjectIds,
      })),
      ...threads.flatMap((thread) =>
        thread.turns.map((turn) => ({
          id: turn.id,
          kind: 'thread_turn' as const,
          occurredAt: turn.occurredAt,
          description: `${turn.speaker}: ${turn.text}`,
          epistemicClass: 'source_assertion' as const,
          evidenceObjectIds: [turn.evidenceObjectId],
          sourceLocation: turn.sourceLocation,
        })),
      ),
    ];
    items.sort(compareChronology);
    const grouped = new Map<string, ChronologyItem[]>();
    for (const item of items) {
      const date = utcDate(item.occurredAt);
      const list = grouped.get(date) ?? [];
      list.push(item);
      grouped.set(date, list);
    }
    const groups: ChronologyGroup[] = [...grouped.entries()]
      .sort((a, b) => {
        if (a[0] === 'unknown') return 1;
        if (b[0] === 'unknown') return -1;
        return a[0].localeCompare(b[0]);
      })
      .map(([date, groupedItems]) => ({ date, items: groupedItems }));
    return { caseId, groups, threads };
  }

  async threads(actor: InvestigationActor, caseId: string): Promise<CommunicationThread[]> {
    const objects = (await this.deps.ledger.listKind(actor, caseId, EVIDENCE_KINDS.object)).map((row) =>
      evidenceObjectSchema.parse(row.payload),
    );
    return reconstructThreads(caseId, objects);
  }

  async network(actor: InvestigationActor, caseId: string): Promise<NetworkView> {
    const entities = (await this.deps.ledger.listKind(actor, caseId, EVIDENCE_KINDS.entity)).map((row) =>
      entitySchema.parse(row.payload),
    );
    const relationships = (await this.deps.ledger.listKind(actor, caseId, EVIDENCE_KINDS.relationship)).map((row) =>
      relationshipSchema.parse(row.payload),
    );
    const candidates = await this.listAliasCandidates(actor, caseId);
    const edges = [
      ...relationships.map((rel) => ({
        id: rel.id,
        fromId: rel.fromEntityId,
        toId: rel.toEntityId,
        kind: rel.kind,
        epistemicClass: rel.epistemicClass,
      })),
      ...candidates
        .filter((item) => item.status === 'accepted')
        .map((item) => ({
          id: item.id,
          fromId: item.leftEntityId,
          toId: item.rightEntityId,
          kind: 'alias',
          epistemicClass: 'source_assertion' as const,
        })),
    ];
    return {
      caseId,
      nodes: entities.map((entity) => ({
        id: entity.id,
        kind: entity.kind,
        canonicalName: entity.canonicalName,
        aliases: entity.aliases,
        status: entity.status,
      })),
      edges,
      aliasCandidates: candidates,
    };
  }

  async claimMatrix(actor: InvestigationActor, caseId: string): Promise<ClaimMatrix> {
    const claims = (await this.deps.ledger.listKind(actor, caseId, EVIDENCE_KINDS.claim)).map((row) =>
      claimSchema.parse(row.payload),
    );
    const links = (await this.deps.ledger.listKind(actor, caseId, EVIDENCE_KINDS.link)).map((row) =>
      evidenceLinkSchema.parse(row.payload),
    );
    const objects = (await this.deps.ledger.listKind(actor, caseId, EVIDENCE_KINDS.object)).map((row) =>
      evidenceObjectSchema.parse(row.payload),
    );
    const claimIds = new Set(claims.map((item) => item.id));
    const cells: ClaimMatrix['cells'] = [];
    const mappedEvidence = new Set<string>();
    const supportedClaims = new Set<string>();
    for (const link of links) {
      const claimId = claimIds.has(link.fromId) ? link.fromId : claimIds.has(link.toId) ? link.toId : null;
      if (!claimId) continue;
      const evidenceId = claimId === link.fromId ? link.toId : link.fromId;
      cells.push({ claimId, evidenceId, role: link.role });
      mappedEvidence.add(evidenceId);
      if (link.role === 'supports' || link.role === 'corroborates' || link.role === 'contradicts') {
        supportedClaims.add(claimId);
      }
    }
    return {
      caseId,
      claims,
      cells,
      unmappedEvidenceIds: objects.map((item) => item.id).filter((id) => !mappedEvidence.has(id)),
      unsupportedClaimIds: claims.map((item) => item.id).filter((id) => !supportedClaims.has(id)),
    };
  }

  async relations(actor: InvestigationActor, caseId: string): Promise<AnalysisRelation[]> {
    const contradictions = (await this.deps.ledger.listKind(actor, caseId, EVIDENCE_KINDS.contradiction)).map((row) =>
      contradictionSchema.parse(row.payload),
    );
    const facts = (await this.deps.ledger.listKind(actor, caseId, EVIDENCE_KINDS.fact)).map((row) =>
      factSchema.parse(row.payload),
    );
    const links = (await this.deps.ledger.listKind(actor, caseId, EVIDENCE_KINDS.link)).map((row) =>
      evidenceLinkSchema.parse(row.payload),
    );
    const out: AnalysisRelation[] = [];
    for (const item of contradictions) {
      out.push({
        id: item.id,
        caseId,
        kind: 'contradiction',
        leftId: item.leftId,
        rightId: item.rightId,
        statement: item.statement,
        epistemicClass: 'contradiction',
      });
    }
    for (const fact of facts) {
      if (fact.corroboratedBy.length >= 2) {
        out.push({
          id: fact.id,
          caseId,
          kind: 'corroboration',
          leftId: fact.corroboratedBy[0]!,
          rightId: fact.corroboratedBy[1]!,
          statement: fact.statement,
          epistemicClass: 'fact',
        });
      }
    }
    for (const link of links) {
      if (link.role !== 'corroborates' && link.role !== 'contradicts') continue;
      if (out.some((item) => idsMatch(item.leftId, item.rightId, link.fromId, link.toId))) continue;
      out.push({
        id: link.id,
        caseId,
        kind: link.role === 'corroborates' ? 'corroboration' : 'contradiction',
        leftId: link.fromId,
        rightId: link.toId,
        statement: `${link.role} ${link.fromId} ${link.toId}`,
        epistemicClass: link.role === 'contradicts' ? 'contradiction' : 'source_assertion',
      });
    }
    return out;
  }

  async gaps(actor: InvestigationActor, caseId: string): Promise<AnalysisGap[]> {
    const hypotheses = (await this.deps.ledger.listKind(actor, caseId, EVIDENCE_KINDS.hypothesis)).map((row) =>
      hypothesisSchema.parse(row.payload),
    );
    const matrix = await this.claimMatrix(actor, caseId);
    const out: AnalysisGap[] = [];
    for (const hypothesis of hypotheses) {
      if (hypothesis.status === 'unsupported' || hypothesis.dependsOn.length === 0) {
        out.push({
          id: `gap_hyp_${hypothesis.id}`,
          caseId,
          kind: 'unsupported_hypothesis',
          statement: hypothesis.statement,
          relatedIds: [hypothesis.id],
        });
      }
    }
    for (const id of matrix.unmappedEvidenceIds) {
      out.push({
        id: `gap_ev_${id}`,
        caseId,
        kind: 'unmapped_evidence',
        statement: 'Evidence object is not mapped to a claim.',
        relatedIds: [id],
      });
    }
    for (const id of matrix.unsupportedClaimIds) {
      out.push({
        id: `gap_cl_${id}`,
        caseId,
        kind: 'unmapped_claim',
        statement: 'Claim has no supporting, corroborating, or contradicting evidence link.',
        relatedIds: [id],
      });
    }
    return out;
  }

  async proposeAliasCandidates(actor: InvestigationActor, caseId: string): Promise<AliasCandidate[]> {
    const entities = (await this.deps.ledger.listKind(actor, caseId, EVIDENCE_KINDS.entity)).map((row) =>
      entitySchema.parse(row.payload),
    );
    const mentions = (await this.deps.ledger.listKind(actor, caseId, EVIDENCE_KINDS.mention)).map((row) =>
      entityMentionSchema.parse(row.payload),
    );
    const written: AliasCandidate[] = [];
    for (let i = 0; i < entities.length; i += 1) {
      for (let j = i + 1; j < entities.length; j += 1) {
        const left = entities[i]!;
        const right = entities[j]!;
        const overlap = aliasOverlap(left, right);
        if (overlap) {
          written.push(
            await this.deps.ledger.recordAliasCandidate(actor, {
              caseId,
              leftEntityId: left.id,
              rightEntityId: right.id,
              surface: overlap,
              confidence: 0.9,
              confidenceBasis: 'alias_overlap',
              producer: 'deterministic',
              status: 'proposed',
              evidenceObjectIds: mentionObjects(mentions, [left.id, right.id]),
              addedAlias: null,
            }),
          );
          continue;
        }
        const surface = sharedSurface(left, right, mentions);
        if (surface) {
          written.push(
            await this.deps.ledger.recordAliasCandidate(actor, {
              caseId,
              leftEntityId: left.id,
              rightEntityId: right.id,
              surface,
              confidence: 0.7,
              confidenceBasis: 'surface_match',
              producer: 'deterministic',
              status: 'proposed',
              evidenceObjectIds: mentionObjects(mentions, [left.id, right.id]),
              addedAlias: null,
            }),
          );
        }
      }
    }
    for (const inference of (await this.deps.ledger.listKind(actor, caseId, EVIDENCE_KINDS.inference)).map((row) =>
      row.payload,
    )) {
      if (typeof inference.producer !== 'string' || inference.producer !== 'model') continue;
      const mentioned = entities.filter((entity) => namesInStatement(entity, String(inference.statement ?? '')));
      if (mentioned.length < 2) continue;
      written.push(
        await this.deps.ledger.recordAliasCandidate(actor, {
          caseId,
          leftEntityId: mentioned[0]!.id,
          rightEntityId: mentioned[1]!.id,
          surface: mentioned[1]!.canonicalName,
          confidence: 0.4,
          confidenceBasis: 'model_proposal',
          producer: 'model',
          status: 'proposed',
          evidenceObjectIds: mentionObjects(mentions, mentioned.map((item) => item.id)),
          addedAlias: null,
          dependsOn: [String(inference.id)],
        }),
      );
    }
    return written.length > 0 ? written : this.listAliasCandidates(actor, caseId);
  }

  async acceptAlias(actor: InvestigationActor, candidateId: string): Promise<AliasCandidate> {
    return this.deps.ledger.setAliasCandidateStatus(actor, candidateId, 'accepted');
  }

  async rejectAlias(actor: InvestigationActor, candidateId: string): Promise<AliasCandidate> {
    return this.deps.ledger.setAliasCandidateStatus(actor, candidateId, 'rejected');
  }

  async revertAlias(actor: InvestigationActor, candidateId: string): Promise<AliasCandidate> {
    return this.deps.ledger.setAliasCandidateStatus(actor, candidateId, 'reverted');
  }

  async testHypothesis(actor: InvestigationActor, caseId: string, hypothesisId: string): Promise<HypothesisTest> {
    const rows = await this.deps.ledger.listKind(actor, caseId, EVIDENCE_KINDS.hypothesis);
    const hypothesisRow = rows.find((row) => row.id === hypothesisId);
    if (!hypothesisRow) {
      throw new InvestigationError('not_found', GENERIC_DENY, 404);
    }
    const hypothesis = hypothesisSchema.parse(hypothesisRow.payload);
    const links = (await this.deps.ledger.listKind(actor, caseId, EVIDENCE_KINDS.link)).map((row) =>
      evidenceLinkSchema.parse(row.payload),
    );
    const supportingIds = links
      .filter((link) => link.role === 'supports' && (link.fromId === hypothesisId || link.toId === hypothesisId))
      .map((link) => (link.fromId === hypothesisId ? link.toId : link.fromId));
    const contradictingIds = links
      .filter((link) => link.role === 'contradicts' && (link.fromId === hypothesisId || link.toId === hypothesisId))
      .map((link) => (link.fromId === hypothesisId ? link.toId : link.fromId));
    let result: HypothesisTest['result'] = 'inconclusive';
    let gap: string | null = null;
    if (contradictingIds.length > 0 && supportingIds.length === 0) result = 'rejected';
    else if (supportingIds.length > 0 && contradictingIds.length === 0) result = 'supported';
    else if (supportingIds.length === 0 && contradictingIds.length === 0) {
      result = 'unsupported';
      gap = 'No evidential object supports or contradicts this hypothesis.';
    }
    if (hypothesis.status === 'unsupported' && result === 'inconclusive') {
      result = 'unsupported';
      gap = gap ?? 'Hypothesis is recorded as unsupported and has no covering evidence.';
    }
    return this.deps.ledger.recordHypothesisTest(actor, {
      caseId,
      hypothesisId,
      result,
      supportingIds,
      contradictingIds,
      gap,
    });
  }

  /**
   * Targeted working set through the generic context compiler. Never dumps the
   * whole evidential estate.
   */
  async compileFocusedWorkingSet(
    actor: InvestigationActor,
    caseId: string,
    input: { focus: 'contradiction' | 'hypothesis' | 'claim' | 'finding'; id?: string; tokenBudget: number },
  ): Promise<CompiledWorkingSet> {
    await this.deps.ledger.chronology(actor, caseId);
    const evidence: NonNullable<ContextCompileRequest['evidence']> = [];
    const relations = await this.relations(actor, caseId);
    const objects = (await this.deps.ledger.listKind(actor, caseId, EVIDENCE_KINDS.object)).map((row) =>
      evidenceObjectSchema.parse(row.payload),
    );
    const objectById = new Map(objects.map((item) => [item.id, item]));
    const assertions = (await this.deps.ledger.listKind(actor, caseId, EVIDENCE_KINDS.assertion)).map((row) =>
      sourceAssertionSchema.parse(row.payload),
    );

    if (input.focus === 'contradiction') {
      const contradiction = input.id
        ? relations.find((item) => item.id === input.id && item.kind === 'contradiction')
        : relations.find((item) => item.kind === 'contradiction');
      if (contradiction) {
        evidence.push({
          id: contradiction.id,
          content: `CONTRADICTION (${contradiction.epistemicClass}): ${contradiction.statement}`,
          sourceRef: contradiction.id,
        });
        for (const id of [contradiction.leftId, contradiction.rightId]) {
          const assertion = assertions.find((item) => item.id === id);
          if (assertion) {
            evidence.push({
              id: assertion.id,
              content: `SOURCE ASSERTION by ${assertion.assertedBy}: ${assertion.statement}`,
              sourceRef: assertion.evidenceObjectId,
            });
            const object = objectById.get(assertion.evidenceObjectId);
            if (object) {
              evidence.push({
                id: object.id,
                content: excerpt(object.text, 400),
                sourceRef: object.id,
              });
            }
          }
        }
      }
    } else if (input.focus === 'hypothesis') {
      const hypotheses = (await this.deps.ledger.listKind(actor, caseId, EVIDENCE_KINDS.hypothesis)).map((row) =>
        hypothesisSchema.parse(row.payload),
      );
      const hypothesis = input.id ? hypotheses.find((item) => item.id === input.id) : hypotheses[0];
      if (hypothesis) {
        evidence.push({
          id: hypothesis.id,
          content: `HYPOTHESIS (${hypothesis.status}): ${hypothesis.statement}`,
          sourceRef: hypothesis.id,
        });
      }
    } else if (input.focus === 'claim') {
      const matrix = await this.claimMatrix(actor, caseId);
      const claim = input.id ? matrix.claims.find((item) => item.id === input.id) : matrix.claims[0];
      if (claim) {
        evidence.push({
          id: claim.id,
          content: `CLAIM (${claim.kind}): ${claim.statement}`,
          sourceRef: claim.id,
        });
        for (const cell of matrix.cells.filter((item) => item.claimId === claim.id)) {
          evidence.push({
            id: cell.evidenceId,
            content: `LINK ${cell.role} -> ${cell.evidenceId}`,
            sourceRef: cell.evidenceId,
          });
        }
      }
    } else {
      const findings = (await this.deps.ledger.listKind(actor, caseId, EVIDENCE_KINDS.finding)).map((row) =>
        findingSchema.parse(row.payload),
      );
      const finding = input.id ? findings.find((item) => item.id === input.id) : findings.find((item) => item.epistemicClass === 'fact');
      if (finding) {
        evidence.push({
          id: finding.id,
          content: `FINDING (${finding.epistemicClass}): ${finding.statement}`,
          sourceRef: finding.id,
        });
      }
    }

    if (this.deps.context) {
      const sources = (await this.deps.ledger.listKind(actor, caseId, EVIDENCE_KINDS.source)).map((row) =>
        evidenceSourceSchema.parse(row.payload),
      );
      const fileIds = sources.map((item) => item.fileId).filter((id): id is string => Boolean(id));
      const query = evidence[0]?.content ?? 'harbour invoice';
      const caseRow = (await this.deps.ledger.listCase(actor, caseId)).find((row) => row.kind === 'case');
      const projectId = caseRow?.workspaceId;
      if (projectId && fileIds.length > 0) {
        const assembled = await this.deps.context.assemble(actor, {
          projectId,
          query,
          tokenBudget: Math.min(400, input.tokenBudget),
          restrictFileIds: fileIds,
          maxSlices: 3,
        });
        for (const slice of assembled.slices) {
          evidence.push({
            id: slice.chunkId,
            content: slice.text,
            sourceRef: slice.fileId,
          });
        }
      }
    }

    return this.compiler.compile({
      objective: `Analyse the ${input.focus} without promoting assertions or hypotheses to facts.`,
      tokenBudget: input.tokenBudget,
      policy: 'Epistemic classes are disjoint. Model output is inference, never fact.',
      evidence,
      outputContract: 'Return sourced notes. Do not state facts that are not already recorded as facts.',
    });
  }

  async listAliasCandidates(actor: InvestigationActor, caseId: string): Promise<AliasCandidate[]> {
    return (await this.deps.ledger.listKind(actor, caseId, EVIDENCE_KINDS.aliasCandidate)).map((row) =>
      aliasCandidateSchema.parse(row.payload),
    );
  }

  async listHypothesisTests(actor: InvestigationActor, caseId: string): Promise<HypothesisTest[]> {
    return (await this.deps.ledger.listKind(actor, caseId, EVIDENCE_KINDS.hypothesisTest)).map((row) =>
      hypothesisTestSchema.parse(row.payload),
    );
  }
}

function compareChronology(a: ChronologyItem, b: ChronologyItem): number {
  const aAt = timestampMs(a.occurredAt);
  const bAt = timestampMs(b.occurredAt);
  if (aAt !== null && bAt !== null && aAt !== bAt) return aAt - bAt;
  if (aAt !== null && bAt === null) return -1;
  if (aAt === null && bAt !== null) return 1;
  return a.id.localeCompare(b.id);
}

function idsMatch(leftA: string, rightA: string, leftB: string, rightB: string): boolean {
  return (leftA === leftB && rightA === rightB) || (leftA === rightB && rightA === leftB);
}

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/[._-]+/g, ' ').replace(/\s+/g, ' ');
}

function namesOf(entity: EvidenceEntity): string[] {
  return [entity.canonicalName, ...entity.aliases].map(normalise).filter(Boolean);
}

function aliasOverlap(left: EvidenceEntity, right: EvidenceEntity): string | null {
  const rightNames = new Set(namesOf(right));
  for (const name of namesOf(left)) {
    if (rightNames.has(name)) return name;
  }
  return null;
}

function sharedSurface(
  left: EvidenceEntity,
  right: EvidenceEntity,
  mentions: Array<{ entityId: string; surface: string }>,
): string | null {
  const leftNames = new Set(namesOf(left));
  for (const mention of mentions) {
    if (mention.entityId !== right.id) continue;
    if (leftNames.has(normalise(mention.surface))) return mention.surface;
  }
  const rightNames = new Set(namesOf(right));
  for (const mention of mentions) {
    if (mention.entityId !== left.id) continue;
    if (rightNames.has(normalise(mention.surface))) return mention.surface;
  }
  return null;
}

function mentionObjects(
  mentions: Array<{ entityId: string; evidenceObjectId: string }>,
  entityIds: string[],
): string[] {
  const wanted = new Set(entityIds);
  return [...new Set(mentions.filter((item) => wanted.has(item.entityId)).map((item) => item.evidenceObjectId))];
}

function namesInStatement(entity: EvidenceEntity, statement: string): boolean {
  const hay = normalise(statement);
  return namesOf(entity).some((name) => name.length > 1 && hay.includes(name));
}

function excerpt(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}…`;
}
