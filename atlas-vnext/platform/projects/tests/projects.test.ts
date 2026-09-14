import { describe, expect, it } from 'vitest';
import { openMemoryPersistence, OwnershipError, ConflictError } from '@atlas-vnext/persistence';
import { ProjectService } from '@atlas-vnext/projects';

describe('projects', () => {
  it('creates, lists, updates, and isolates by tenant without raw-id bypass', async () => {
    const persistence = openMemoryPersistence();
    const projects = new ProjectService(persistence);
    const a = { tenantId: 'tenant_a' };
    const b = { tenantId: 'tenant_b' };
    await persistence.ensureTenant({ id: 'tenant_a', name: 'A' });
    await persistence.ensureTenant({ id: 'tenant_b', name: 'B' });
    const project = await projects.create(a, { name: 'Casefile', dungeon: 'investigation', description: 'src' });
    expect(project.tenantId).toBe('tenant_a');
    expect(project.revision).toBe(1);
    expect(await projects.get(b, project.id)).toBeNull();
    expect(await projects.list(b)).toEqual([]);
    const renamed = await projects.update(a, project.id, { name: 'Casefile v2', expectedRevision: 1 });
    expect(renamed.name).toBe('Casefile v2');
    expect(renamed.revision).toBe(2);
    await expect(projects.update(a, project.id, { name: 'stale', expectedRevision: 1 })).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(projects.create({ tenantId: '' }, { name: 'nope' })).rejects.toBeInstanceOf(OwnershipError);
    const archived = await projects.archive(a, project.id, 2);
    expect(archived.archived).toBe(true);
    expect(await projects.list(a)).toEqual([]);
    expect(await projects.list(a, { includeArchived: true })).toHaveLength(1);
    const restored = await projects.restore(a, project.id);
    expect(restored.archived).toBe(false);
    const removed = await projects.remove(a, restored.id, restored.revision);
    expect(removed.deletedAt).toBeTruthy();
    expect(await projects.get(a, project.id)).toBeNull();
  });
});
