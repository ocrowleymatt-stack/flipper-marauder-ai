import type { OsintTargetKind, PublicLookupResult } from '@atlas-vnext/contracts';

export interface PublicLookupPort {
  lookup(input: { kind: OsintTargetKind; value: string; signal?: AbortSignal }): Promise<PublicLookupResult[]>;
}
