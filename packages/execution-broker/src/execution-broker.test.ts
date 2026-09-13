import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryContentAddressedStorage } from '@atlas/storage-cas';
import { InMemoryExecutionBroker, InMemoryProgressBroadcaster } from './index.js';
import type { JobProgressEvent } from '@atlas/core-contracts';

test('InMemoryExecutionBroker manages durable job lifecycle and broadcasts progress events', async () => {
  const cas = new MemoryContentAddressedStorage();
  const broadcaster = new InMemoryProgressBroadcaster();
  const broker = new InMemoryExecutionBroker(cas, broadcaster);

  const receivedEvents: JobProgressEvent[] = [];
  const unsubscribe = broadcaster.subscribe('job-100', (event) => {
    receivedEvents.push(event);
  });

  const job = await broker.submitJob({
    jobId: 'job-100',
    type: 'creative:generate_bible',
    input: { title: 'Atlas Chronicles', genre: 'Sci-Fi' },
    context: {
      environment: 'development',
      correlationId: 'req-001',
      user: {
        id: 'u-1',
        email: 'author@atlas.local',
        displayName: 'Author',
        groups: ['creators'],
        roles: ['writer'],
      },
    },
  });

  assert.equal(job.id, 'job-100');
  assert.equal(job.status, 'queued');
  assert.ok(job.inputHash.length === 64);

  // Worker claims lease
  const claimed = await broker.claimLease('worker-alpha', 1);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].id, 'job-100');
  assert.equal(claimed[0].status, 'running');
  assert.equal(claimed[0].leaseOwner, 'worker-alpha');

  // Progress update
  await broker.updateJobProgress('job-100', 'synthesize', 50, 'running', 'Generating plot nodes');

  assert.ok(receivedEvents.length >= 2);
  const latestEvent = receivedEvents.at(-1);
  assert.equal(latestEvent?.progressPercent, 50);
  assert.equal(latestEvent?.message, 'Generating plot nodes');

  unsubscribe();
});
