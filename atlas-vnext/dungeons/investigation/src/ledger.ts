import { createHash, randomUUID } from 'node:crypto';
import {
  claimSchema,
  contradictionSchema,
  emptySourceLocation,
  entityMentionSchema,
  entitySchema,
  evidenceEventSchema,
  evidenceLinkSchema,
  evidenceObjectSchema,
  evidenceSourceSchema,
  factSchema,
  findingSchema,
  hypothesisSchema,
  inferenceSchema,
  relationshipSchema,
  sourceAssertionSchema,
  type Contradiction,
  type EvidenceClaim,
  type EvidenceEntity,
  type EvidenceEvent,
  type EvidenceFinding,
  type EvidenceLink,
  type EvidenceObject,
  type EvidenceRelationship,
  type EvidenceSource,
  type EntityMention,
  type EpistemicClass,
  type Fact,
  type Hypothesis,
  type Inference,
  type SourceAssertion,
  type SourceLocation,
} from '@atlas-vnext/contracts';
import type { FilesService } from '@atlas-vnext/files';
import type { DungeonRecordRow, PersistenceActor, PlatformPersistence } from '@atlas-vnext/persistence';
import { AuthorityEngine, EffectivePolicyEngine } from '@atlas-vnext/permissions';
import type { ProjectService } from '@atlas-vnext/projects';
import { GENERIC_DENY, InvestigationError, type InvestigationActor } from './errors.ts';
import {
  assertEpistemicClassImmutable,
  assertFactLineage,
  assertFactProducer,
  kindToEpistemicClass,
  resolveEpistemicClass,
} from './epistemic.ts';

export const EVIDENCE_KINDS = {
  source: 'evidence_source',
  object: 'evidence_object',
  assertion: 'source_assertion',
  fact: 'fact',
  inference: 'inference',
  hypothesis: 'hypothesis',
  contradiction: 'contradiction',
  entity: 'entity',
  mention: 'entity_mention',
  event: 'event',
  relationship: 'relationship',
  claim: 'claim',
  link: 'evidence_link',
  finding: 'finding',
} as const;

type LedgerDeps = {
  persistence: PlatformPersistence;
  projects: ProjectService;
  files: FilesService;
  authority: AuthorityEngine;
  policy: EffectivePolicyEngine;
};

type CaseBind = { workspaceId: string; caseId: string };

/**
 * Durable evidential ledger over dungeon_records + Files/CAS/provenance.
 * Derived findings carry dependsOn + generation so a source change can stale
 * affected rows without regenerating the whole case.
 */
