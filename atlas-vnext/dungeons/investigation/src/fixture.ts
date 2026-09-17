import type { InvestigationService } from './index.ts';
import { EvidenceLedger } from './ledger.ts';
import type { InvestigationActor } from './errors.ts';
import type { FilesService } from '@atlas-vnext/files';

export interface HarbourFixture {
  caseId: string;
  fileIds: Record<string, string>;
  sourceIds: Record<string, string>;
  objectIds: Record<string, string>;
  entityIds: Record<string, string>;
  assertionIds: Record<string, string>;
  factId: string;
  contradictionId: string;
  hypothesisId: string;
  inferenceId: string;
  findingIds: Record<string, string>;
}

/**
 * Long-term regression estate: Harbour Logistics missing invoice.
 * Mixed people, messages, calls, documents, a duplicate, timestamps,
 * an ambiguous identity, one corroborated fact, one contradiction,
 * and one unsupported hypothesis.
 */
export async function loadHarbourFixture(
  actor: InvestigationActor,
  input: {
    investigation: InvestigationService;
    ledger: EvidenceLedger;
    files: FilesService;
    projectId: string;
  },
): Promise<HarbourFixture> {
  const created = await input.investigation.createCase(actor, {
    projectId: input.projectId,
    title: 'Harbour Logistics — missing invoice HL-4419',
    question: 'Was invoice HL-4419 delivered, and if so when and by whom?',
  });

  const bytes = {
    messages: encode(`# Slack export — #ops-harbour
2026-03-12T09:04:11Z jordanh: I'll drop HL-4419 at the east quay this afternoon.
2026-03-12T09:05:02Z maya.chen: Copy. Finance needs it before close.
2026-03-13T08:12:44Z maya.chen: Jordan delivered Friday 14:00. Priya, please post.
2026-03-13T08:14:01Z priya.shah: I have not seen HL-4419 on the tray.
`),
    calls: encode(`CALL 2026-03-12T16:18:00Z Maya Chen -> J. Hale
Maya: Confirming you are on site with the invoice.
Hale: I'm at the barrier now. Thursday 16:30 handoff.
`),
    invoice: encode('INVOICE HL-4419\nPayee: Harbour Logistics\nAmount: 4,400.00\nBearer: Jordan Hale\n'),
    invoiceCopy: encode('INVOICE HL-4419\nPayee: Harbour Logistics\nAmount: 4,400.00\nBearer: Jordan Hale\n'),
    swipe: encode('2026-03-12T16:22:08Z SWIPE jordan.hale EAST-QUAY-GATE\n'),
    gps: encode('2026-03-12T16:22:40Z device:jordanh lat:51.507 lon:-0.075 loc:east-quay\n'),
    delivery: encode('Delivery note HL-4419 unsigned. Clerk: Alex Rivera.\n'),
  };

  const files = {
    messages: await input.files.ingest(actor, {
      projectId: input.projectId,
      path: 'exports/slack-ops-harbour.md',
      bytes: bytes.messages,
    }),
    calls: await input.files.ingest(actor, {
      projectId: input.projectId,
      path: 'exports/call-maya-hale.txt',
      bytes: bytes.calls,
    }),
    invoice: await input.files.ingest(actor, {
      projectId: input.projectId,
      path: 'docs/HL-4419.pdf.txt',
      bytes: bytes.invoice,
    }),
    invoiceCopy: await input.files.ingest(actor, {
      projectId: input.projectId,
      path: 'docs/HL-4419-scan.pdf.txt',
      bytes: bytes.invoiceCopy,
    }),
    swipe: await input.files.ingest(actor, {
      projectId: input.projectId,
      path: 'exports/swipe-log.txt',
      bytes: bytes.swipe,
    }),
    gps: await input.files.ingest(actor, {
      projectId: input.projectId,
      path: 'exports/device-gps.csv',
      bytes: bytes.gps,
    }),
    delivery: await input.files.ingest(actor, {
      projectId: input.projectId,
      path: 'docs/delivery-note.txt',
      bytes: bytes.delivery,
    }),
  };

  const sources = {
    messages: await input.ledger.attachSource(actor, {
      caseId: created.id,
      kind: 'message_export',
      title: 'Slack #ops-harbour',
      fileId: files.messages.id,
      acquiredFrom: 'synthetic-fixture',
    }),
    calls: await input.ledger.attachSource(actor, {
      caseId: created.id,
      kind: 'call_record',
      title: 'Maya / J. Hale call',
      fileId: files.calls.id,
      acquiredFrom: 'synthetic-fixture',
    }),
    invoice: await input.ledger.attachSource(actor, {
      caseId: created.id,
      kind: 'document',
      title: 'Invoice HL-4419',
      fileId: files.invoice.id,
      acquiredFrom: 'synthetic-fixture',
    }),
    invoiceCopy: await input.ledger.attachSource(actor, {
      caseId: created.id,
      kind: 'document',
      title: 'Invoice HL-4419 duplicate scan',
      fileId: files.invoiceCopy.id,
      acquiredFrom: 'synthetic-fixture',
    }),
    swipe: await input.ledger.attachSource(actor, {
      caseId: created.id,
      kind: 'structured_export',
      title: 'East quay swipe log',
      fileId: files.swipe.id,
      acquiredFrom: 'synthetic-fixture',
    }),
    gps: await input.ledger.attachSource(actor, {
      caseId: created.id,
      kind: 'device_derived',
      title: 'Device GPS export',
      fileId: files.gps.id,
      acquiredFrom: 'synthetic-fixture',
    }),
    delivery: await input.ledger.attachSource(actor, {
      caseId: created.id,
      kind: 'document',
      title: 'Delivery note',
      fileId: files.delivery.id,
      acquiredFrom: 'synthetic-fixture',
    }),
  };

  const objects = {
    messages: await input.ledger.addObject(actor, {
      sourceId: sources.messages.id,
      kind: 'message',
      title: 'Slack thread',
      text: new TextDecoder().decode(bytes.messages),
    }),
    calls: await input.ledger.addObject(actor, {
      sourceId: sources.calls.id,
      kind: 'call_record',
      title: 'Call transcript',
      text: new TextDecoder().decode(bytes.calls),
    }),
    invoice: await input.ledger.addObject(actor, {
      sourceId: sources.invoice.id,
      kind: 'document',
      title: 'Invoice body',
      text: new TextDecoder().decode(bytes.invoice),
    }),
    invoiceCopy: await input.ledger.addObject(actor, {
      sourceId: sources.invoiceCopy.id,
      kind: 'document',
      title: 'Invoice duplicate body',
      text: new TextDecoder().decode(bytes.invoiceCopy),
    }),
    swipe: await input.ledger.addObject(actor, {
      sourceId: sources.swipe.id,
      kind: 'structured_row',
      title: 'Swipe row',
      text: new TextDecoder().decode(bytes.swipe),
    }),
    gps: await input.ledger.addObject(actor, {
      sourceId: sources.gps.id,
      kind: 'metadata',
      title: 'GPS point',
      text: new TextDecoder().decode(bytes.gps),
    }),
    delivery: await input.ledger.addObject(actor, {
      sourceId: sources.delivery.id,
      kind: 'document',
      title: 'Delivery note body',
      text: new TextDecoder().decode(bytes.delivery),
    }),
  };

  const entities = {
    maya: await input.ledger.addEntity(actor, {
      caseId: created.id,
      kind: 'person',
      canonicalName: 'Maya Chen',
      aliases: ['maya.chen'],
      status: 'resolved',
    }),
    jordan: await input.ledger.addEntity(actor, {
      caseId: created.id,
      kind: 'person',
      canonicalName: 'Jordan Hale',
      aliases: ['J. Hale', 'jordanh', 'jordan.hale'],
      status: 'ambiguous',
    }),
    priya: await input.ledger.addEntity(actor, {
      caseId: created.id,
      kind: 'person',
      canonicalName: 'Priya Shah',
      aliases: ['priya.shah'],
      status: 'resolved',
    }),
    alex: await input.ledger.addEntity(actor, {
      caseId: created.id,
      kind: 'person',
      canonicalName: 'Alex Rivera',
      aliases: [],
      status: 'unresolved',
    }),
  };

  await input.ledger.addMention(actor, {
    entityId: entities.jordan.id,
    evidenceObjectId: objects.messages.id,
    surface: 'jordanh',
  });
  await input.ledger.addMention(actor, {
    entityId: entities.jordan.id,
    evidenceObjectId: objects.calls.id,
    surface: 'J. Hale',
  });
  await input.ledger.addMention(actor, {
    entityId: entities.maya.id,
    evidenceObjectId: objects.messages.id,
    surface: 'maya.chen',
  });
  await input.ledger.addMention(actor, {
    entityId: entities.alex.id,
    evidenceObjectId: objects.delivery.id,
    surface: 'Alex Rivera',
  });

  const mayaFriday = await input.ledger.recordAssertion(actor, {
    evidenceObjectId: objects.messages.id,
    assertedBy: 'Maya Chen',
    statement: 'Jordan delivered HL-4419 on Friday at 14:00.',
  });
  const haleThursday = await input.ledger.recordAssertion(actor, {
    evidenceObjectId: objects.calls.id,
    assertedBy: 'J. Hale',
    statement: 'Handoff was Thursday at 16:30.',
  });
  const swipeAssert = await input.ledger.recordAssertion(actor, {
    evidenceObjectId: objects.swipe.id,
    assertedBy: 'swipe-log',
    producer: 'deterministic',
    statement: 'jordan.hale badge at east quay 2026-03-12T16:22:08Z.',
  });
  const gpsAssert = await input.ledger.recordAssertion(actor, {
    evidenceObjectId: objects.gps.id,
    assertedBy: 'device-gps',
    producer: 'deterministic',
    statement: 'Device jordanh at east quay 2026-03-12T16:22:40Z.',
  });

  const presenceFact = await input.ledger.recordFact(actor, {
    caseId: created.id,
    statement: 'A person using the Jordan Hale identifiers was at the east quay on Thursday 12 March 2026 around 16:22.',
    producer: 'deterministic',
    corroboratedBy: [swipeAssert.id, gpsAssert.id],
  });

  const contradiction = await input.ledger.recordContradiction(actor, {
    caseId: created.id,
    leftId: mayaFriday.id,
    rightId: haleThursday.id,
    statement: 'Maya asserts Friday 14:00 delivery; J. Hale asserts Thursday 16:30 handoff.',
  });

  const hypothesis = await input.ledger.recordHypothesis(actor, {
    caseId: created.id,
    statement: 'Priya Shah deleted invoice HL-4419.',
    status: 'unsupported',
  });

  const inference = await input.ledger.recordInference(actor, {
    caseId: created.id,
    statement: 'jordanh, J. Hale, and Jordan Hale likely refer to one person, but the identity remains ambiguous.',
    producer: 'model',
    dependsOn: [entities.jordan.id, objects.messages.id, objects.calls.id],
  });

  await input.ledger.addEvent(actor, {
    caseId: created.id,
    description: 'Jordan Hale identifiers at east quay gate',
    occurredAt: '2026-03-12T16:22:08Z',
    occurredAtPrecision: 'datetime',
    epistemicClass: 'fact',
    evidenceObjectIds: [objects.swipe.id, objects.gps.id],
  });
  await input.ledger.addEvent(actor, {
    caseId: created.id,
    description: 'Maya claims Friday delivery',
    occurredAt: '2026-03-13T08:12:44Z',
    occurredAtPrecision: 'datetime',
    epistemicClass: 'source_assertion',
    evidenceObjectIds: [objects.messages.id],
  });
  await input.ledger.addEvent(actor, {
    caseId: created.id,
    description: 'Call asserts Thursday 16:30 handoff',
    occurredAt: '2026-03-12T16:18:00Z',
    occurredAtPrecision: 'datetime',
    epistemicClass: 'source_assertion',
    evidenceObjectIds: [objects.calls.id],
  });

  await input.ledger.addRelationship(actor, {
    caseId: created.id,
    fromEntityId: entities.maya.id,
    toEntityId: entities.jordan.id,
    kind: 'called',
    epistemicClass: 'source_assertion',
  });
  await input.ledger.addClaim(actor, {
    caseId: created.id,
    kind: 'allegation',
    statement: 'Invoice HL-4419 was not posted to finance.',
  });

  const factFinding = await input.ledger.recordFinding(actor, {
    caseId: created.id,
    statement: 'Presence at east quay on Thursday afternoon is corroborated by swipe log and GPS export.',
    epistemicClass: 'fact',
    linkedIds: [presenceFact.id, swipeAssert.id, gpsAssert.id],
  });
  const contradictionFinding = await input.ledger.recordFinding(actor, {
    caseId: created.id,
    statement: 'Delivery weekday is contradicted across Maya’s message and the Hale call.',
    epistemicClass: 'contradiction',
    linkedIds: [contradiction.id, mayaFriday.id, haleThursday.id],
  });

  await input.ledger.link(actor, {
    caseId: created.id,
    fromId: swipeAssert.id,
    toId: gpsAssert.id,
    role: 'corroborates',
  });
  await input.ledger.link(actor, {
    caseId: created.id,
    fromId: mayaFriday.id,
    toId: haleThursday.id,
    role: 'contradicts',
  });

  return {
    caseId: created.id,
    fileIds: Object.fromEntries(Object.entries(files).map(([key, file]) => [key, file.id])),
    sourceIds: Object.fromEntries(Object.entries(sources).map(([key, row]) => [key, row.id])),
    objectIds: Object.fromEntries(Object.entries(objects).map(([key, row]) => [key, row.id])),
    entityIds: Object.fromEntries(Object.entries(entities).map(([key, row]) => [key, row.id])),
    assertionIds: {
      mayaFriday: mayaFriday.id,
      haleThursday: haleThursday.id,
      swipe: swipeAssert.id,
      gps: gpsAssert.id,
    },
    factId: presenceFact.id,
    contradictionId: contradiction.id,
    hypothesisId: hypothesis.id,
    inferenceId: inference.id,
    findingIds: {
      presence: factFinding.id,
      weekday: contradictionFinding.id,
    },
  };
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
