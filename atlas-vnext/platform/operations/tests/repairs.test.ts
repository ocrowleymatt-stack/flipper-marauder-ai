import { describe, expect, it, vi } from 'vitest';
import type { RepairProposal } from '@atlas-vnext/contracts';
import type { DurableJobEngine } from '@atlas-vnext/jobs';
import { AuthorityEngine, type AuthorityPrincipal } from '@atlas-vnext/permissions';
import type { CasStore } from '@atlas-vnext/storage';
import {
  GENERIC_REPAIR_DENIED,
  OperationsDoctor,
  RepairExecutor,
  REPAIR_MIGRATE_SCHEMA,
  migrateSchemaProposal,
  reconfigureProvidersProposal,
  recoverExpiredLeasesProposal,
  unlinkCasProposal,
} from '../src/index.ts';

const actor: AuthorityPrincipal = { principalId: 'user_ops', kind: 'user', tenantId: 'tenant_a' };

function jobsStub(recover = vi.fn(async () => [])): DurableJobEngine {
  return { recoverExpiredLeases: recover } as unknown as DurableJobEngine;
}

function allowAdmin(authority: AuthorityEngine): void {
  authority.grantMembership('user_ops', 'tenant_a');
  authority.grantTo({ principalId: 'user_ops', tenantId: 'tenant_a', capability: 'admin.configure' });
}

function assertNoShell(proposal: RepairProposal): void {
  for (const step of proposal.steps) {
    expect(step).not.toMatch(/^\s*(\$|sudo |rm -|psql |bash |sh )/i);
    expect(step).not.toMatch(/DROP TABLE|ALTER TABLE/i);
  }
}