export class EvidenceLedger {
  constructor(
    private readonly deps: LedgerDeps,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  async attachSource(
    actor: InvestigationActor,
    input: {
      caseId: string;
      kind: EvidenceSource['kind'];
      title: string;
      fileId: string;
      acquiredFrom: string;
    },
  ): Promise<EvidenceSource> {
    const caseRow = await this.requireCase(actor, input.caseId, 'artifact.write');
    const file = await this.deps.files.getMetadata(actor, input.fileId);
    if (!file || file.workspaceId !== caseRow.workspaceId) {
      throw new InvestigationError('not_found', GENERIC_DENY, 404);
    }
    const source: EvidenceSource = {
      id: `evs_${randomUUID()}`,
      caseId: caseRow.id,
      kind: input.kind,
      title: input.title.trim() || file.displayName,
      fileId: file.id,
      originalCasHash: file.contentHash,
      acquiredFrom: input.acquiredFrom,
      acquiredAt: this.clock(),
      dependsOn: [],
      generation: 1,
      staleAt: null,
      staleReason: null,
    };
    await this.insert(actor, caseRow, EVIDENCE_KINDS.source, source.title, source, {
      artefactId: file.artefactId,
      contentHash: file.contentHash,
      parentId: caseRow.id,
    });
    await this.recordProvenance(actor, caseRow, file.artefactId ?? file.id, [file.id, file.contentHash, source.id]);
    return evidenceSourceSchema.parse(source);
  }

  async addObject(
    actor: InvestigationActor,
    input: {
      sourceId: string;
      kind: EvidenceObject['kind'];
      title: string;
      text: string;
      extractionCasHash?: string | null;
      sourceLocation?: SourceLocation;
    },
  ): Promise<EvidenceObject> {
    const sourceRow = await this.requireKind(actor, input.sourceId, EVIDENCE_KINDS.source, 'artifact.write');
    const source = evidenceSourceSchema.parse(sourceRow.payload);
    const caseRow = await this.requireCase(actor, source.caseId, 'artifact.write');
    const extraction = input.extractionCasHash ?? hashText(input.text);
    if (extraction === source.originalCasHash && input.text.length > 0) {
      // Original bytes may equal a short extraction only by coincidence; still
      // require an explicit original vs derived distinction when hashes match
      // and the caller claimed a derived object.
    }
    const object: EvidenceObject = {
      id: `evo_${randomUUID()}`,
      caseId: caseRow.id,
      sourceId: source.id,
      kind: input.kind,
      title: input.title.trim() || source.title,
      originalCasHash: source.originalCasHash,
      extractionCasHash: extraction === source.originalCasHash ? null : extraction,
      sourceLocation: input.sourceLocation ?? {
        ...emptySourceLocation(),
        fileId: source.fileId,
        casHash: source.originalCasHash,
        path: null,
      },
      text: input.text,
      dependsOn: [source.id],
      generation: source.generation,
      staleAt: null,
      staleReason: null,
    };
    await this.insert(actor, caseRow, EVIDENCE_KINDS.object, object.title, object, {
      contentHash: object.extractionCasHash ?? object.originalCasHash,
      parentId: source.id,
    });
    return evidenceObjectSchema.parse(object);
  }

  async recordAssertion(
    actor: InvestigationActor,
    input: {
      evidenceObjectId: string;
      statement: string;
      assertedBy: string;
      producer?: SourceAssertion['producer'];
      sourceLocation?: SourceLocation;
    },
  ): Promise<SourceAssertion> {
    const objectRow = await this.requireKind(actor, input.evidenceObjectId, EVIDENCE_KINDS.object, 'artifact.write');
    const object = evidenceObjectSchema.parse(objectRow.payload);
    const caseRow = await this.requireCase(actor, object.caseId, 'artifact.write');
    const assertion: SourceAssertion = {
      id: `asr_${randomUUID()}`,
      caseId: caseRow.id,
      epistemicClass: 'source_assertion',
      statement: input.statement,
      assertedBy: input.assertedBy,
      evidenceObjectId: object.id,
      producer: input.producer ?? 'human',
      sourceLocation: input.sourceLocation ?? object.sourceLocation,
      dependsOn: [object.id, object.sourceId],
      generation: object.generation,
      staleAt: null,
      staleReason: null,
    };
    await this.insert(actor, caseRow, EVIDENCE_KINDS.assertion, assertion.statement, assertion, {
      parentId: object.id,
    });
    return sourceAssertionSchema.parse(assertion);
  }

  async recordFact(
    actor: InvestigationActor,
    input: {
      caseId: string;
      statement: string;
      producer: Fact['producer'];
      corroboratedBy: string[];
      sourceLocation?: SourceLocation;
    },
  ): Promise<Fact> {
    assertFactProducer(input.producer);
    const caseRow = await this.requireCase(actor, input.caseId, 'artifact.write');
    if (input.corroboratedBy.length < 1) {
      throw new InvestigationError('malformed', 'A fact requires at least one corroborating record.');
    }
    const sources = await Promise.all(
      input.corroboratedBy.map((id) => this.requireAny(actor, id, 'artifact.read', this.caseBind(caseRow))),
    );
    const classes = await this.collectLineageClasses(actor, input.corroboratedBy, this.caseBind(caseRow));
    assertFactLineage(classes);
    const dependsOn = unique([
      ...input.corroboratedBy,
      ...sources.flatMap((row) => asStringArray(row.payload.dependsOn)),
    ]);
    const fact: Fact = {
      id: `fct_${randomUUID()}`,
      caseId: caseRow.id,
      epistemicClass: 'fact',
      statement: input.statement,
      producer: input.producer,
      corroboratedBy: input.corroboratedBy,
      sourceLocation: input.sourceLocation ?? emptySourceLocation(),
      dependsOn,
      generation: maxGeneration(sources),
      staleAt: null,
      staleReason: null,
    };
    await this.insert(actor, caseRow, EVIDENCE_KINDS.fact, fact.statement, fact);
    return factSchema.parse(fact);
  }

  async recordInference(
    actor: InvestigationActor,
    input: {
      caseId: string;
      statement: string;
      producer: Inference['producer'];
      dependsOn: string[];
      sourceLocation?: SourceLocation;
    },
  ): Promise<Inference> {
    const caseRow = await this.requireCase(actor, input.caseId, 'artifact.write');
    await this.requirePeers(actor, input.dependsOn, 'artifact.read', this.caseBind(caseRow));
    const inference: Inference = {
      id: `inf_${randomUUID()}`,
      caseId: caseRow.id,
      epistemicClass: 'inference',
      statement: input.statement,
      producer: input.producer,
      sourceLocation: input.sourceLocation ?? emptySourceLocation(),
      dependsOn: input.dependsOn,
      generation: 1,
      staleAt: null,
      staleReason: null,
    };
    await this.insert(actor, caseRow, EVIDENCE_KINDS.inference, inference.statement, inference);
    return inferenceSchema.parse(inference);
  }

  async recordHypothesis(
    actor: InvestigationActor,
    input: {
      caseId: string;
      statement: string;
      producer?: Hypothesis['producer'];
      status?: Hypothesis['status'];
      dependsOn?: string[];
    },
  ): Promise<Hypothesis> {
    const caseRow = await this.requireCase(actor, input.caseId, 'artifact.write');
    await this.requirePeers(actor, input.dependsOn ?? [], 'artifact.read', this.caseBind(caseRow));
    const hypothesis: Hypothesis = {
      id: `hyp_${randomUUID()}`,
      caseId: caseRow.id,
      epistemicClass: 'hypothesis',
      statement: input.statement,
      producer: input.producer ?? 'human',
      status: input.status ?? 'open',
      sourceLocation: emptySourceLocation(),
      dependsOn: input.dependsOn ?? [],
      generation: 1,
      staleAt: null,
      staleReason: null,
    };
    await this.insert(actor, caseRow, EVIDENCE_KINDS.hypothesis, hypothesis.statement, hypothesis);
    return hypothesisSchema.parse(hypothesis);
  }

  async recordContradiction(
    actor: InvestigationActor,
    input: { caseId: string; leftId: string; rightId: string; statement: string },
  ): Promise<Contradiction> {
    const caseRow = await this.requireCase(actor, input.caseId, 'artifact.write');
    const bind = this.caseBind(caseRow);
    const left = await this.requireAny(actor, input.leftId, 'artifact.read', bind);
    const right = await this.requireAny(actor, input.rightId, 'artifact.read', bind);
    const contradiction: Contradiction = {
      id: `ctr_${randomUUID()}`,
      caseId: caseRow.id,
      epistemicClass: 'contradiction',
      statement: input.statement,
      producer: 'deterministic',
      leftId: left.id,
      rightId: right.id,
      sourceLocation: emptySourceLocation(),
      dependsOn: unique([left.id, right.id, ...asStringArray(left.payload.dependsOn), ...asStringArray(right.payload.dependsOn)]),
      generation: Math.max(number(left.payload.generation), number(right.payload.generation)),
      staleAt: null,
      staleReason: null,
    };
    await this.insert(actor, caseRow, EVIDENCE_KINDS.contradiction, contradiction.statement, contradiction);
    return contradictionSchema.parse(contradiction);
  }

  async addEntity(
    actor: InvestigationActor,
    input: {
      caseId: string;
      kind: EvidenceEntity['kind'];
      canonicalName: string;
      aliases?: string[];
      status?: EvidenceEntity['status'];
    },
  ): Promise<EvidenceEntity> {
    const caseRow = await this.requireCase(actor, input.caseId, 'artifact.write');
    const entity: EvidenceEntity = {
      id: `ent_${randomUUID()}`,
      caseId: caseRow.id,
      kind: input.kind,
      canonicalName: input.canonicalName,
      aliases: input.aliases ?? [],
      status: input.status ?? 'unresolved',
      dependsOn: [],
      generation: 1,
      staleAt: null,
      staleReason: null,
    };
    await this.insert(actor, caseRow, EVIDENCE_KINDS.entity, entity.canonicalName, entity);
    return entitySchema.parse(entity);
  }

  async addMention(
    actor: InvestigationActor,
    input: { entityId: string; evidenceObjectId: string; surface: string; sourceLocation?: SourceLocation },
  ): Promise<EntityMention> {
    const entityRow = await this.requireKind(actor, input.entityId, EVIDENCE_KINDS.entity, 'artifact.write');
    const entity = entitySchema.parse(entityRow.payload);
    const caseRow = await this.requireCase(actor, entity.caseId, 'artifact.write');
    const objectRow = await this.requireKind(
      actor,
      input.evidenceObjectId,
      EVIDENCE_KINDS.object,
      'artifact.read',
      this.caseBind(caseRow),
    );
    const object = evidenceObjectSchema.parse(objectRow.payload);
    const mention: EntityMention = {
      id: `emn_${randomUUID()}`,
      caseId: caseRow.id,
      entityId: entity.id,
      evidenceObjectId: object.id,
      surface: input.surface,
      sourceLocation: input.sourceLocation ?? object.sourceLocation,
      dependsOn: [entity.id, object.id, object.sourceId],
      generation: object.generation,
      staleAt: null,
      staleReason: null,
    };
    await this.insert(actor, caseRow, EVIDENCE_KINDS.mention, mention.surface, mention, { parentId: entity.id });
    return entityMentionSchema.parse(mention);
  }

  async addEvent(
    actor: InvestigationActor,
    input: {
      caseId: string;
      description: string;
      occurredAt: string | null;
      occurredAtPrecision: EvidenceEvent['occurredAtPrecision'];
      epistemicClass: EvidenceEvent['epistemicClass'];
      evidenceObjectIds?: string[];
    },
  ): Promise<EvidenceEvent> {
    const caseRow = await this.requireCase(actor, input.caseId, 'artifact.write');
    await this.requirePeers(actor, input.evidenceObjectIds ?? [], 'artifact.read', this.caseBind(caseRow));
    const event: EvidenceEvent = {
      id: `evt_${randomUUID()}`,
      caseId: caseRow.id,
      description: input.description,
      occurredAt: input.occurredAt,
      occurredAtPrecision: input.occurredAtPrecision,
      epistemicClass: input.epistemicClass,
      evidenceObjectIds: input.evidenceObjectIds ?? [],
      dependsOn: input.evidenceObjectIds ?? [],
      generation: 1,
      staleAt: null,
      staleReason: null,
    };
    await this.insert(actor, caseRow, EVIDENCE_KINDS.event, event.description, event);
    return evidenceEventSchema.parse(event);
  }

  async addRelationship(
    actor: InvestigationActor,
    input: {
      caseId: string;
      fromEntityId: string;
      toEntityId: string;
      kind: string;
      epistemicClass: EvidenceRelationship['epistemicClass'];
    },
  ): Promise<EvidenceRelationship> {
    const caseRow = await this.requireCase(actor, input.caseId, 'artifact.write');
    const bind = this.caseBind(caseRow);
    await this.requireKind(actor, input.fromEntityId, EVIDENCE_KINDS.entity, 'artifact.read', bind);
    await this.requireKind(actor, input.toEntityId, EVIDENCE_KINDS.entity, 'artifact.read', bind);
    const relationship: EvidenceRelationship = {
      id: `rel_${randomUUID()}`,
      caseId: caseRow.id,
      fromEntityId: input.fromEntityId,
      toEntityId: input.toEntityId,
      kind: input.kind,
      epistemicClass: input.epistemicClass,
      dependsOn: [input.fromEntityId, input.toEntityId],
      generation: 1,
      staleAt: null,
      staleReason: null,
    };
    await this.insert(actor, caseRow, EVIDENCE_KINDS.relationship, relationship.kind, relationship);
    return relationshipSchema.parse(relationship);
  }

  async addClaim(
    actor: InvestigationActor,
    input: { caseId: string; statement: string; kind: EvidenceClaim['kind'] },
  ): Promise<EvidenceClaim> {
    const caseRow = await this.requireCase(actor, input.caseId, 'artifact.write');
    const claim: EvidenceClaim = {
      id: `clm_${randomUUID()}`,
      caseId: caseRow.id,
      statement: input.statement,
      kind: input.kind,
      dependsOn: [],
      generation: 1,
      staleAt: null,
      staleReason: null,
    };
    await this.insert(actor, caseRow, EVIDENCE_KINDS.claim, claim.statement, claim);
    return claimSchema.parse(claim);
  }

  async link(
    actor: InvestigationActor,
    input: { caseId: string; fromId: string; toId: string; role: EvidenceLink['role'] },
  ): Promise<EvidenceLink> {
    const caseRow = await this.requireCase(actor, input.caseId, 'artifact.write');
    const bind = this.caseBind(caseRow);
    await this.requireAny(actor, input.fromId, 'artifact.read', bind);
    await this.requireAny(actor, input.toId, 'artifact.read', bind);
    const link: EvidenceLink = {
      id: `lnk_${randomUUID()}`,
      caseId: caseRow.id,
      fromId: input.fromId,
      toId: input.toId,
      role: input.role,
      dependsOn: [input.fromId, input.toId],
      generation: 1,
      staleAt: null,
      staleReason: null,
    };
    await this.insert(actor, caseRow, EVIDENCE_KINDS.link, `${input.role}:${input.fromId}:${input.toId}`, link);
    return evidenceLinkSchema.parse(link);
  }

  async recordFinding(
    actor: InvestigationActor,
    input: { caseId: string; statement: string; epistemicClass: EpistemicClass; linkedIds: string[] },
  ): Promise<EvidenceFinding> {
    const caseRow = await this.requireCase(actor, input.caseId, 'artifact.write');
    const bind = this.caseBind(caseRow);
    await this.requirePeers(actor, input.linkedIds, 'artifact.read', bind);
    if (input.epistemicClass === 'fact') {
      assertFactLineage(await this.collectLineageClasses(actor, input.linkedIds, bind));
    }
    const finding: EvidenceFinding = {
      id: `fnd_${randomUUID()}`,
      caseId: caseRow.id,
      statement: input.statement,
      epistemicClass: input.epistemicClass,
      linkedIds: input.linkedIds,
      dependsOn: input.linkedIds,
      generation: 1,
      staleAt: null,
      staleReason: null,
    };
    await this.insert(actor, caseRow, EVIDENCE_KINDS.finding, finding.statement, finding, { parentId: caseRow.id });
    return findingSchema.parse(finding);
  }

  /**
   * Refuses to rewrite class. Callers must insert a new record.
   */
  async reclassify(_actor: InvestigationActor, _id: string, _next: EpistemicClass): Promise<never> {
    throw new InvestigationError(
      'epistemic_immutable',
      'Epistemic class cannot be changed. Record a new object with its own provenance.',
    );
  }

  async bumpSourceGeneration(actor: InvestigationActor, sourceId: string): Promise<{ staleIds: string[] }> {
    const sourceRow = await this.requireKind(actor, sourceId, EVIDENCE_KINDS.source, 'artifact.write');
    const source = evidenceSourceSchema.parse(sourceRow.payload);
    const caseRow = await this.requireCase(actor, source.caseId, 'artifact.write');
    const nextGeneration = source.generation + 1;
    const now = this.clock();
    await this.patchPayload(actor, sourceRow, { ...source, generation: nextGeneration });
    const derived = await this.listCase(actor, caseRow.id);
    const staleIds: string[] = [];
    const frontier = new Set<string>([source.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const row of derived) {
        if (row.id === source.id || frontier.has(row.id)) continue;
        const payload = row.payload;
        const dependsOn = asStringArray(payload.dependsOn);
        const payloadSourceId = typeof payload.sourceId === 'string' ? payload.sourceId : null;
        if (payloadSourceId && frontier.has(payloadSourceId)) {
          frontier.add(row.id);
          grew = true;
          continue;
        }
        if (dependsOn.some((id) => frontier.has(id))) {
          frontier.add(row.id);
          grew = true;
        }
      }
    }
    for (const row of derived) {
      if (row.id === source.id || !frontier.has(row.id)) continue;
      const currentClass = kindToEpistemicClass(row.kind);
      if (currentClass && typeof row.payload.epistemicClass === 'string') {
        assertEpistemicClassImmutable(currentClass, row.payload.epistemicClass as EpistemicClass);
      }
      await this.patchPayload(actor, row, {
        ...row.payload,
        staleAt: now,
        staleReason: `source ${source.id} generation ${nextGeneration}`,
      });
      staleIds.push(row.id);
    }
    return { staleIds };
  }

  async duplicatesByOriginalHash(actor: InvestigationActor, caseId: string): Promise<Map<string, EvidenceObject[]>> {
    await this.requireCase(actor, caseId, 'artifact.read');
    const objects = (await this.listKind(actor, caseId, EVIDENCE_KINDS.object)).map((row) =>
      evidenceObjectSchema.parse(row.payload),
    );
    const groups = new Map<string, EvidenceObject[]>();
    for (const object of objects) {
      const list = groups.get(object.originalCasHash) ?? [];
      list.push(object);
      groups.set(object.originalCasHash, list);
    }
    for (const [hash, list] of groups) {
      if (list.length < 2) groups.delete(hash);
    }
    return groups;
  }

  async chronology(actor: InvestigationActor, caseId: string): Promise<EvidenceEvent[]> {
    await this.requireCase(actor, caseId, 'artifact.read');
    const events = (await this.listKind(actor, caseId, EVIDENCE_KINDS.event)).map((row) =>
      evidenceEventSchema.parse(row.payload),
    );
    return events.sort((a, b) => {
      const aAt = timestampMs(a.occurredAt);
      const bAt = timestampMs(b.occurredAt);
      if (aAt !== null && bAt !== null && aAt !== bAt) return aAt - bAt;
      if (aAt !== null && bAt === null) return -1;
      if (aAt === null && bAt !== null) return 1;
      return a.id.localeCompare(b.id);
    });
  }

  async listKind(actor: InvestigationActor, caseId: string, kind: string): Promise<DungeonRecordRow[]> {
    const caseRow = await this.requireCase(actor, caseId, 'artifact.read');
    const rows = await this.store(actor).list(actor, {
      workspaceId: caseRow.workspaceId,
      dungeon: 'investigation',
      kind,
    });
    return rows.filter((row) => row.payload.caseId === caseId);
  }

  async listCase(actor: InvestigationActor, caseId: string): Promise<DungeonRecordRow[]> {
    const caseRow = await this.requireCase(actor, caseId, 'artifact.read');
    const rows = await this.store(actor).list(actor, {
      workspaceId: caseRow.workspaceId,
      dungeon: 'investigation',
    });
    return rows.filter((row) => row.id === caseId || row.payload.caseId === caseId || row.parentId === caseId);
  }

  private async insert(
    actor: InvestigationActor,
    caseRow: DungeonRecordRow,
    kind: string,
    title: string,
    payload: Record<string, unknown> & { id: string },
    extra: { artefactId?: string | null; contentHash?: string | null; parentId?: string | null } = {},
  ): Promise<DungeonRecordRow> {
    return this.store(actor).create(actor, {
      id: payload.id,
      workspaceId: caseRow.workspaceId,
      dungeon: 'investigation',
      kind,
      title: title.slice(0, 180) || kind,
      status: 'completed',
      payload,
      artefactId: extra.artefactId ?? null,
      contentHash: extra.contentHash ?? null,
      parentId: extra.parentId ?? caseRow.id,
    });
  }

  private async patchPayload(actor: InvestigationActor, row: DungeonRecordRow, payload: Record<string, unknown>) {
    const currentClass = kindToEpistemicClass(row.kind);
    const nextClass = typeof payload.epistemicClass === 'string' ? kindToEpistemicClass(String(payload.epistemicClass)) : currentClass;
    if (currentClass && nextClass) assertEpistemicClassImmutable(currentClass, nextClass);
    await this.store(actor).update(actor, row.id, { payload, expectedRevision: row.revision });
  }

  private async recordProvenance(actor: InvestigationActor, caseRow: DungeonRecordRow, artefactId: string, sourceInputs: string[]) {
    const projectId = caseRow.workspaceId;
    if (!projectId) return;
    await this.deps.persistence.forActor(actor).provenance.record({
      artefactId,
      projectId,
      sourceInputs,
      inputManifestHash: null,
      provider: 'atlas.investigation',
      model: 'deterministic',
      toolCalls: [],
      jobId: null,
      timestamp: this.clock(),
      traceId: `investigation:${caseRow.id}:${artefactId}`,
      capability: 'investigation',
    });
  }

  private async requireCase(actor: InvestigationActor, id: string, capability: 'artifact.read' | 'artifact.write') {
    const row = await this.store(actor).get(actor, id);
    if (!row || row.dungeon !== 'investigation' || row.kind !== 'case') {
      throw new InvestigationError('not_found', GENERIC_DENY, 404);
    }
    this.authorize(actor, capability, row.workspaceId ?? row.id, row.tenantId);
    return row;
  }

  private async requireKind(
    actor: InvestigationActor,
    id: string,
    kind: string,
    capability: 'artifact.read' | 'artifact.write',
    bind?: CaseBind,
  ) {
    const row = await this.requireAny(actor, id, capability, bind);
    if (row.kind !== kind) throw new InvestigationError('malformed', `Expected ${kind}.`);
    return row;
  }

  private async requireAny(
    actor: InvestigationActor,
    id: string,
    capability: 'artifact.read' | 'artifact.write',
    bind?: CaseBind,
  ) {
    const row = await this.store(actor).get(actor, id);
    if (!row || row.dungeon !== 'investigation') throw new InvestigationError('not_found', GENERIC_DENY, 404);
    this.authorize(actor, capability, row.workspaceId ?? row.id, row.tenantId);
    if (bind) this.assertBound(row, bind);
    return row;
  }

  private caseBind(caseRow: DungeonRecordRow): CaseBind {
    return { workspaceId: caseRow.workspaceId ?? caseRow.id, caseId: caseRow.id };
  }

  private assertBound(row: DungeonRecordRow, bind: CaseBind): void {
    if ((row.workspaceId ?? row.id) !== bind.workspaceId) {
      throw new InvestigationError('not_found', GENERIC_DENY, 404);
    }
    this.assertSameCase(row, bind.caseId);
  }

  private async requirePeers(
    actor: InvestigationActor,
    ids: string[],
    capability: 'artifact.read' | 'artifact.write',
    bind: CaseBind,
  ): Promise<DungeonRecordRow[]> {
    return Promise.all(ids.map((id) => this.requireAny(actor, id, capability, bind)));
  }

  private assertSameCase(row: DungeonRecordRow, caseId: string): void {
    const rowCaseId = typeof row.payload.caseId === 'string' ? row.payload.caseId : row.id;
    if (rowCaseId !== caseId) {
      throw new InvestigationError('not_found', GENERIC_DENY, 404);
    }
  }

  private async collectLineageClasses(
    actor: InvestigationActor,
    ids: string[],
    bind: CaseBind,
  ): Promise<EpistemicClass[]> {
    const classes: EpistemicClass[] = [];
    const seen = new Set<string>();
    const queue = [...ids];
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const row = await this.requireAny(actor, id, 'artifact.read', bind);
      const resolved = resolveEpistemicClass(row.kind, row.payload);
      if (resolved) classes.push(resolved);
      for (const dep of asStringArray(row.payload.dependsOn)) {
        if (!seen.has(dep)) queue.push(dep);
      }
    }
    return classes;
  }

  private store(actor: PersistenceActor) {
    return this.deps.persistence.forActor(actor).dungeonRecords;
  }

  private authorize(
    actor: InvestigationActor,
    capability: 'artifact.read' | 'artifact.write',
    workspaceId: string,
    tenantId: string,
  ) {
    if (!actor.tenantId || !actor.principalId) throw new InvestigationError('permission_denied', GENERIC_DENY, 401);
    const verdict = this.deps.authority.decide({
      principal: { principalId: actor.principalId, kind: 'user', tenantId: actor.tenantId, workspaceId },
      capability,
      resource: { type: 'artifact', id: workspaceId, tenantId, workspaceId },
    });
    if (verdict.decision !== 'ALLOW') throw new InvestigationError('permission_denied', GENERIC_DENY, 404);
  }
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 1;
}

function maxGeneration(rows: DungeonRecordRow[]): number {
  return rows.reduce((max, row) => Math.max(max, number(row.payload.generation)), 1);
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

function timestampMs(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
