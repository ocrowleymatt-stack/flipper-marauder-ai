import type { DungeonRegistration } from '@atlas-vnext/contracts';

export const OSINT_DUNGEON: DungeonRegistration = {
  id: 'osint',
  slug: 'osint',
  title: 'OSINT',
  navLabel: 'OSINT',
  description: 'Targeted public-source correlation over Atlas jobs, CAS, Nexus, and Authority.',
  surface: 'osint-desk',
  routes: {
    list: '/api/projects/:projectId/osint/targets',
    scan: '/api/projects/:projectId/osint/scans',
    item: '/api/osint/:id',
  },
  capabilities: ['project.read', 'artifact.read', 'artifact.write', 'network.public'],
  permissions: { read: 'artifact.read', write: 'artifact.write' },
  featureAvailable: true,
};
