import { describe, expect, it } from 'vitest';
import {
  BlobRef,
  CapabilityScope,
  DottedName,
  EventEnvelope,
  Grant,
  JobRecord,
  Manifest,
  ModelDescriptor,
  Provenance,
  RouteDecision,
  RouteRequest,
  RouteTrace,
  createManifest,
  manifestDigest,
  newId,
  verifyManifest,
} from './index.js';

const NOW = '2026-09-13T18:53:00.000Z';
const LATER = '2026-09-13T19:53:00.000Z';
const DIGEST = 'a'.repeat(64);

const expectIssueAt = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }, path: string) => {
  expect(result.success).toBe(false);
  expect(result.error?.issues.map((i) => i.path.join('.'))).toContain(path);
};

describe('DottedName', () => {
  it.each(['job.progress.updated', 'writing.draft-chapter', 'a.b'])('accepts %s', (v) => {
    expect(DottedName.safeParse(v).success).toBe(true);
  });
  it.each(['job', 'Job.Progress', 'job..progress', '.job', 'job.', 'job.-x', 'job_progress.x'])('rejects %s', (v) => {
    expect(DottedName.safeParse(v).success).toBe(false);
  });
});

describe('Grant', () => {
  const valid: Grant = {
    schemaVersion: 1,
    subject: { kind: 'job', id: newId('job') },
    scopes: ['filesystem.read', 'network.public'],
    constraints: [{ scope: 'filesystem.read', resources: ['/projects/**'] }],
    issuedAt: NOW,
    expiresAt: LATER,
  };

  it('parses a valid grant', () => {
    expect(Grant.parse(valid)).toEqual(valid);
  });

  it('knows every capability scope', () => {
    expect(CapabilityScope.options).toHaveLength(11);
    expect(CapabilityScope.safeParse('root.everything').success).toBe(false);
  });

  it('rejects constraints on scopes that were not granted', () => {
    expectIssueAt(
      Grant.safeParse({ ...valid, constraints: [{ scope: 'shell.execute', resources: ['*'] }] }),
      'constraints.0.scope',
    );
  });

  it('rejects expiry before issue and empty scope lists', () => {
    expectIssueAt(Grant.safeParse({ ...valid, expiresAt: NOW }), 'expiresAt');
    expectIssueAt(Grant.safeParse({ ...valid, scopes: [] }), 'scopes');
  });
});

describe('JobRecord', () => {
  const base: JobRecord = {
    schemaVersion: 1,
    id: newId('job'),
    kind: 'writing.draft-chapter',
    status: 'running',
    projectId: newId('prj'),
    progress: { percent: 40, stage: 'outline', message: 'drafting' },
    checkpoints: [{ sequence: 0, stage: 'outline', createdAt: NOW, state: { section: 2 } }],
    retry: { attempt: 1, maxAttempts: 3 },
    cancellation: { requested: false },
    resumable: true,
    createdAt: NOW,
    startedAt: NOW,
    updatedAt: NOW,
    traceId: newId('trace'),
  };

  it('parses a running job', () => {
    expect(JobRecord.parse(base)).toEqual(base);
  });

  it('parses a failed job with failure and finishedAt', () => {
    const failed: JobRecord = {
      ...base,
      status: 'failed',
      finishedAt: LATER,
      failure: { class: 'transient', message: 'provider timeout', cause: { code: 'ETIMEDOUT' } },
    };
    expect(JobRecord.parse(failed).failure?.class).toBe('transient');
  });

  it('allows a cancelled job that never started', () => {
    const cancelled: JobRecord = {
      ...base,
      status: 'cancelled',
      finishedAt: LATER,
      cancellation: { requested: true, requestedAt: NOW, reason: 'user' },
    };
    delete (cancelled as Partial<JobRecord>).startedAt;
    expect(JobRecord.safeParse(cancelled).success).toBe(true);
  });

  it('enforces terminal-state invariants', () => {
    expectIssueAt(JobRecord.safeParse({ ...base, status: 'failed', finishedAt: LATER }), 'failure');
    expectIssueAt(JobRecord.safeParse({ ...base, status: 'succeeded' }), 'finishedAt');
    expectIssueAt(JobRecord.safeParse({ ...base, finishedAt: LATER }), 'finishedAt');
    expectIssueAt(JobRecord.safeParse({ ...base, status: 'queued', finishedAt: undefined, startedAt: undefined, cancellation: { requested: false, reason: 'x' } }), 'cancellation');
  });

  it('rejects malformed ids, kinds, retries and progress', () => {
    expectIssueAt(JobRecord.safeParse({ ...base, id: newId('prj') }), 'id');
    expectIssueAt(JobRecord.safeParse({ ...base, kind: 'draft' }), 'kind');
    expectIssueAt(JobRecord.safeParse({ ...base, retry: { attempt: 4, maxAttempts: 3 } }), 'retry.attempt');
    expectIssueAt(JobRecord.safeParse({ ...base, progress: { percent: 101 } }), 'progress.percent');
    expectIssueAt(JobRecord.safeParse({ ...base, failure: { class: 'oops', message: 'x' } }), 'failure.class');
    expectIssueAt(JobRecord.safeParse({ ...base, schemaVersion: 2 }), 'schemaVersion');
  });

  it('rejects duplicate checkpoint sequences', () => {
    const cp = base.checkpoints[0]!;
    expectIssueAt(JobRecord.safeParse({ ...base, checkpoints: [cp, { ...cp, stage: 'draft' }] }), 'checkpoints');
  });
});

