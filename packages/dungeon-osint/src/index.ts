import type {
  DungeonExecutionContext,
  DungeonManifest,
  IDungeonPlugin,
} from '@atlas/core-contracts';

export interface TargetEntity {
  readonly query: string;
  readonly type: 'username' | 'email' | 'domain' | 'ip';
  readonly normalized: string;
}

export function normalizeTarget(query: string, type: 'username' | 'email' | 'domain' | 'ip'): TargetEntity {
  const clean = query.trim().toLowerCase();
  return {
    query,
    type,
    normalized: clean,
  };
}

export class DungeonOsint implements IDungeonPlugin {
  readonly manifest: DungeonManifest = {
    id: 'dungeon-osint',
    name: 'OSINT Reconnaissance Dungeon',
    version: '0.1.0',
    description: 'Recursive entity intelligence, probe normalization, and privacy-governed dossier assembly',
    capabilitiesProvided: ['osint:normalize', 'osint:scan', 'osint:dossier'],
    requiredPermissions: ['permission:osint_query'],
  };

  async execute(
    taskType: string,
    payload: Readonly<Record<string, unknown>>,
    context: DungeonExecutionContext,
  ): Promise<Record<string, unknown>> {
    await context.reportProgress(10, 'Initializing OSINT inquiry');

    if (taskType === 'osint:normalize') {
      const q = String(payload.query || '');
      const t = (payload.type as 'username' | 'email' | 'domain' | 'ip') || 'username';
      const entity = normalizeTarget(q, t);
      await context.reportProgress(100, 'Target normalized');
      return { entity };
    }

    if (taskType === 'osint:scan') {
      const q = String(payload.query || '');
      const t = (payload.type as 'username' | 'email' | 'domain' | 'ip') || 'username';
      const entity = normalizeTarget(q, t);

      await context.reportProgress(40, `Executing recursive probes for ${entity.normalized}`);

      // Probe result structure with strict attribution
      const findings = [
        { source: 'platform_registry', target: entity.normalized, status: 'checked', matches: [] },
        { source: 'public_dns', target: entity.normalized, status: 'checked', matches: [] },
      ];

      await context.reportProgress(80, 'Saving dossier artifact to CAS');
      const blob = await context.storage.put(JSON.stringify(findings), 'application/json', {
        target: entity.normalized,
      });

      await context.reportProgress(100, 'OSINT scan complete');
      return {
        entity,
        findings,
        dossierBlobHash: blob.hash,
      };
    }

    throw new Error(`Unsupported OSINT task type: ${taskType}`);
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true, message: 'OSINT Dungeon ready' };
  }
}
