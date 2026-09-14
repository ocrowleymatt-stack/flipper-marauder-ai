import type { DungeonId } from '@atlas-vnext/contracts';

export interface Project {
  id: string;
  tenantId: string;
  name: string;
  dungeon: DungeonId | string;
  rootManifestHash: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectStore {
  create(input: { name: string; dungeon: string; tenantId: string }): Promise<Project>;
  get(id: string): Promise<Project | null>;
  bindManifest(id: string, manifestHash: string): Promise<Project>;
}

export class ProjectsNotImplementedError extends Error {
  constructor() {
    super('platform/projects is a design-gate shell; durable implementation is deferred.');
    this.name = 'ProjectsNotImplementedError';
  }
}
