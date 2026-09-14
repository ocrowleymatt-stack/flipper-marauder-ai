import type {
  CapabilityAlias,
  LatencyClass,
  Locality,
  ModelCapabilities,
} from '@atlas-vnext/contracts';

/**
 * Data-driven alias policy. Adding a model should not require editing this
 * table unless a new alias is introduced.
 */
export interface AliasPolicy {
  locality?: Locality;
  requireCapabilities?: Array<keyof ModelCapabilities>;
  requireLatencyClass?: LatencyClass;
  /** Prefer high cost class or reasoning capability (frontier path). */
  frontier?: boolean;
  sort: 'latency' | 'cost';
  reason: string;
}

export const ALIAS_POLICIES: Record<CapabilityAlias, AliasPolicy> = {
  'nexus/fast': {
    requireLatencyClass: 'fast',
    sort: 'latency',
    reason: 'Lowest-latency interactive path',
  },
  'nexus/reason': {
    requireCapabilities: ['reasoning'],
    sort: 'latency',
    reason: 'Reasoning capability required',
  },
  'nexus/code': {
    requireCapabilities: ['code'],
    sort: 'latency',
    reason: 'Code capability required',
  },
  'nexus/vision': {
    requireCapabilities: ['vision'],
    sort: 'latency',
    reason: 'Vision capability required',
  },
  'nexus/cheap': {
    sort: 'cost',
    reason: 'Lowest cost class',
  },
  'nexus/local': {
    locality: 'local',
    sort: 'latency',
    reason: 'Local-only policy',
  },
  'nexus/frontier': {
    frontier: true,
    sort: 'latency',
    reason: 'Frontier / high-capability path',
  },
};
