import type { InspectedSource, SearchMode, SearchReport } from '@atlas-vnext/contracts';

export interface FederatedSearchPort {
  search(input: { queries: string[]; mode?: SearchMode; signal?: AbortSignal }): Promise<SearchReport>;
  inspect(input: { url: string; signal?: AbortSignal }): Promise<InspectedSource | null>;
}
