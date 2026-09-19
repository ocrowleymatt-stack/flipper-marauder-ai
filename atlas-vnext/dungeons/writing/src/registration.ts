import type { DungeonRegistration } from '@atlas-vnext/contracts';

export const CASPA_WRITING_DUNGEON: DungeonRegistration = {
  id: 'writing',
  slug: 'caspa',
  title: 'Caspa',
  navLabel: 'Caspa',
  description: 'Novelist workspace: manuscript, story bible, characters, structure, continuity, and creative lineage.',
  surface: 'caspa-writing',
  routes: {
    list: '/api/projects/:projectId/documents',
    item: '/api/documents/:id',
    generate: '/api/documents/:id/generate',
    versions: '/api/documents/:id/versions',
    restore: '/api/documents/:id/restore',
    provenance: '/api/documents/:id/provenance',
    lineage: '/api/documents/:id/lineage',
    storyBible: '/api/projects/:projectId/story-bible',
    characters: '/api/projects/:projectId/characters',
    structure: '/api/projects/:projectId/structure',
    continuity: '/api/projects/:projectId/continuity',
  },
  capabilities: ['artifact.read', 'artifact.write', 'project.read', 'file.read', 'conversation.write'],
  permissions: {
    read: 'artifact.read',
    write: 'artifact.write',
  },
  featureAvailable: true,
};
