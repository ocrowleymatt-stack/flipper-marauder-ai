import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MemoryRunPodClient } from '@atlas-vnext/execution';
import { AuthorityEngine } from '@atlas-vnext/permissions';
import {
  MemoryToolApprovalStore,
  MemoryToolInvocationStore,
  PLATFORM_TOOL_CATALOGUE,
  ToolEngine,
  ToolRegistry,
} from '../src/index.ts';
import { createJobEngine, MemoryJobStore } from '@atlas-vnext/jobs';

const toolsRoot = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('RunPod contract for tools', () => {
  it('does not import execution runtime or start pods', async () => {
    for (const file of sourceFiles(toolsRoot)) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toMatch(/@atlas-vnext\/execution/);
      expect(text).not.toMatch(/RuntimeScheduler|createPod|RUNPOD/);
    }
    const client = new MemoryRunPodClient();
    const registry = new ToolRegistry();
    for (const def of PLATFORM_TOOL_CATALOGUE) registry.register(def);
    const authority = new AuthorityEngine();
    authority.grantMembership('user_a', 'tenant_a');
    authority.grantTo({ principalId: 'user_a', tenantId: 'tenant_a', capability: 'tool.invoke' });
    const engine = new ToolEngine({
      registry,
      invocations: new MemoryToolInvocationStore(),
      approvals: new MemoryToolApprovalStore(),
      authority,
      jobs: createJobEngine({ store: new MemoryJobStore() }),
    });
    const result = await engine.invoke(
      { tenantId: 'tenant_a', principalId: 'user_a' },
      { toolId: 'job.run', arguments: { label: 'x' } },
    );
    expect(result.invocation.status).toBe('succeeded');
    expect(result.output?.jobId).toEqual(expect.any(String));
    expect(client.startCalls).toEqual([]);
  });
});
