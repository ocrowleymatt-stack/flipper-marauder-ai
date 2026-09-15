import type { DungeonRegistration } from '@atlas-vnext/contracts';

export const CASPA_WRITING_DUNGEON: DungeonRegistration = {
  id: 'writing',
  slug: 'caspa',
  title: 'Caspa',
  navLabel: 'Writing',
  description: 'Durable writing workspace over Atlas projects, files, Nexus, Execution, and Authority.',
  surface: 'caspa-writing',
  routes: {
    list: '/api/projects/:projectId/documents',
    item: '/api/documents/:id',
    generate: '/api/documents/:id/generate',
    versions: '/api/documents/:id/versions',
    restore: '/api/documents/:id/restore',
    provenance: '/api/documents/:id/provenance',
  },
  capabilities: ['artifact.read', 'artifact.write', 'project.read', 'file.read', 'conversation.write'],
  permissions: {
    read: 'artifact.read',
    write: 'artifact.write',
  },
  featureAvailable: true,
};
