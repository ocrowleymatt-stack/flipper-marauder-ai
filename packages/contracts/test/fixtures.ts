import {
  CONTRACT_VERSION,
  DEFAULT_RETRY_POLICY,
  type ActorRef,
  type BlobRef,
  type CapabilityToken,
  type CommandEnvelope,
  type EventEnvelope,
  type JobEnvelope,
  type ModuleManifest,
  type ProjectAggregate,
  type ProvenanceRecord,
} from '../src/index.js';

export const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
export const JOB_ID = '22222222-2222-4222-8222-222222222222';
export const COMMAND_ID = '33333333-3333-4333-8333-333333333333';
export const TOKEN_ID = '44444444-4444-4444-8444-444444444444';
export const STEP_ID = '55555555-5555-4555-8555-555555555555';
export const EVENT_ID = '66666666-6666-4666-8666-666666666666';
export const ACTIVITY_ID = '77777777-7777-4777-8777-777777777777';
export const LEASE_ID = '88888888-8888-4888-8888-888888888888';

export const NOW = '2026-01-01T00:00:00.000Z';

export const actor: ActorRef = { kind: 'user', id: 'user-1', displayName: 'Ada' };

export const blob: BlobRef = {
  address: `sha256:${'ab'.repeat(32)}`,
  sizeBytes: 12,
  mediaType: 'application/octet-stream',
};

export const command: CommandEnvelope = {
  id: COMMAND_ID,
  contractVersion: CONTRACT_VERSION,
  type: 'project.create',
  issuedAt: NOW,
  actor,
  capability: { tokenId: TOKEN_ID, fingerprint: `sha256:${'cd'.repeat(32)}` },
  idempotencyKey: 'create-project-once',
  payload: { name: 'Demo' },
};

export const job: JobEnvelope = {
  id: JOB_ID,
  contractVersion: CONTRACT_VERSION,
  type: 'project.create',
  projectId: PROJECT_ID,
  commandId: COMMAND_ID,
  idempotencyKey: 'create-project-once',
  state: 'queued',
  priority: 5,
  createdAt: NOW,
  updatedAt: NOW,
  availableAt: NOW,
  attempt: 0,
  retryPolicy: DEFAULT_RETRY_POLICY,
  timeoutMs: 30_000,
  lease: null,
  cancellationRequested: false,
  steps: [],
  attempts: [],
  lastError: null,
  payload: { name: 'Demo' },
};

export const project: ProjectAggregate = {
  id: PROJECT_ID,
  contractVersion: CONTRACT_VERSION,
  slug: 'demo-project',
  name: 'Demo Project',
  status: 'active',
  owner: actor,
  createdAt: NOW,
  updatedAt: NOW,
  version: 0,
  artifacts: [],
};

export const event: EventEnvelope = {
  id: EVENT_ID,
  contractVersion: CONTRACT_VERSION,
  streamId: `job:${JOB_ID}`,
  sequence: 0,
  occurredAt: NOW,
  recordedAt: NOW,
  producer: { kind: 'service', id: 'nexus-router' },
  correlation: { jobId: JOB_ID, projectId: PROJECT_ID, commandId: COMMAND_ID },
  payload: {
    type: 'job.enqueued',
    jobId: JOB_ID,
    jobType: 'project.create',
    projectId: PROJECT_ID,
    commandId: COMMAND_ID,
    availableAt: NOW,
  },
};

export const capabilityToken: CapabilityToken = {
  id: TOKEN_ID,
  contractVersion: CONTRACT_VERSION,
  subject: actor,
  audience: 'nexus-router',
  scopes: [{ resource: 'project', actions: ['read', 'write'] }],
  issuedAt: NOW,
  expiresAt: '2026-01-01T01:00:00.000Z',
  proof: { alg: 'hs256', keyId: 'dev-key', value: 'ZGV2LXNpZ25hdHVyZQ' },
};

export const provenance: ProvenanceRecord = {
  id: ACTIVITY_ID,
  contractVersion: CONTRACT_VERSION,
  projectId: PROJECT_ID,
  activity: {
    id: ACTIVITY_ID,
    type: 'module.step',
    jobId: JOB_ID,
    stepId: STEP_ID,
    moduleId: 'device.transport',
    moduleVersion: '0.1.0',
    startedAt: NOW,
    endedAt: NOW,
  },
  agent: actor,
  inputs: [],
  outputs: [blob],
  recordedAt: NOW,
  attestation: null,
};

export const moduleManifest: ModuleManifest = {
  id: 'device.transport',
  version: '0.1.0',
  contractVersion: CONTRACT_VERSION,
  sdkVersion: '1.0.0',
  displayName: 'Device Transport',
  entrypoint: './dist/index.js',
  isolation: 'in-process',
  requiredCapabilities: [{ resource: 'module:device.transport', actions: ['execute'] }],
  declaredCommands: ['device.transport.scan'],
  declaredEvents: ['step.progress', 'artifact.produced'],
};
