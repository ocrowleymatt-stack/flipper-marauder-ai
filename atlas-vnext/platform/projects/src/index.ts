import type { DungeonId } from '@atlas-vnext/contracts';
import type { PersistenceActor, PlatformPersistence, WorkspaceRecord } from '@atlas-vnext/persistence';
import { OwnershipError } from '@atlas-vnext/persistence';

export interface Project {
  id: string;
  urn: string;
  tenantId: string;
  name: string;
  description: string | null;
  dungeon: DungeonId | string | null;
  rootManifestHash: string | null;
  archived: boolean;
  revision: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export class ProjectService {
  constructor(private readonly persistence: PlatformPersistence) {}

  async create(
    actor: PersistenceActor,
    input: { name: string; dungeon?: string; description?: string; id?: string },
  ): Promise<Project> {
    this.assertTenant(actor, 'create project');
    const workspace = await this.persistence.ensureWorkspace(actor, input);
    return toProject(workspace);
  }

  async get(actor: PersistenceActor, id: string): Promise<Project | null> {
    this.assertTenant(actor, 'read project');
    const workspace = await this.persistence.forActor(actor).workspaces.get(actor, id);
    return workspace ? toProject(workspace) : null;
  }

  async list(actor: PersistenceActor, opts?: { includeArchived?: boolean }): Promise<Project[]> {
    this.assertTenant(actor, 'list projects');
    const rows = await this.persistence.forActor(actor).workspaces.list(actor, opts);
    return rows.map(toProject);
  }

  async update(
    actor: PersistenceActor,
    id: string,
    patch: { name?: string; description?: string | null; dungeon?: string | null; expectedRevision: number },
  ): Promise<Project> {
    this.assertTenant(actor, 'update project');
    return toProject(await this.persistence.forActor(actor).workspaces.update(actor, id, patch));
  }

  async archive(actor: PersistenceActor, id: string, expectedRevision?: number): Promise<Project> {
    this.assertTenant(actor, 'archive project');
    return toProject(await this.persistence.forActor(actor).workspaces.archive(actor, id, expectedRevision));
  }

  async restore(actor: PersistenceActor, id: string, expectedRevision?: number): Promise<Project> {
    this.assertTenant(actor, 'restore project');
    return toProject(await this.persistence.forActor(actor).workspaces.restore(actor, id, expectedRevision));
  }

  async remove(actor: PersistenceActor, id: string, expectedRevision?: number): Promise<Project> {
    this.assertTenant(actor, 'delete project');
    return toProject(await this.persistence.forActor(actor).workspaces.logicalDelete(actor, id, expectedRevision));
  }

  async bindManifest(actor: PersistenceActor, id: string, manifestHash: string): Promise<Project> {
    this.assertTenant(actor, 'bind project manifest');
    return toProject(await this.persistence.forActor(actor).workspaces.bindManifest(actor, id, manifestHash));
  }

  private assertTenant(actor: PersistenceActor, action: string): void {
    if (!actor?.tenantId?.trim()) {
      throw new OwnershipError(`Fail-closed: cannot ${action} without a tenant id.`);
    }
  }
}

export function toProject(workspace: WorkspaceRecord): Project {
  return {
    id: workspace.id,
    urn: workspace.urn,
    tenantId: workspace.tenantId,
    name: workspace.name,
    description: workspace.description,
    dungeon: workspace.dungeon,
    rootManifestHash: workspace.rootManifestHash,
    archived: workspace.archived,
    revision: workspace.revision,
    deletedAt: workspace.deletedAt,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}

export class ProjectsNotImplementedError extends Error {
  constructor() {
    super('platform/projects is implemented; this error is unused.');
    this.name = 'ProjectsNotImplementedError';
  }
}

/** @deprecated Use ProjectService. Kept so existing type imports compile. */
export interface ProjectStore {
  create(input: { name: string; dungeon: string; tenantId: string }): Promise<Project>;
  get(id: string): Promise<Project | null>;
  bindManifest(id: string, manifestHash: string): Promise<Project>;
}
