import type {
  CheckId,
  DiagnoseNote,
  DoctorReport,
  HealthCheckResult,
  HealthCheckState,
  OperationalState,
  RepairProposal,
} from '@atlas-vnext/contracts';
import { EnvFlagStore, type FeatureFlagStore } from '@atlas-vnext/flags';
import type { DurableJobEngine } from '@atlas-vnext/jobs';
import type { AuthorityEngine, AuthorityPrincipal } from '@atlas-vnext/permissions';
import { CURRENT_SCHEMA_VERSION, type PlatformPersistence } from '@atlas-vnext/persistence';
import type { CasStore } from '@atlas-vnext/storage';
import {
  migrateSchemaProposal,
  reconfigureProvidersProposal,
  recoverExpiredLeasesProposal,
  unlinkCasProposal,
} from './repairs.ts';

export interface OperationsDoctorDeps {
  persistence?: PlatformPersistence | null;
  cas?: CasStore | null;
  jobs?: DurableJobEngine | null;
  authority: AuthorityEngine;
  now?: () => string;
  /** Live schema version probe. Unit tests inject this; a live PostgreSQL is not required. */
  getSchemaVersion?: () => Promise<number | null>;
  /** When set, disk warns if CAS physicalBytes exceeds this quota. */
  diskQuotaBytes?: number;
  /**
   * Read-only listing of expired running jobs. Inspect never calls recoverExpiredLeases —
   * that is a repair, not a check.
   */
  listStuckJobs?: () => Promise<Array<{ id: string }>>;
  retrievalProbe?: () => Promise<Pick<HealthCheckResult, 'state' | 'summary' | 'evidence'>>;
  backupProbe?: () => Promise<Pick<HealthCheckResult, 'state' | 'summary' | 'evidence'>>;
  /** Host-owned Nexus health snapshot. Do not import nexus from this package. */
  providerHealth?: Record<string, HealthCheckState>;
  flags?: FeatureFlagStore | null;
}

export class OperationsDoctor {
  constructor(private readonly deps: OperationsDoctorDeps) {}

  async inspect(_actor: AuthorityPrincipal): Promise<DoctorReport> {
    const now = this.deps.now?.() ?? new Date().toISOString();
    const checks: HealthCheckResult[] = [
      await this.checkPostgres(now),
      await this.checkMigrations(now),
      await this.checkCas(now),
      this.checkJobs(now),
      await this.checkStuckJobs(now),
      await this.checkDisk(now),
      await this.checkRetrieval(now),
      await this.checkBackup(now),
      this.checkProviders(now),
      this.checkArchitecture(now),
    ];

    const notes: DiagnoseNote[] = checks
      .filter((check) => check.state === 'error' || check.state === 'warn')
      .map((check) => ({
        kind: 'deterministic',
        summary: check.summary,
        checkId: check.id,
      }));

    return {
      state: rollupOperationalState(checks),
      checks,
      proposals: proposeRepairs(checks, { jobs: this.deps.jobs ?? null }),
      notes,
    };
  }

  private async checkPostgres(at: string): Promise<HealthCheckResult> {
    const persistence = this.deps.persistence ?? null;
    if (!persistence || persistence.mode !== 'postgres') {
      return result('postgres', 'not_configured', 'PostgreSQL is not the active persistence mode.', {
        at,
        mode: persistence?.mode ?? null,
      });
    }
    try {
      await persistence.run(async () => undefined);
      return result('postgres', 'ok', 'PostgreSQL accepted a no-op unit of work.', { at, mode: 'postgres' });
    } catch (err) {
      return result('postgres', 'error', 'PostgreSQL probe failed.', { at, message: safeMessage(err) });
    }
  }

