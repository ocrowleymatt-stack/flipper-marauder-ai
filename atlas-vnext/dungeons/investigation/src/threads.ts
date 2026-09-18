import type { CommunicationThread, CommunicationTurn, EvidenceObject, SourceLocation } from '@atlas-vnext/contracts';
import { emptySourceLocation } from '@atlas-vnext/contracts';

const ISO_MESSAGE =
  /^(\d{4}-\d{2}-\d{2}T[0-9:+.\-Z]+)\s+([^:]{1,80}):\s*(.*)$/;
const CALL_HEADER =
  /^CALL\s+(\d{4}-\d{2}-\d{2}T[0-9:+.\-Z]+)\s+(.+?)\s+->\s+(.+)$/;
const CALL_LINE = /^([^:]{1,80}):\s*(.*)$/;

/**
 * Deterministic reconstruction of ordered turns from evidential objects.
 * Turns are always source_assertion — never facts.
 */
export function reconstructThreads(caseId: string, objects: EvidenceObject[]): CommunicationThread[] {
  const threads: CommunicationThread[] = [];
  for (const object of [...objects].sort((a, b) => a.id.localeCompare(b.id))) {
    const turns =
      object.kind === 'message' || object.kind === 'transcript'
        ? parseMessageTurns(caseId, object)
        : object.kind === 'call_record'
          ? parseCallTurns(caseId, object)
          : [];
    if (turns.length === 0) continue;
    threads.push({
      id: `thr_${object.id}`,
      caseId,
      evidenceObjectId: object.id,
      sourceId: object.sourceId,
      title: object.title,
      turns,
    });
  }
  return threads;
}

function parseMessageTurns(caseId: string, object: EvidenceObject): CommunicationTurn[] {
  const turns: CommunicationTurn[] = [];
  const lines = object.text.split(/\r?\n/);
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = ISO_MESSAGE.exec(line.trim());
    if (match) {
      const occurredAt = match[1] ?? null;
      const speaker = (match[2] ?? 'unknown').trim();
      const text = (match[3] ?? '').trim();
      turns.push(
        turn(caseId, object, index, speaker, text, occurredAt, {
          ...locate(object, offset, offset + line.length),
          timestampStart: occurredAt,
          timestampEnd: occurredAt,
          messageId: `${object.id}:${index}`,
        }),
      );
    }
    offset += line.length + 1;
  }
  return orderTurns(turns);
}

function parseCallTurns(caseId: string, object: EvidenceObject): CommunicationTurn[] {
  const turns: CommunicationTurn[] = [];
  const lines = object.text.split(/\r?\n/);
  let offset = 0;
  let headerAt: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const header = CALL_HEADER.exec(line.trim());
    if (header) {
      headerAt = header[1] ?? null;
      offset += line.length + 1;
      continue;
    }
    const spoken = CALL_LINE.exec(line.trim());
    if (spoken && !line.trim().startsWith('CALL ')) {
      const speaker = (spoken[1] ?? 'unknown').trim();
      const text = (spoken[2] ?? '').trim();
      turns.push(
        turn(caseId, object, index, speaker, text, headerAt, {
          ...locate(object, offset, offset + line.length),
          timestampStart: headerAt,
          timestampEnd: headerAt,
          messageId: `${object.id}:${index}`,
        }),
      );
    }
    offset += line.length + 1;
  }
  return orderTurns(turns);
}

function turn(
  caseId: string,
  object: EvidenceObject,
  index: number,
  speaker: string,
  text: string,
  occurredAt: string | null,
  sourceLocation: SourceLocation,
): CommunicationTurn {
  return {
    id: `trn_${object.id}_${index}`,
    caseId,
    evidenceObjectId: object.id,
    speaker,
    text,
    occurredAt,
    sourceLocation,
    epistemicClass: 'source_assertion',
  };
}

function locate(object: EvidenceObject, start: number, end: number): SourceLocation {
  return {
    ...emptySourceLocation(),
    ...object.sourceLocation,
    offsetStart: start,
    offsetEnd: end,
  };
}

function orderTurns(turns: CommunicationTurn[]): CommunicationTurn[] {
  return [...turns].sort((a, b) => {
    const aAt = timestampMs(a.occurredAt);
    const bAt = timestampMs(b.occurredAt);
    if (aAt !== null && bAt !== null && aAt !== bAt) return aAt - bAt;
    if (aAt !== null && bAt === null) return -1;
    if (aAt === null && bAt !== null) return 1;
    const aOff = a.sourceLocation.offsetStart ?? 0;
    const bOff = b.sourceLocation.offsetStart ?? 0;
    if (aOff !== bOff) return aOff - bOff;
    return a.id.localeCompare(b.id);
  });
}

export function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function utcDate(value: string | null | undefined): string {
  const ms = timestampMs(value);
  if (ms === null) return 'unknown';
  return new Date(ms).toISOString().slice(0, 10);
}