describe('EventEnvelope', () => {
  const jobId = newId('job');
  const valid: EventEnvelope = {
    schemaVersion: 1,
    id: newId('evt'),
    type: 'job.progress.updated',
    occurredAt: NOW,
    traceId: newId('trace'),
    subject: { kind: 'job', id: jobId },
    payload: { percent: 50 },
  };

  it('parses a valid envelope and keeps payload opaque', () => {
    expect(EventEnvelope.parse(valid)).toEqual(valid);
    expect(EventEnvelope.safeParse({ ...valid, payload: undefined }).success).toBe(true);
  });

  it('rejects a subject whose id does not match its kind', () => {
    expectIssueAt(EventEnvelope.safeParse({ ...valid, subject: { kind: 'prj', id: jobId } }), 'subject.id');
  });

  it('rejects non-dotted types and bad timestamps', () => {
    expectIssueAt(EventEnvelope.safeParse({ ...valid, type: 'progress' }), 'type');
    expectIssueAt(EventEnvelope.safeParse({ ...valid, occurredAt: 'yesterday' }), 'occurredAt');
    expectIssueAt(EventEnvelope.safeParse({ ...valid, occurredAt: '2026-09-13T18:53:00' }), 'occurredAt');
  });
});

describe('Provenance', () => {
  const valid: Provenance = {
    schemaVersion: 1,
    projectId: newId('prj'),
    sourceInputs: [{ objectId: newId('chap'), revisionId: newId('rev') }],
    model: { provider: 'anthropic', model: 'claude-x' },
    toolCalls: [{ name: 'search.web', startedAt: NOW, finishedAt: LATER, outcome: 'succeeded', resultDigest: DIGEST }],
    jobId: newId('job'),
    createdAt: NOW,
    edits: [{ at: LATER, by: { kind: 'user', id: 'u1' }, description: 'tightened prose' }],
  };

  it('parses valid provenance with and without optional parts', () => {
    expect(Provenance.parse(valid)).toEqual(valid);
    const { model: _model, edits: _edits, ...minimal } = valid;
    expect(Provenance.safeParse(minimal).success).toBe(true);
  });

  it('rejects wrong revision ids and bad digests', () => {
    expectIssueAt(Provenance.safeParse({ ...valid, sourceInputs: [{ objectId: newId('chap'), revisionId: newId('chap') }] }), 'sourceInputs.0.revisionId');
    expectIssueAt(Provenance.safeParse({ ...valid, toolCalls: [{ ...valid.toolCalls[0], resultDigest: 'ABC' }] }), 'toolCalls.0.resultDigest');
  });
});

