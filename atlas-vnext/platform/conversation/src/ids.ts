import { randomUUID } from 'node:crypto';

export type ObjectKind = 'conversation' | 'message' | 'execution' | 'event';

const PREFIX: Record<ObjectKind, string> = {
  conversation: 'cnv',
  message: 'msg',
  execution: 'exe',
  event: 'evt',
};

export interface IdFactory {
  id(kind: ObjectKind): string;
  urn(kind: ObjectKind, id: string): string;
}

export class UuidIdFactory implements IdFactory {
  id(kind: ObjectKind): string {
    return `${PREFIX[kind]}_${randomUUID()}`;
  }

  urn(kind: ObjectKind, id: string): string {
    const uuid = id.includes('_') ? id.slice(id.indexOf('_') + 1) : id;
    return `urn:atlas:${kind}:${uuid}`;
  }
}
