import { createHash } from 'node:crypto';
import type { ManifestEntry, ProjectManifest } from '@atlas-vnext/contracts';
import type { BlobStore, ManifestStore } from './cas.ts';
import { sha256Hex } from './cas.ts';

function canonicalEntries(entries: ManifestEntry[]): ManifestEntry[] {
  return [...entries]
    .map((entry) => ({
      path: entry.path,
      sha256: entry.sha256.toLowerCase(),
      mimeType: entry.mimeType,
      sizeBytes: entry.sizeBytes,
      executable: Boolean(entry.executable),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function hashManifestEntries(entries: ManifestEntry[]): string {
  const canonical = canonicalEntries(entries);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export class CasManifestStore implements ManifestStore {
  private readonly byHash = new Map<string, ProjectManifest>();
  private readonly byProject = new Map<string, string>();

  constructor(
    private readonly blobs: BlobStore,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  async put(projectId: string, entries: ManifestEntry[]): Promise<ProjectManifest> {
    const canonical = canonicalEntries(entries);
    for (const entry of canonical) {
      if (!(await this.blobs.has(entry.sha256))) {
        throw new Error(`Manifest entry ${entry.path} references missing CAS object ${entry.sha256}.`);
      }
    }
    const manifestHash = hashManifestEntries(canonical);
    const record: ProjectManifest = {
      version: 1,
      projectId,
      manifestHash,
      entries: canonical,
      createdAt: this.clock(),
    };
    const encoded = new TextEncoder().encode(JSON.stringify(record));
    const stored = await this.blobs.put(encoded);
    if (stored.sha256 !== sha256Hex(encoded)) {
      throw new Error('Manifest blob hash mismatch.');
    }
    this.byHash.set(manifestHash, record);
    this.byProject.set(projectId, manifestHash);
    return record;
  }

  async get(manifestHash: string): Promise<ProjectManifest | null> {
    return this.byHash.get(manifestHash.toLowerCase()) ?? null;
  }

  current(projectId: string): string | null {
    return this.byProject.get(projectId) ?? null;
  }
}
