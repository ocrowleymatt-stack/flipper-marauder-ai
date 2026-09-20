import type { ProvenanceRecord } from '@atlas-vnext/contracts';

export type FileOrigin = 'uploaded' | 'generated' | 'result' | 'unknown';

const RESULT_PROVIDERS = new Set(['atlas.osint', 'atlas.acquisition', 'atlas.research', 'atlas.investigation']);
const RESULT_CAPABILITIES = new Set(['osint', 'acquisition', 'research', 'investigation']);
const GENERATED_PROVIDERS = new Set(['atlas.writing', 'atlas.website', 'atlas.music', 'atlas.caspa']);
const GENERATED_CAPABILITIES = new Set(['writing', 'website', 'music', 'caspa']);

export function originFromProvenance(entries: ProvenanceRecord[]): FileOrigin {
  if (entries.length === 0) return 'unknown';
  if (entries.some((entry) => RESULT_PROVIDERS.has(entry.provider) || RESULT_CAPABILITIES.has(entry.capability ?? ''))) {
    return 'result';
  }
  if (entries.some((entry) => GENERATED_PROVIDERS.has(entry.provider) || GENERATED_CAPABILITIES.has(entry.capability ?? ''))) {
    return 'generated';
  }
  if (entries.some((entry) => entry.capability === 'files.ingest')) return 'uploaded';
  if (entries.some((entry) => entry.capability === 'files.artefact')) return 'generated';
  if (entries.some((entry) => entry.provider === 'atlas.files')) return 'uploaded';
  return 'unknown';
}