  private async checkMigrations(at: string): Promise<HealthCheckResult> {
    const persistence = this.deps.persistence ?? null;
    if (!persistence || persistence.mode !== 'postgres') {
      return result('migrations', 'not_configured', 'Schema version is not probed for non-PostgreSQL persistence.', {
        at,
        mode: persistence?.mode ?? null,
        packagedSchemaVersion: CURRENT_SCHEMA_VERSION,
      });
    }
    if (!this.deps.getSchemaVersion) {
      return result('migrations', 'not_configured', 'No schema version probe is injected.', {
        at,
        packagedSchemaVersion: CURRENT_SCHEMA_VERSION,
        probed: false,
      });
    }
    try {
      const live = await this.deps.getSchemaVersion();
      if (live === null) {
        return result('migrations', 'error', 'Schema version probe returned no version.', {
          at,
          packagedSchemaVersion: CURRENT_SCHEMA_VERSION,
          liveSchemaVersion: null,
        });
      }
      if (live === CURRENT_SCHEMA_VERSION) {
        return result('migrations', 'ok', 'Live schema matches the packaged version.', {
          at,
          packagedSchemaVersion: CURRENT_SCHEMA_VERSION,
          liveSchemaVersion: live,
        });
      }
      return result('migrations', 'error', 'Live schema does not match the packaged version.', {
        at,
        packagedSchemaVersion: CURRENT_SCHEMA_VERSION,
        liveSchemaVersion: live,
      });
    } catch (err) {
      return result('migrations', 'error', 'Schema version probe failed.', {
        at,
        packagedSchemaVersion: CURRENT_SCHEMA_VERSION,
        message: safeMessage(err),
      });
    }
  }

  private async checkCas(at: string): Promise<HealthCheckResult> {
    const cas = this.deps.cas ?? null;
    if (!cas) {
      return result('cas', 'not_configured', 'No CAS store is injected.', { at });
    }
    try {
      const physicalBytes = await cas.physicalBytes();
      return result('cas', 'ok', 'CAS physical byte probe succeeded.', { at, physicalBytes });
    } catch (bytesErr) {
      try {
        await cas.has('0'.repeat(64));
        return result('cas', 'ok', 'CAS has() probe succeeded after physicalBytes failed.', {
          at,
          probed: 'has',
          physicalBytesError: safeMessage(bytesErr),
        });
      } catch (err) {
        return result('cas', 'error', 'CAS probe failed.', { at, message: safeMessage(err) });
      }
    }
  }

  private checkJobs(at: string): HealthCheckResult {
    if (!this.deps.jobs) {
      return result('jobs', 'not_configured', 'No durable job engine is injected.', { at });
    }
    return result('jobs', 'ok', 'Durable job engine is present.', { at, recoverExpiredLeases: true });
  }

  private async checkStuckJobs(at: string): Promise<HealthCheckResult> {
    if (!this.deps.jobs) {
      return result('stuck_jobs', 'not_configured', 'Cannot observe stuck jobs without a job engine.', { at });
    }
    if (!this.deps.listStuckJobs) {
      return result('stuck_jobs', 'not_configured', 'No expired-lease listing probe is injected; inspect does not recover leases.', {
        at,
        listed: false,
      });
    }
    try {
      const stuck = await this.deps.listStuckJobs();
      if (stuck.length > 0) {
        return result('stuck_jobs', 'warn', 'Expired running jobs are present.', {
          at,
          count: stuck.length,
          ids: stuck.map((job) => job.id),
        });
      }
      return result('stuck_jobs', 'ok', 'No expired running jobs are listed.', { at, count: 0 });
    } catch (err) {
      return result('stuck_jobs', 'error', 'Stuck-job listing failed.', { at, message: safeMessage(err) });
    }
  }

  private async checkDisk(at: string): Promise<HealthCheckResult> {
    const cas = this.deps.cas ?? null;
    if (!cas) {
      return result('disk', 'not_configured', 'Disk usage is not measured without a CAS store.', { at });
    }
    try {
      const physicalBytes = await cas.physicalBytes();
      const quota = this.deps.diskQuotaBytes;
      if (typeof quota === 'number' && physicalBytes > quota) {
        return result('disk', 'warn', 'CAS physical bytes exceed the injected quota.', {
          at,
          physicalBytes,
          quotaBytes: quota,
        });
      }
      return result('disk', 'ok', 'CAS physical bytes are within the injected quota (or no quota is set).', {
        at,
        physicalBytes,
        quotaBytes: quota ?? null,
      });
    } catch (err) {
      return result('disk', 'not_configured', 'CAS physical bytes could not be read.', {
        at,
        message: safeMessage(err),
      });
    }
  }

