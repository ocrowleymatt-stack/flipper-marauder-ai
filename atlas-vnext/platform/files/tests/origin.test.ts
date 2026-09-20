import { describe, expect, it } from 'vitest';
import type { ProvenanceRecord } from '@atlas-vnext/contracts';
import { originFromProvenance } from '../src/origin.ts';

function entry(partial: Partial<ProvenanceRecord>): ProvenanceRecord {
  return {
    artefactId: 'art_1',
    projectId: 'prj_1',
    sourceInputs: [],
    inputManifestHash: null,
    provider: 'atlas.files',
    model: 'test',
    toolCalls: [],
    jobId: null,
    timestamp: '2026-09-19T23:00:00.000Z',
    traceId: 't1',
    ...partial,
  };
}

describe('file origin from provenance', () => {
  it('is unknown when no provenance exists', () => {
    expect(originFromProvenance([])).toBe('unknown');
  });

  it('classifies ordinary ingest as uploaded, not from the path', () => {
    expect(originFromProvenance([entry({ capability: 'files.ingest' })])).toBe('uploaded');
  });

  it('prefers result provenance over ingest when both exist', () => {
    expect(
      originFromProvenance([
        entry({ capability: 'files.ingest' }),
        entry({ provider: 'atlas.acquisition', capability: 'acquisition' }),
      ]),
    ).toBe('result');
  });

  it('classifies OSINT and writing from provider/capability, not path', () => {
    expect(originFromProvenance([entry({ provider: 'atlas.osint', capability: 'osint' })])).toBe('result');
    expect(originFromProvenance([entry({ provider: 'atlas.writing', capability: 'writing' })])).toBe('generated');
  });
});