describe('RepairExecutor', () => {
  it('denies without side effects and uses a generic message', async () => {
    const recover = vi.fn(async () => []);
    const unlink = vi.fn(async () => true);
    const authority = new AuthorityEngine();
    const jobs = jobsStub(recover);
    const doctor = new OperationsDoctor({
      authority,
      jobs,
      cas: { unlink, physicalBytes: async () => 99 } as unknown as CasStore,
      diskQuotaBytes: 1,
      listStuckJobs: async () => [{ id: 'job_stuck' }],
    });
    const executor = new RepairExecutor({ doctor, authority, jobs });
    const report = await doctor.inspect(actor);
    const recoverProposal = report.proposals.find((item) => item.id === 'repair.recover_expired_leases');
    expect(recoverProposal).toBeDefined();
    const denied = await executor.apply(actor, recoverProposal!);
    expect(denied).toEqual({
      proposalId: 'repair.recover_expired_leases',
      status: 'denied',
      authorityDecision: 'DENY',
    });
    expect(GENERIC_REPAIR_DENIED).toBe('Permission denied.');
    expect(recover).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });

  it('applies harmless recoverExpiredLeases when Authority ALLOWs', async () => {
    const recover = vi.fn(async () => [{ id: 'job_stuck' }]);
    const authority = new AuthorityEngine();
    const system: AuthorityPrincipal = { principalId: 'host', kind: 'system', tenantId: '*' };
    authority.grantTo({ principalId: 'host', tenantId: '*', capability: 'admin.configure' });
    let stuck = [{ id: 'job_stuck' }];
    const jobs = jobsStub(recover);
    const doctor = new OperationsDoctor({
      authority,
      jobs,
      listStuckJobs: async () => stuck,
    });
    const executor = new RepairExecutor({ doctor, authority, jobs });
    const applied = await executor.apply(system, recoverExpiredLeasesProposal());
    expect(applied.status).toBe('applied');
    expect(applied.authorityDecision).toBe('ALLOW');
    expect(recover).toHaveBeenCalledTimes(1);
    stuck = [];
    const verified = await executor.verify(system, applied);
    expect(verified.report.checks.find((item) => item.id === 'stuck_jobs')?.state).toBe('ok');
    expect(verified.execution?.status).toBe('verified');
  });

  it('never executes consequential repairs even when Authority ALLOWs', async () => {
    const recover = vi.fn(async () => []);
    const unlink = vi.fn(async () => true);
    const migrate = vi.fn();
    const authority = new AuthorityEngine();
    allowAdmin(authority);
    const jobs = jobsStub(recover);
    const cas = {
      unlink,
      physicalBytes: async () => 50,
      has: async () => false,
    } as unknown as CasStore;
    const doctor = new OperationsDoctor({
      authority,
      jobs,
      cas,
      diskQuotaBytes: 1,
      getSchemaVersion: async () => 0,
      persistence: { mode: 'postgres', run: async (fn: () => Promise<unknown>) => fn() } as never,
      providerHealth: { openai: 'error' },
    });
    const executor = new RepairExecutor({ doctor, authority, jobs });

    const migrateExec = await executor.apply(actor, migrateSchemaProposal());
    expect(migrateExec).toEqual({
      proposalId: REPAIR_MIGRATE_SCHEMA,
      status: 'proposed',
      authorityDecision: 'ALLOW',
    });
    expect(migrate).not.toHaveBeenCalled();

    const unlinkExec = await executor.apply(actor, unlinkCasProposal());
    expect(unlinkExec.status).toBe('proposed');
    expect(unlink).not.toHaveBeenCalled();

    const providersExec = await executor.apply(actor, reconfigureProvidersProposal());
    expect(providersExec.status).toBe('proposed');
    expect(recover).not.toHaveBeenCalled();

    const report = await doctor.inspect(actor);
    expect(report.proposals.filter((item) => item.repairClass === 'consequential').length).toBeGreaterThan(0);
    for (const proposal of [migrateSchemaProposal(), unlinkCasProposal(), reconfigureProvidersProposal()]) {
      assertNoShell(proposal);
      expect(proposal.requiresCapability).toBe('admin.configure');
      expect(proposal.repairClass).toBe('consequential');
    }
    assertNoShell(recoverExpiredLeasesProposal());
  });

  it('authorizes the canonical proposal capability, not a caller-supplied one', async () => {
    const recover = vi.fn(async () => []);
    const authority = new AuthorityEngine();
    authority.grantMembership('user_ops', 'tenant_a');
    authority.grantTo({ principalId: 'user_ops', tenantId: 'tenant_a', capability: 'conversation.read' });
    const jobs = jobsStub(recover);
    const doctor = new OperationsDoctor({ authority, jobs });
    const executor = new RepairExecutor({ doctor, authority, jobs });
    const spoofed: RepairProposal = {
      ...recoverExpiredLeasesProposal(),
      requiresCapability: 'conversation.read',
    };
    const denied = await executor.apply(actor, spoofed);
    expect(denied.status).toBe('denied');
    expect(denied.authorityDecision).toBe('DENY');
    expect(recover).not.toHaveBeenCalled();
  });

  it('keeps recover proposed when no job engine is injected', async () => {
    const authority = new AuthorityEngine();
    allowAdmin(authority);
    const doctor = new OperationsDoctor({ authority });
    const executor = new RepairExecutor({ doctor, authority });
    const result = await executor.apply(actor, recoverExpiredLeasesProposal());
    expect(result).toEqual({
      proposalId: 'repair.recover_expired_leases',
      status: 'proposed',
      authorityDecision: 'ALLOW',
    });
  });

  it('verify re-runs inspect without applying consequential work', async () => {
    const unlink = vi.fn(async () => true);
    const authority = new AuthorityEngine();
    allowAdmin(authority);
    const doctor = new OperationsDoctor({
      authority,
      cas: { unlink, physicalBytes: async () => 10 } as unknown as CasStore,
      diskQuotaBytes: 1,
    });
    const executor = new RepairExecutor({ doctor, authority });
    const proposed = await executor.apply(actor, unlinkCasProposal());
    const verified = await executor.verify(actor, proposed);
    expect(verified.execution?.status).toBe('proposed');
    expect(verified.report.checks.find((item) => item.id === 'disk')?.state).toBe('warn');
    expect(unlink).not.toHaveBeenCalled();
  });
  it('denies global recovery to a tenant administrator and rejects fabricated execution results', async () => {
    const authority = new AuthorityEngine(); allowAdmin(authority);
    const recover = vi.fn(async () => []);
    const jobs = jobsStub(recover);
    const doctor = new OperationsDoctor({ authority, jobs, listStuckJobs: async () => [] });
    const executor = new RepairExecutor({ authority, doctor, jobs });
    expect((await executor.apply(actor, recoverExpiredLeasesProposal())).status).toBe('denied');
    expect(recover).not.toHaveBeenCalled();
    const result = await executor.verify(actor, { proposalId: 'repair.recover_expired_leases', status: 'applied', authorityDecision: 'ALLOW' });
    expect(result.execution?.status).toBe('denied');
  });

  it('denies recover when a system actor only has a workspace-scoped admin.configure grant', async () => {
    const recover = vi.fn(async () => []);
    const authority = new AuthorityEngine();
    const system: AuthorityPrincipal = { principalId: 'host', kind: 'system', tenantId: '*' };
    authority.grantTo({
      principalId: 'host',
      tenantId: '*',
      capability: 'admin.configure',
      workspaceId: 'ws_a',
    });
    const jobs = jobsStub(recover);
    const doctor = new OperationsDoctor({ authority, jobs, listStuckJobs: async () => [{ id: 'job_stuck' }] });
    const executor = new RepairExecutor({ doctor, authority, jobs });
    const denied = await executor.apply(system, recoverExpiredLeasesProposal());
    expect(denied.status).toBe('denied');
    expect(denied.authorityDecision).toBe('DENY');
    expect(recover).not.toHaveBeenCalled();
  });

  it('preserves issued recover execution across pending verify retries', async () => {
    const recover = vi.fn(async () => [{ id: 'job_stuck' }]);
    const authority = new AuthorityEngine();
    const system: AuthorityPrincipal = { principalId: 'host', kind: 'system', tenantId: '*' };
    authority.grantTo({ principalId: 'host', tenantId: '*', capability: 'admin.configure' });
    let stuck = [{ id: 'job_stuck' }];
    const jobs = jobsStub(recover);
    const doctor = new OperationsDoctor({
      authority,
      jobs,
      listStuckJobs: async () => stuck,
    });
    const executor = new RepairExecutor({ doctor, authority, jobs });
    const applied = await executor.apply(system, recoverExpiredLeasesProposal());
    expect(applied.status).toBe('applied');
    const pending = await executor.verify(system, applied);
    expect(pending.execution?.status).toBe('applied');
    stuck = [];
    const verified = await executor.verify(system, pending.execution!);
    expect(verified.execution?.status).toBe('verified');
  });

});