describe('storage', () => {
  const blob: BlobRef = { digest: DIGEST, size: 12, mediaType: 'text/markdown' };

  it('validates blob refs', () => {
    expect(BlobRef.parse(blob)).toEqual(blob);
    expectIssueAt(BlobRef.safeParse({ ...blob, digest: DIGEST.toUpperCase() }), 'digest');
    expectIssueAt(BlobRef.safeParse({ ...blob, size: -1 }), 'size');
    expectIssueAt(BlobRef.safeParse({ ...blob, mediaType: 'markdown' }), 'mediaType');
  });

  it('builds manifests with a deterministic digest independent of key order', () => {
    const a = createManifest({ 'chapters/01.md': blob, 'cover.png': { ...blob, mediaType: 'image/png' } });
    const b = createManifest({ 'cover.png': { ...blob, mediaType: 'image/png' }, 'chapters/01.md': blob });
    expect(a.digest).toBe(b.digest);
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyManifest(a)).toBe(true);
    expect(verifyManifest({ ...a, digest: 'b'.repeat(64) })).toBe(false);
    expect(manifestDigest({})).toBe(manifestDigest({}));
    expect(Manifest.parse(a)).toEqual(a);
  });

  it('rejects unsafe manifest paths', () => {
    for (const path of ['/abs.md', '../up.md', 'a//b.md', 'a/./b.md', 'dir/', 'win\\path.md', '']) {
      expect(Manifest.safeParse({ schemaVersion: 1, digest: DIGEST, entries: { [path]: blob } }).success).toBe(false);
    }
  });
});

describe('nexus contracts', () => {
  const descriptor: ModelDescriptor = {
    provider: 'ollama',
    model: 'llama-local',
    capabilities: { text: true, reasoning: false, tools: true, vision: false, code: true, streaming: true, json: true },
    contextWindow: 32_000,
    costClass: 'low',
    latencyClass: 'low',
    locality: 'local',
    health: 'healthy',
  };

  it('parses alias and explicit-model requests and applies defaults', () => {
    const byAlias = RouteRequest.parse({ target: { alias: 'nexus/code' }, requirements: { tools: true } });
    expect(byAlias.requirements).toEqual({ tools: true });
    expect(byAlias.policy).toEqual({});

    const explicit = RouteRequest.parse({ target: { model: { provider: 'openai', model: 'gpt-x' } } });
    expect(explicit.requirements).toEqual({});
  });

  it('rejects unknown aliases and malformed requirements', () => {
    expect(RouteRequest.safeParse({ target: { alias: 'nexus/magic' } }).success).toBe(false);
    expectIssueAt(RouteRequest.safeParse({ target: { alias: 'nexus/fast' }, requirements: { minContext: 0 } }), 'requirements.minContext');
    expectIssueAt(RouteRequest.safeParse({ target: { alias: 'nexus/fast' }, requirements: { maxCostClass: 'free' } }), 'requirements.maxCostClass');
  });

  it('validates descriptors', () => {
    expect(ModelDescriptor.parse(descriptor)).toEqual(descriptor);
    expectIssueAt(ModelDescriptor.safeParse({ ...descriptor, health: 'fine' }), 'health');
    expectIssueAt(ModelDescriptor.safeParse({ ...descriptor, contextWindow: 0 }), 'contextWindow');
    expectIssueAt(ModelDescriptor.safeParse({ ...descriptor, capabilities: { text: true } }), 'capabilities.reasoning');
  });

  it('validates decisions against their traces', () => {
    const trace: RouteTrace = {
      schemaVersion: 1,
      traceId: newId('trace'),
      requestedAlias: 'nexus/local',
      consideredModels: [{ provider: 'ollama', model: 'llama-local' }, { provider: 'openai', model: 'gpt-x' }],
      excluded: [{ model: { provider: 'openai', model: 'gpt-x' }, reason: 'localOnly' }],
      chosen: { provider: 'ollama', model: 'llama-local' },
      policy: { preferLocality: 'local' },
      timestamp: NOW,
    };
    const decision: RouteDecision = { candidates: [descriptor], chosen: descriptor, trace };
    expect(RouteDecision.parse(decision)).toEqual(decision);

    const other = { ...descriptor, provider: 'openai', model: 'gpt-x' };
    expectIssueAt(RouteDecision.safeParse({ ...decision, chosen: other }), 'chosen');
    expectIssueAt(RouteDecision.safeParse({ ...decision, trace: { ...trace, chosen: { provider: 'x', model: 'y' } } }), 'trace.chosen');
    expectIssueAt(RouteDecision.safeParse({ ...decision, candidates: [] }), 'candidates');
  });
});
