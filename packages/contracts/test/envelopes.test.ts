import { describe, expect, it } from 'vitest';
import {
  BlobRef,
  CapabilityToken,
  CommandEnvelope,
  EventEnvelope,
  JobEnvelope,
  JOB_STATES,
  ModuleManifest,
  ProjectAggregate,
  ProvenanceRecord,
  isTerminalJobState,
  jobStreamId,
  projectStreamId,
  StreamId,
} from '../src/index.js';
import * as fx from './fixtures.js';

describe('command envelope', () => {
  it('accepts a well-formed command', () => {
    expect(CommandEnvelope.parse(fx.command)).toEqual(fx.command);
  });

  it('rejects an unknown field, so a typo cannot become a silent extension', () => {
    expect(() => CommandEnvelope.parse({ ...fx.command, tyep: 'oops' })).toThrow();
  });

  it('requires an idempotency key', () => {
    const { idempotencyKey: _drop, ...rest } = fx.command;
    expect(() => CommandEnvelope.parse(rest)).toThrow();
  });

  it('rejects a command type that is not a dotted identifier', () => {
    expect(() => CommandEnvelope.parse({ ...fx.command, type: 'Project Create' })).toThrow();
  });

  it('requires a capability reference', () => {
    const { capability: _drop, ...rest } = fx.command;
    expect(() => CommandEnvelope.parse(rest)).toThrow();
  });
});

describe('job envelope', () => {
  it('accepts a well-formed job', () => {
    expect(JobEnvelope.parse(fx.job)).toEqual(fx.job);
  });

  it('covers exactly the six declared states', () => {
    expect(JOB_STATES).toEqual(['queued', 'leased', 'running', 'succeeded', 'failed', 'cancelled']);
  });

  it('classifies terminal states', () => {
    expect(JOB_STATES.filter(isTerminalJobState)).toEqual(['succeeded', 'failed', 'cancelled']);
  });

  it('rejects an unknown state', () => {
    expect(() => JobEnvelope.parse({ ...fx.job, state: 'paused' })).toThrow();
  });

  it('requires lease to be explicitly null rather than absent', () => {
    const { lease: _drop, ...rest } = fx.job;
    expect(() => JobEnvelope.parse(rest)).toThrow();
  });

  it('accepts a leased job carrying a lease', () => {
    const leased = {
      ...fx.job,
      state: 'leased' as const,
      lease: {
        leaseId: fx.LEASE_ID,
        holder: 'broker-1',
        acquiredAt: fx.NOW,
        expiresAt: '2026-01-01T00:00:30.000Z',
      },
    };
    expect(JobEnvelope.parse(leased).lease?.holder).toBe('broker-1');
  });
});

describe('event envelope', () => {
  it('accepts a well-formed event', () => {
    expect(EventEnvelope.parse(fx.event)).toEqual(fx.event);
  });

  it('discriminates payloads on type', () => {
    const parsed = EventEnvelope.parse(fx.event);
    expect(parsed.payload.type).toBe('job.enqueued');
    if (parsed.payload.type === 'job.enqueued') {
      expect(parsed.payload.jobType).toBe('project.create');
    }
  });

  it('rejects an unknown event type', () => {
    expect(() =>
      EventEnvelope.parse({ ...fx.event, payload: { type: 'job.exploded', jobId: fx.JOB_ID } }),
    ).toThrow();
  });

  it('rejects a payload whose fields belong to a different variant', () => {
    expect(() =>
      EventEnvelope.parse({
        ...fx.event,
        payload: { type: 'step.progress', jobId: fx.JOB_ID, stepId: fx.STEP_ID, ratio: 3 },
      }),
    ).toThrow();
  });

  it('rejects a negative sequence', () => {
    expect(() => EventEnvelope.parse({ ...fx.event, sequence: -1 })).toThrow();
  });

  it('only accepts project: and job: stream ids', () => {
    expect(StreamId.parse(projectStreamId(fx.PROJECT_ID))).toBe(`project:${fx.PROJECT_ID}`);
    expect(StreamId.parse(jobStreamId(fx.JOB_ID))).toBe(`job:${fx.JOB_ID}`);
    expect(() => StreamId.parse(`module:${fx.JOB_ID}`)).toThrow();
  });
});

describe('project aggregate', () => {
  it('accepts a well-formed project', () => {
    expect(ProjectAggregate.parse(fx.project)).toEqual(fx.project);
  });

  it('rejects a slug that is not kebab-case', () => {
    expect(() => ProjectAggregate.parse({ ...fx.project, slug: 'Demo Project' })).toThrow();
  });
});

describe('content addressing', () => {
  it('accepts a sha256 multihash address', () => {
    expect(BlobRef.parse(fx.blob)).toEqual(fx.blob);
  });

  it.each([
    ['wrong algorithm', `sha512:${'ab'.repeat(32)}`],
    ['uppercase hex', `sha256:${'AB'.repeat(32)}`],
    ['truncated digest', `sha256:${'ab'.repeat(16)}`],
    ['missing prefix', 'ab'.repeat(32)],
  ])('rejects %s', (_label, address) => {
    expect(() => BlobRef.parse({ ...fx.blob, address })).toThrow();
  });

  it('rejects a negative size', () => {
    expect(() => BlobRef.parse({ ...fx.blob, sizeBytes: -1 })).toThrow();
  });
});

describe('capability token', () => {
  it('accepts a well-formed token', () => {
    expect(CapabilityToken.parse(fx.capabilityToken)).toEqual(fx.capabilityToken);
  });

  it('requires at least one scope', () => {
    expect(() => CapabilityToken.parse({ ...fx.capabilityToken, scopes: [] })).toThrow();
  });

  it('requires at least one action per scope', () => {
    expect(() =>
      CapabilityToken.parse({
        ...fx.capabilityToken,
        scopes: [{ resource: 'project', actions: [] }],
      }),
    ).toThrow();
  });

  it('rejects an unknown action', () => {
    expect(() =>
      CapabilityToken.parse({
        ...fx.capabilityToken,
        scopes: [{ resource: 'project', actions: ['delete'] }],
      }),
    ).toThrow();
  });
});

describe('provenance record', () => {
  it('accepts a well-formed record', () => {
    expect(ProvenanceRecord.parse(fx.provenance)).toEqual(fx.provenance);
  });

  it('requires the attestation slot to be present, even if null', () => {
    const { attestation: _drop, ...rest } = fx.provenance;
    expect(() => ProvenanceRecord.parse(rest)).toThrow();
  });

  it('requires a module id and version on the activity', () => {
    const { moduleVersion: _drop, ...activity } = fx.provenance.activity;
    expect(() => ProvenanceRecord.parse({ ...fx.provenance, activity })).toThrow();
  });
});

describe('module manifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(ModuleManifest.parse(fx.moduleManifest)).toEqual(fx.moduleManifest);
  });

  it('rejects a non-semver module version', () => {
    expect(() => ModuleManifest.parse({ ...fx.moduleManifest, version: '1.0' })).toThrow();
  });

  it('rejects an undeclared event type', () => {
    expect(() =>
      ModuleManifest.parse({ ...fx.moduleManifest, declaredEvents: ['job.exploded'] }),
    ).toThrow();
  });

  it('rejects an unknown isolation mode', () => {
    expect(() => ModuleManifest.parse({ ...fx.moduleManifest, isolation: 'vm' })).toThrow();
  });
});