  private async checkRetrieval(at: string): Promise<HealthCheckResult> {
    if (!this.deps.retrievalProbe) {
      return result('retrieval', 'not_configured', 'No retrieval probe is injected.', { at });
    }
    try {
      const probe = await this.deps.retrievalProbe();
      return result('retrieval', probe.state, probe.summary, { at, ...probe.evidence });
    } catch (err) {
      return result('retrieval', 'error', 'Retrieval probe failed.', { at, message: safeMessage(err) });
    }
  }

  private async checkBackup(at: string): Promise<HealthCheckResult> {
    if (!this.deps.backupProbe) {
      return result('backup', 'not_configured', 'No backup probe is injected.', { at });
    }
    try {
      const probe = await this.deps.backupProbe();
      return result('backup', probe.state, probe.summary, { at, ...probe.evidence });
    } catch (err) {
      return result('backup', 'error', 'Backup probe failed.', { at, message: safeMessage(err) });
    }
  }

  private checkProviders(at: string): HealthCheckResult {
    const map = this.deps.providerHealth;
    if (!map || Object.keys(map).length === 0) {
      return result('providers', 'not_configured', 'Provider health is host-owned and was not injected.', { at });
    }
    const states = Object.values(map);
    const state: HealthCheckState = states.includes('error')
      ? 'error'
      : states.includes('warn')
        ? 'warn'
        : states.every((item) => item === 'not_configured')
          ? 'not_configured'
          : 'ok';
    const summary =
      state === 'ok'
        ? 'Injected provider health map reports no faults.'
        : state === 'warn'
          ? 'Injected provider health map reports a warning.'
          : state === 'error'
            ? 'Injected provider health map reports an error.'
            : 'Injected provider health map is not configured.';
    return result('providers', state, summary, { at, providers: map });
  }

  private checkArchitecture(at: string): HealthCheckResult {
    const flags = this.deps.flags ?? new EnvFlagStore();
    return result(
      'architecture',
      'ok',
      'Architecture invariants are enforced in CI; this check does not replace CI.',
      {
        at,
        replacesCi: false,
        flags: {
          tools: flags.enabled('tools'),
          generation: flags.enabled('generation'),
          dungeonWriting: flags.enabled('dungeon.writing'),
          providers: flags.enabled('providers'),
        },
      },
    );
  }
}

export function rollupOperationalState(checks: HealthCheckResult[]): OperationalState {
  const errors = checks.filter((check) => check.state === 'error');
  if (errors.some((check) => check.id === 'postgres' || check.id === 'cas')) return 'CRITICAL';
  if (errors.length > 0) return 'ATTENTION_REQUIRED';
  if (checks.some((check) => check.state === 'warn')) return 'DEGRADED';
  return 'HEALTHY';
}

function proposeRepairs(
  checks: HealthCheckResult[],
  ctx: { jobs: DurableJobEngine | null },
): RepairProposal[] {
  const byId = new Map(checks.map((check) => [check.id, check]));
  const proposals: RepairProposal[] = [];
  const stuck = byId.get('stuck_jobs');
  if (ctx.jobs && stuck && (stuck.state === 'warn' || stuck.state === 'error')) {
    proposals.push(recoverExpiredLeasesProposal());
  }
  const migrations = byId.get('migrations');
  if (migrations && (migrations.state === 'warn' || migrations.state === 'error')) {
    const live = migrations.evidence.liveSchemaVersion;
    if (typeof live === 'number' && live < CURRENT_SCHEMA_VERSION) {
      proposals.push(migrateSchemaProposal());
    }
  }
  const disk = byId.get('disk');
  if (disk && (disk.state === 'warn' || disk.state === 'error')) {
    proposals.push(unlinkCasProposal());
  }
  const providers = byId.get('providers');
  if (providers && (providers.state === 'warn' || providers.state === 'error')) {
    proposals.push(reconfigureProvidersProposal());
  }
  return proposals;
}

function result(
  id: CheckId,
  state: HealthCheckState,
  summary: string,
  evidence: Record<string, unknown>,
): HealthCheckResult {
  return { id, state, summary, evidence };
}

function safeMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : 'unknown error';
  return raw.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, '[redacted]');
}
