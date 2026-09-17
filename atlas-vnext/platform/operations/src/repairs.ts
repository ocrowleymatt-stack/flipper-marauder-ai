import type { CheckId, RepairExecution, RepairProposal } from '@atlas-vnext/contracts';
import type { DurableJobEngine } from '@atlas-vnext/jobs';
import type { AuthorityEngine, AuthorityPrincipal } from '@atlas-vnext/permissions';
import type { OperationsDoctor } from './doctor.ts';

export const REPAIR_RECOVER_EXPIRED_LEASES = 'repair.recover_expired_leases';
export const REPAIR_MIGRATE_SCHEMA = 'repair.migrate_schema';
export const REPAIR_UNLINK_CAS = 'repair.unlink_cas';
export const REPAIR_RECONFIGURE_PROVIDERS = 'repair.reconfigure_providers';

const ADMIN = 'admin.configure' as const;

export function recoverExpiredLeasesProposal(): RepairProposal {
  return Object.freeze({
    id: REPAIR_RECOVER_EXPIRED_LEASES,
    checkId: 'stuck_jobs',
    repairClass: 'harmless_reversible',
    title: 'Recover jobs with expired worker leases',
    steps: [
      'Identify jobs whose worker leases have expired while still marked running.',
      'Re-queue those jobs from their last checkpoint so a worker can claim them again.',
      'Do not delete job records or alter checkpoints.',
    ],
    requiresCapability: ADMIN,
    rollback: null,
  });
}

export function migrateSchemaProposal(): RepairProposal {
  return Object.freeze({
    id: REPAIR_MIGRATE_SCHEMA,
    checkId: 'migrations',
    repairClass: 'consequential',
    title: 'Apply PostgreSQL schema migrations',
    steps: [
      'Compare the live schema version to the packaged schema version.',
      'Apply pending migrations only after a human reviews this consequential change.',
      'This substrate never auto-applies migrations.',
    ],
    requiresCapability: ADMIN,
    rollback: 'Restore the database from a backup taken before the migration.',
  });
}

export function unlinkCasProposal(): RepairProposal {
  return Object.freeze({
    id: REPAIR_UNLINK_CAS,
    checkId: 'disk',
    repairClass: 'consequential',
    title: 'Unlink unreferenced CAS objects',
    steps: [
      'Identify CAS objects whose metadata refcount is zero.',
      'Unlink those objects from the blob store only after a human approves.',
      'This substrate never unlinks CAS objects automatically.',
    ],
    requiresCapability: ADMIN,
    rollback: 'CAS unlinks are not automatically reversed; restore objects from backup.',
  });
}

export function reconfigureProvidersProposal(): RepairProposal {
  return Object.freeze({
    id: REPAIR_RECONFIGURE_PROVIDERS,
    checkId: 'providers',
    repairClass: 'consequential',
    title: 'Change provider configuration',
    steps: [
      'Review the injected provider health map owned by the host.',
      'Change provider credentials or routing only after a human approves.',
      'This substrate never writes provider configuration.',
    ],
    requiresCapability: ADMIN,
    rollback: 'Restore the previous provider configuration from versioned host config.',
  });
}

export function proposalForCheck(checkId: CheckId): RepairProposal | null {
  if (checkId === 'stuck_jobs') return recoverExpiredLeasesProposal();
  if (checkId === 'migrations') return migrateSchemaProposal();
  if (checkId === 'disk') return unlinkCasProposal();
  if (checkId === 'providers') return reconfigureProvidersProposal();
  return null;
}

export interface RepairExecutorDeps {
  doctor: OperationsDoctor;
  authority: AuthorityEngine;
  jobs?: DurableJobEngine | null;
}

/**
 * Authority-aware repair applicator.
 *
 * Harmless recoverExpiredLeases may run when ALLOW.
 * Consequential proposals stay `proposed` even when ALLOW — a human must apply them.
 */
export class RepairExecutor {
  constructor(private readonly deps: RepairExecutorDeps) {}

  async apply(actor: AuthorityPrincipal, proposal: RepairProposal): Promise<RepairExecution> {
    const verdict = this.deps.authority.decide({
      principal: actor,
      capability: proposal.requiresCapability,
    });
    if (verdict.decision !== 'ALLOW') {
      return {
        proposalId: proposal.id,
        status: 'denied',
        authorityDecision: 'DENY',
      };
    }

    if (proposal.repairClass === 'consequential' || isConsequentialId(proposal.id)) {
      return {
        proposalId: proposal.id,
        status: 'proposed',
        authorityDecision: 'ALLOW',
      };
    }

    if (proposal.id === REPAIR_RECOVER_EXPIRED_LEASES && proposal.repairClass === 'harmless_reversible') {
      await this.deps.jobs?.recoverExpiredLeases();
      return {
        proposalId: proposal.id,
        status: 'applied',
        authorityDecision: 'ALLOW',
      };
    }

    return {
      proposalId: proposal.id,
      status: 'proposed',
      authorityDecision: 'ALLOW',
    };
  }

  async verify(
    actor: AuthorityPrincipal,
    previous?: RepairExecution,
  ): Promise<{ report: Awaited<ReturnType<OperationsDoctor['inspect']>>; execution: RepairExecution | null }> {
    const report = await this.deps.doctor.inspect(actor);
    if (!previous || previous.status === 'denied' || previous.authorityDecision === 'DENY') {
      return { report, execution: previous ?? null };
    }
    if (previous.status !== 'applied') {
      return { report, execution: previous };
    }
    const related = relatedCheckId(previous.proposalId);
    const check = related ? report.checks.find((item) => item.id === related) : undefined;
    const recovered = !check || check.state === 'ok' || check.state === 'not_configured';
    return {
      report,
      execution: {
        ...previous,
        status: recovered ? 'verified' : 'applied',
      },
    };
  }
}

function isConsequentialId(id: string): boolean {
  return id === REPAIR_MIGRATE_SCHEMA || id === REPAIR_UNLINK_CAS || id === REPAIR_RECONFIGURE_PROVIDERS;
}

function relatedCheckId(proposalId: string): CheckId | null {
  if (proposalId === REPAIR_RECOVER_EXPIRED_LEASES) return 'stuck_jobs';
  if (proposalId === REPAIR_MIGRATE_SCHEMA) return 'migrations';
  if (proposalId === REPAIR_UNLINK_CAS) return 'disk';
  if (proposalId === REPAIR_RECONFIGURE_PROVIDERS) return 'providers';
  return null;
}
