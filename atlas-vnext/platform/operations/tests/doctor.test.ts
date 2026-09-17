import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  CHECK_IDS,
  OPERATIONAL_STATES,
  diagnoseNoteSchema,
  doctorReportSchema,
  type HealthCheckResult,
} from '@atlas-vnext/contracts';
import type { DurableJobEngine } from '@atlas-vnext/jobs';
import { AuthorityEngine, type AuthorityPrincipal } from '@atlas-vnext/permissions';
import { CURRENT_SCHEMA_VERSION, type PlatformPersistence } from '@atlas-vnext/persistence';
import { MemoryCas, type CasStore } from '@atlas-vnext/storage';
import { OperationsDoctor, rollupOperationalState } from '../src/index.ts';

const actor: AuthorityPrincipal = { principalId: 'user_ops', kind: 'user', tenantId: 'tenant_a' };

function persistenceStub(
  mode: 'memory' | 'postgres' | 'file',
  run: PlatformPersistence['run'] = async (fn) => fn(),
): PlatformPersistence {
  return { mode, run } as PlatformPersistence;
}

function jobsStub(recover = vi.fn(async () => [])): DurableJobEngine {
  return { recoverExpiredLeases: recover } as unknown as DurableJobEngine;
}

function check(id: HealthCheckResult['id'], state: HealthCheckResult['state']): HealthCheckResult {
  return { id, state, summary: id, evidence: {} };
}

