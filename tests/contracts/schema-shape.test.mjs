import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const schemaPath = fileURLToPath(
  new URL('../../packages/contracts/schemas/atlas-contracts.schema.json', import.meta.url),
);
const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
const defs = schema.$defs;

describe('cross-boundary contract shapes', () => {
  it('publishes the design-gate contract families under a stable schema id', () => {
    assert.equal(schema.$id, 'https://atlas.local/contracts/v1');
    assert.deepEqual(
      Object.keys(defs).toSorted(),
      ['capabilityGrant', 'contentRef', 'event', 'job', 'project', 'provenance'],
    );
  });

  it('makes tenant, project, and correlation scope explicit for durable jobs and events', () => {
    for (const name of ['job', 'event']) {
      for (const field of ['tenantId', 'projectId', 'correlationId']) {
        assert.ok(defs[name].required.includes(field), `${name} must require ${field}`);
      }
    }
  });

  it('makes jobs idempotent, versioned, capability-gated, and durably stateful', () => {
    for (const field of ['idempotencyKey', 'handlerVersion', 'requiredCapabilities', 'state']) {
      assert.ok(defs.job.required.includes(field));
    }
    assert.ok(defs.job.properties.state.enum.includes('suspended'));
    assert.ok(defs.job.properties.state.enum.includes('cancelled'));
  });

  it('requires provenance for every content-addressed object', () => {
    assert.equal(defs.contentRef.properties.algorithm.const, 'sha256');
    assert.equal(defs.contentRef.properties.digest.pattern, '^[a-f0-9]{64}$');
    assert.ok(defs.contentRef.required.includes('provenance'));
    for (const field of ['producer', 'sources', 'correlationId', 'derivationIds', 'evidenceStatus']) {
      assert.ok(defs.provenance.required.includes(field));
    }
  });

  it('represents permissions as capabilities with explicit constraints', () => {
    assert.ok(defs.capabilityGrant.required.includes('capabilities'));
    assert.ok(defs.capabilityGrant.required.includes('constraints'));
    assert.equal(defs.capabilityGrant.properties.capabilities.items.type, 'string');
  });

  it('defines event-driven progress and permission suspension events', () => {
    const types = defs.event.properties.eventType.enum;
    assert.ok(types.includes('job.progress'));
    assert.ok(types.includes('permission.requested'));
    assert.ok(types.includes('permission.decided'));
  });
});
