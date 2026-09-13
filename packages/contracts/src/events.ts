import { z } from 'zod';
import { DottedName, IsoTimestamp, SchemaVersion } from './common.js';
import { AnyAtlasId, IdKindSchema, atlasId, parseId } from './ids.js';

export const EventSubject = z
  .object({
    kind: IdKindSchema,
    id: AnyAtlasId,
  })
  .refine((subject) => parseId(subject.id).kind === subject.kind, {
    path: ['id'],
    message: 'subject id prefix must match subject kind',
  });
export type EventSubject = z.infer<typeof EventSubject>;

export const EventEnvelope = z.object({
  schemaVersion: SchemaVersion,
  id: atlasId('evt'),
  type: DottedName,
  occurredAt: IsoTimestamp,
  traceId: atlasId('trace'),
  subject: EventSubject,
  payload: z.unknown(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;
