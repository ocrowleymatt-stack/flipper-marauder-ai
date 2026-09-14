import { afterEach, describe, expect, it } from 'vitest';
import { BehaviourPolicyError, TenantIsolationError, authorityBoundary, behaviourGrantsNoAuthority } from '@atlas-vnext/permissions';
import { OwnershipError } from '../../src/errors.ts';
import { openTestKernel, tenantA, tenantB } from './harness.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe('tenant and workspace isolation', () => {
  it('prevents tenant A from reading tenant B conversations, jobs, or events', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    await handle.kernel.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    await handle.kernel.ensureTenant({ id: tenantB.tenantId, name: 'B' });
    const a = handle.kernel.forActor(tenantA);
    const b = handle.kernel.forActor(tenantB);
    const conversation = await b.conversations.create({ title: 'Secret', projectId: null });
    await b.messages.append({ conversationId: conversation.id, role: 'user', content: 'classified', executionId: null });
    const job = await b.jobs.enqueue(tenantB, { dungeon: 'osint', type: 'scan' });
    await b.events.publish({
      channel: `conversation:${conversation.id}`,
      type: 'conversation.created',
      payload: { conversationId: conversation.id },
      conversationId: conversation.id,
    });

    expect(await a.conversations.get(conversation.id)).toBeNull();
    expect(await a.messages.list(conversation.id)).toEqual([]);
    expect(await a.jobs.get(tenantA, job.id)).toBeNull();
    await expect(a.jobs.cancel(tenantA, job.id)).rejects.toThrow(/not visible/);
    const replay = await a.events.replay(`conversation:${conversation.id}`);
    expect(replay).toEqual([]);
  });

  it('enforces workspace ownership even with a known conversation id', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    await handle.kernel.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    const ws1 = await handle.kernel.ensureWorkspace(tenantA, { name: 'One', dungeon: 'writing' });
    const ws2 = await handle.kernel.ensureWorkspace(tenantA, { name: 'Two', dungeon: 'writing' });
    const owner1 = handle.kernel.forActor({ tenantId: tenantA.tenantId, workspaceId: ws1.id });
    const owner2 = handle.kernel.forActor({ tenantId: tenantA.tenantId, workspaceId: ws2.id });
    const conversation = await owner1.conversations.create({ title: 'W1', projectId: ws1.id });
    expect(await owner2.conversations.get(conversation.id)).toBeNull();
    await expect(
      owner2.messages.append({ conversationId: conversation.id, role: 'user', content: 'nope', executionId: null }),
    ).rejects.toBeInstanceOf(OwnershipError);
  });

  it('scopes Behaviour posture per tenant and fails closed across tenants', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    await handle.kernel.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    await handle.kernel.ensureTenant({ id: tenantB.tenantId, name: 'B' });
    const a = handle.kernel.forActor(tenantA).behaviour;
    const b = handle.kernel.forActor(tenantB).behaviour;
    await a.write(tenantA.tenantId, tenantA.tenantId, 'open');
    expect(await a.resolve(tenantA.tenantId)).toBe('open');
    expect(await b.resolve(tenantB.tenantId)).toBe('standard');
    await expect(a.read(tenantA.tenantId, tenantB.tenantId)).rejects.toBeInstanceOf(TenantIsolationError);
    await expect(a.write(tenantA.tenantId, tenantB.tenantId, 'open')).rejects.toBeInstanceOf(TenantIsolationError);
    await expect(a.resolve('', tenantA.tenantId)).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('isolates artefact metadata and provenance across tenants', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    await handle.kernel.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    await handle.kernel.ensureTenant({ id: tenantB.tenantId, name: 'B' });
    const recorded = await handle.kernel.artefacts.record(tenantA, {
      id: 'art_secret',
      workspaceId: null,
      type: 'document',
      version: 1,
      parentId: null,
      createdBy: 'principal_a',
      executionId: 'exe_1',
      jobId: 'job_1',
      contentHash: 'abc',
      mimeType: 'text/plain',
      sizeBytes: 4,
    });
    expect(recorded.urn).toContain('art_secret');
    expect(recorded.type).toBe('document');
    expect(recorded.parentId).toBeNull();
    expect(recorded.createdBy).toBe('principal_a');
    expect(recorded.executionId).toBe('exe_1');
    expect(await handle.kernel.artefacts.get(tenantB, recorded.id)).toBeNull();
    await handle.kernel.forActor(tenantA).provenance.record({
      artefactId: recorded.id,
      projectId: 'proj_a',
      sourceInputs: ['in'],
      inputManifestHash: null,
      provider: 'openai',
      model: 'gpt-4o',
      toolCalls: [],
      jobId: 'job_1',
      timestamp: '2026-09-14T00:00:00.000Z',
      traceId: 'trc',
    });
    expect(await handle.kernel.forActor(tenantA).provenance.forJob('job_1')).toHaveLength(1);
    expect(await handle.kernel.forActor(tenantB).provenance.forJob('job_1')).toEqual([]);
  });

  it('rejects invalid Behaviour and does not treat Open as Authority', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    await handle.kernel.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    const behaviour = handle.kernel.forActor(tenantA).behaviour;
    await expect(behaviour.write(tenantA.tenantId, tenantA.tenantId, 'jailbreak' as never)).rejects.toBeInstanceOf(
      BehaviourPolicyError,
    );
    expect(await behaviour.resolve(tenantA.tenantId)).toBe('standard');
    await behaviour.write(tenantA.tenantId, tenantA.tenantId, 'open');
    const gate = { evaluate: () => 'DENY' as const };
    expect(behaviourGrantsNoAuthority('open', gate)).toBe(true);
    expect(authorityBoundary('open', gate).grantedScopes).toEqual([]);
  });
});