describe('OperationsDoctor', () => {
  it('rolls memory-mode checks up to HEALTHY without PostgreSQL', async () => {
    const recover = vi.fn(async () => []);
    const doctor = new OperationsDoctor({
      persistence: persistenceStub('memory'),
      jobs: jobsStub(recover),
      authority: new AuthorityEngine(),
      now: () => '2026-09-17T00:00:00.000Z',
    });
    const report = await doctor.inspect(actor);
    expect(doctorReportSchema.parse(report).state).toBe('HEALTHY');
    expect(report.checks.map((item) => item.id)).toEqual([...CHECK_IDS]);
    expect(report.checks.find((item) => item.id === 'postgres')?.state).toBe('not_configured');
    expect(report.checks.find((item) => item.id === 'migrations')?.state).toBe('not_configured');
    expect(report.checks.find((item) => item.id === 'architecture')?.state).toBe('ok');
    expect(report.checks.find((item) => item.id === 'architecture')?.evidence.replacesCi).toBe(false);
    expect(report.notes.every((note) => note.kind === 'deterministic')).toBe(true);
    expect(report.proposals).toEqual([]);
    expect(recover).not.toHaveBeenCalled();
  });

  it('treats a successful postgres no-op as ok and matches an injected schema version', async () => {
    const doctor = new OperationsDoctor({
      persistence: persistenceStub('postgres'),
      authority: new AuthorityEngine(),
      getSchemaVersion: async () => CURRENT_SCHEMA_VERSION,
    });
    const report = await doctor.inspect(actor);
    expect(report.checks.find((item) => item.id === 'postgres')?.state).toBe('ok');
    expect(report.checks.find((item) => item.id === 'migrations')?.state).toBe('ok');
    expect(report.checks.find((item) => item.id === 'migrations')?.evidence.packagedSchemaVersion).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    expect(report.state).toBe('HEALTHY');
  });

  it('marks postgres probe failures CRITICAL and does not require a live cluster', async () => {
    const doctor = new OperationsDoctor({
      persistence: persistenceStub('postgres', async () => {
        throw new Error('connect postgres://secret@localhost/atlas');
      }),
      authority: new AuthorityEngine(),
    });
    const report = await doctor.inspect(actor);
    const postgres = report.checks.find((item) => item.id === 'postgres');
    expect(postgres?.state).toBe('error');
    expect(String(postgres?.evidence.message)).not.toMatch(/postgres:\/\//);
    expect(report.state).toBe('CRITICAL');
  });

  it('treats schema mismatch as ATTENTION_REQUIRED and proposes a consequential migrate', async () => {
    const doctor = new OperationsDoctor({
      persistence: persistenceStub('postgres'),
      authority: new AuthorityEngine(),
      getSchemaVersion: async () => 0,
    });
    const report = await doctor.inspect(actor);
    expect(report.state).toBe('ATTENTION_REQUIRED');
    expect(report.checks.find((item) => item.id === 'migrations')?.state).toBe('error');
    expect(report.proposals.some((item) => item.id === 'repair.migrate_schema' && item.repairClass === 'consequential')).toBe(
      true,
    );
    expect(report.notes.some((note) => note.checkId === 'migrations' && note.kind === 'deterministic')).toBe(true);
  });

  it('reports CAS ok via physicalBytes and error when both probes fail', async () => {
    const cas = new MemoryCas();
    await cas.put(new TextEncoder().encode('blob'));
    const ok = await new OperationsDoctor({
      cas,
      authority: new AuthorityEngine(),
    }).inspect(actor);
    expect(ok.checks.find((item) => item.id === 'cas')?.state).toBe('ok');

    const broken = {
      physicalBytes: async () => {
        throw new Error('cas down');
      },
      has: async () => {
        throw new Error('cas down');
      },
    } as unknown as CasStore;
    const failed = await new OperationsDoctor({
      cas: broken,
      authority: new AuthorityEngine(),
    }).inspect(actor);
    expect(failed.checks.find((item) => item.id === 'cas')?.state).toBe('error');
    expect(failed.state).toBe('CRITICAL');
  });

  it('warns on stuck jobs and disk quota without calling recoverExpiredLeases', async () => {
    const recover = vi.fn(async () => [{ id: 'job_stuck' }]);
    const cas = new MemoryCas();
    await cas.put(new TextEncoder().encode('quota-me'));
    const doctor = new OperationsDoctor({
      cas,
      jobs: jobsStub(recover),
      authority: new AuthorityEngine(),
      diskQuotaBytes: 1,
      listStuckJobs: async () => [{ id: 'job_stuck' }],
    });
    const report = await doctor.inspect(actor);
    expect(recover).not.toHaveBeenCalled();
    expect(report.state).toBe('DEGRADED');
    expect(report.checks.find((item) => item.id === 'stuck_jobs')?.state).toBe('warn');
    expect(report.checks.find((item) => item.id === 'disk')?.state).toBe('warn');
    expect(report.proposals.map((item) => item.id).sort()).toEqual(
      ['repair.recover_expired_leases', 'repair.unlink_cas'].sort(),
    );
    expect(report.proposals.find((item) => item.id === 'repair.recover_expired_leases')?.repairClass).toBe(
      'harmless_reversible',
    );
  });

  it('leaves retrieval, backup, and providers not_configured unless probes are injected', async () => {
    const baseline = await new OperationsDoctor({ authority: new AuthorityEngine() }).inspect(actor);
    expect(baseline.checks.find((item) => item.id === 'retrieval')?.state).toBe('not_configured');
    expect(baseline.checks.find((item) => item.id === 'backup')?.state).toBe('not_configured');
    expect(baseline.checks.find((item) => item.id === 'providers')?.state).toBe('not_configured');

    const injected = await new OperationsDoctor({
      authority: new AuthorityEngine(),
      retrievalProbe: async () => ({ state: 'ok', summary: 'index warm', evidence: { chunks: 3 } }),
      backupProbe: async () => ({ state: 'warn', summary: 'backup stale', evidence: { ageHours: 48 } }),
      providerHealth: { openai: 'error', ollama: 'ok' },
    }).inspect(actor);
    expect(injected.checks.find((item) => item.id === 'retrieval')?.state).toBe('ok');
    expect(injected.checks.find((item) => item.id === 'backup')?.state).toBe('warn');
    expect(injected.checks.find((item) => item.id === 'providers')?.state).toBe('error');
    expect(injected.state).toBe('ATTENTION_REQUIRED');
    expect(injected.proposals.some((item) => item.id === 'repair.reconfigure_providers')).toBe(true);
  });

  it('records jobs as ok when an engine is present and architecture as not a CI replacement', async () => {
    const report = await new OperationsDoctor({
      jobs: jobsStub(),
      authority: new AuthorityEngine(),
    }).inspect(actor);
    expect(report.checks.find((item) => item.id === 'jobs')?.state).toBe('ok');
    expect(report.checks.find((item) => item.id === 'stuck_jobs')?.state).toBe('ok');
    expect(report.checks.find((item) => item.id === 'architecture')?.summary).toMatch(/does not replace CI/);
  });

  it('rolls up warn to DEGRADED and non-postgres/cas errors to ATTENTION_REQUIRED', () => {
    expect(rollupOperationalState([check('disk', 'warn')])).toBe('DEGRADED');
    expect(rollupOperationalState([check('migrations', 'error')])).toBe('ATTENTION_REQUIRED');
    expect(rollupOperationalState([check('postgres', 'error')])).toBe('CRITICAL');
    expect(rollupOperationalState([check('cas', 'error'), check('disk', 'warn')])).toBe('CRITICAL');
    expect(rollupOperationalState([check('architecture', 'ok')])).toBe('HEALTHY');
    expect(OPERATIONAL_STATES).toContain('REPAIRING');
    expect(OPERATIONAL_STATES).toContain('VERIFICATION');
  });

  it('types AI diagnose notes without ever emitting them from inspect', async () => {
    const ai = diagnoseNoteSchema.parse({ kind: 'ai', summary: 'human-authored hypothesis only' });
    expect(ai.kind).toBe('ai');
    const report = await new OperationsDoctor({ authority: new AuthorityEngine() }).inspect(actor);
    expect(report.notes.some((note) => note.kind === 'ai')).toBe(false);
  });

  it('does not depend on nexus, execution, dungeons, or apps', () => {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    const names = Object.keys(pkg.dependencies);
    expect(names.sort()).toEqual(
      [
        '@atlas-vnext/contracts',
        '@atlas-vnext/flags',
        '@atlas-vnext/jobs',
        '@atlas-vnext/permissions',
        '@atlas-vnext/persistence',
        '@atlas-vnext/storage',
      ].sort(),
    );
    expect(names.some((name) => name.includes('nexus') || name.includes('execution') || name.includes('dungeon'))).toBe(
      false,
    );
  });
});
