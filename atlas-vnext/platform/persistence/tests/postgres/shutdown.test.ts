import { afterEach, describe, expect, it } from 'vitest';
import { PersistenceClosedError } from '../../src/errors.ts';
import { openMemoryPersistence } from '../../src/memory/kernel.ts';
import { openTestKernel, tenantA } from './harness.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe('graceful shutdown', () => {
  it('rejects work after the postgres kernel is closed', async () => {
    const handle = await openTestKernel();
    await handle.kernel.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    const bound = handle.kernel.forActor(tenantA);
    await bound.conversations.create({ title: 'Open', projectId: null });
    await handle.kernel.close();
    await expect(bound.conversations.list()).rejects.toBeInstanceOf(PersistenceClosedError);
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it('rejects work after the memory kernel is closed', async () => {
    const memory = openMemoryPersistence();
    cleanups.push(() => memory.close());
    await memory.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    const bound = memory.forActor(tenantA);
    await memory.close();
    expect(() => memory.forActor(tenantA)).toThrow(PersistenceClosedError);
    await expect(bound.conversations.list()).rejects.toThrow();
  });
});
