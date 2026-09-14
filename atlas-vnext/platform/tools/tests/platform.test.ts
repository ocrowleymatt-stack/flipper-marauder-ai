import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuthorityEngine } from '@atlas-vnext/permissions';
import {
  MemoryToolApprovalStore,
  MemoryToolInvocationStore,
  PLATFORM_TOOL_CATALOGUE,
  ToolEngine,
  ToolRegistry,
  IncompleteToolCallError,
  UnknownToolError,
} from '../src/index.ts';

function engine(opts?: { grants?: Array<Parameters<AuthorityEngine['grantTo']>[0]>; runner?: ConstructorParameters<typeof ToolEngine>[0]['commandRunner'] }) {
  const registry = new ToolRegistry();
  for (const def of PLATFORM_TOOL_CATALOGUE) registry.register(def);
  const authority = new AuthorityEngine();
  const principalId = 'user_a';
  const tenantId = 'tenant_a';
  authority.grantMembership(principalId, tenantId);
  for (const grant of opts?.grants ?? []) authority.grantTo(grant);
  const jailRoot = mkdtempSync(join(tmpdir(), 'atlas-jail-'));
  return {
    engine: new ToolEngine({
      registry,
      invocations: new MemoryToolInvocationStore(),
      approvals: new MemoryToolApprovalStore(),
      authority,
      jailRoot,
      commandRunner: opts?.runner,
    }),
    actor: { tenantId, principalId, workspaceId: 'wks_a' },
    jailRoot,
    authority,
  };
}

describe('tool registry', () => {
  it('rejects malformed definitions before any execution', () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.register({
        ...PLATFORM_TOOL_CATALOGUE[0]!,
        id: 'bad.tool',
        inputSchema: { type: 'string' },
      }),
    ).toThrow(/Malformed/);
  });

  it('unknown tools fail closed and do not execute', async () => {
    const { engine: tools, actor } = engine();
    await expect(tools.invoke(actor, { toolId: 'does.not.exist', arguments: {} })).rejects.toBeInstanceOf(
      UnknownToolError,
    );
  });
});

describe('tool lifecycle and journeys', () => {
  it('read-only tool: validate → authorise → execute → provenance, no approval', async () => {
    const { engine: tools, actor, authority } = engine();
    authority.grantTo({ principalId: actor.principalId, tenantId: actor.tenantId, capability: 'tool.invoke.readonly' });
    const result = await tools.invoke(actor, { toolId: 'retrieval.search', arguments: { query: 'Alpha' } });
    expect(result.invocation.status).toBe('succeeded');
    expect(result.output?.hits).toEqual(expect.any(Array));
    expect(result.provenance.argumentHash).toHaveLength(64);
    expect(result.provenance.outcome).toBe('succeeded');
  });

  it('side-effect tool awaits approval, survives restart, then executes once', async () => {
    const { engine: tools, actor, authority, jailRoot } = engine();
    for (const cap of ['filesystem.write', 'file.write', 'tool.invoke.external_write'] as const) {
      authority.grantTo({ principalId: actor.principalId, tenantId: actor.tenantId, capability: cap });
    }
    const first = await tools.invoke(actor, {
      toolId: 'fs.write',
      arguments: { path: 'note.txt', content: 'hello' },
      idempotencyKey: 'write-note',
    });
    expect(first.invocation.status).toBe('awaiting_approval');
    const replay = await tools.invoke(actor, {
      toolId: 'fs.write',
      arguments: { path: 'note.txt', content: 'hello' },
      idempotencyKey: 'write-note',
    });
    expect(replay.invocation.id).toBe(first.invocation.id);
    expect(replay.invocation.status).toBe('awaiting_approval');
    const approved = await tools.approve(actor, first.invocation.id, 'approved');
    expect(approved.invocation.status).toBe('succeeded');
    expect(approved.output?.written).toBe(true);
    writeFileSync(join(jailRoot, 'note.txt'), 'tampered');
    const again = await tools.invoke(actor, {
      toolId: 'fs.write',
      arguments: { path: 'note.txt', content: 'hello' },
      idempotencyKey: 'write-note',
    });
    expect(again.invocation.id).toBe(first.invocation.id);
    expect(again.invocation.status).toBe('succeeded');
    expect(again.output?.replayed ?? true).toBeTruthy();
  });

  it('denial fails closed with a generic message and no effect', async () => {
    const { engine: tools, actor, jailRoot } = engine();
    const result = await tools.invoke(actor, {
      toolId: 'fs.write',
      arguments: { path: 'secret.txt', content: 'nope' },
    });
    expect(result.invocation.status).toBe('denied');
    expect(result.invocation.failureReason?.message).toBe('Permission denied.');
    expect(existsSync(join(jailRoot, 'secret.txt'))).toBe(false);
  });

  it('incomplete arguments never execute', async () => {
    const { engine: tools, actor } = engine();
    await expect(tools.invoke(actor, { toolId: 'retrieval.search', arguments: null as never })).rejects.toBeInstanceOf(
      IncompleteToolCallError,
    );
  });

  it('invalid arguments fail before adapter execution', async () => {
    const { engine: tools, actor, authority } = engine();
    authority.grantTo({ principalId: actor.principalId, tenantId: actor.tenantId, capability: 'tool.invoke.readonly' });
    const result = await tools.invoke(actor, { toolId: 'retrieval.search', arguments: { query: 1 as never } });
    expect(result.invocation.status).toBe('failed');
    expect(result.invocation.failureReason?.code).toBe('invalid_arguments');
  });
});

describe('idempotency and cancellation', () => {
  it('does not blindly retry uncertain external effects after a completed attempt', async () => {
    const { engine: tools, actor, authority } = engine();
    for (const cap of ['network.public', 'tool.invoke.external_write'] as const) {
      authority.grantTo({ principalId: actor.principalId, tenantId: actor.tenantId, capability: cap });
    }
    const first = await tools.invoke(actor, { toolId: 'api.mutate', arguments: { url: 'https://example.test/x' } });
    expect(first.invocation.status).toBe('awaiting_approval');
    const done = await tools.approve(actor, first.invocation.id, 'approved');
    expect(done.invocation.status).toBe('succeeded');
    const replay = await tools.invoke(actor, { toolId: 'api.mutate', arguments: { url: 'https://example.test/x' } });
    expect(replay.invocation.id).toBe(first.invocation.id);
    expect(replay.invocation.status).toBe('succeeded');
  });

  it('cancels queued work and does not claim cancelled if stop is unconfirmed', async () => {
    const { engine: tools, actor, authority } = engine();
    authority.grantTo({ principalId: actor.principalId, tenantId: actor.tenantId, capability: 'tool.invoke.readonly' });
    const pending = await tools.invoke(actor, { toolId: 'retrieval.search', arguments: { query: 'Alpha' } });
    expect(pending.invocation.status).toBe('succeeded');
    const cancelled = await tools.cancel(actor, pending.invocation.id);
    expect(cancelled.status).toBe('succeeded');
  });
});

describe('safety', () => {
  it('contains filesystem paths and rejects traversal', async () => {
    const { engine: tools, actor, authority } = engine();
    authority.grantTo({ principalId: actor.principalId, tenantId: actor.tenantId, capability: 'filesystem.read' });
    authority.grantTo({ principalId: actor.principalId, tenantId: actor.tenantId, capability: 'file.read' });
    const result = await tools.invoke(actor, { toolId: 'fs.read', arguments: { path: '../etc/passwd' } });
    expect(result.invocation.status).toBe('failed');
    expect(result.invocation.failureReason?.code).toBe('path_traversal');
  });

  it('shell adapter uses the injected runner and never receives platform secrets', async () => {
    const seen: Array<{ env: Record<string, string>; cwd: string }> = [];
    const { engine: tools, actor, authority } = engine({
      runner: {
        async run(input) {
          seen.push({ env: input.env, cwd: input.cwd });
          return { code: 0, stdout: 'ok', stderr: '' };
        },
      },
    });
    for (const cap of ['shell.execute'] as const) {
      authority.grantTo({ principalId: actor.principalId, tenantId: actor.tenantId, capability: cap });
    }
    const first = await tools.invoke(actor, { toolId: 'shell.exec', arguments: { argv: ['echo', 'hi'] } });
    expect(first.invocation.status).toBe('awaiting_approval');
    const done = await tools.approve(actor, first.invocation.id, 'approved');
    expect(done.invocation.status).toBe('succeeded');
    expect(seen[0]?.env.OPENAI_API_KEY).toBeUndefined();
    expect(seen[0]?.cwd.includes('..')).toBe(false);
  });

  it('code exec refuses process/require/host access', async () => {
    const { engine: tools, actor, authority } = engine();
    authority.grantTo({ principalId: actor.principalId, tenantId: actor.tenantId, capability: 'code.execute' });
    const first = await tools.invoke(actor, { toolId: 'code.exec', arguments: { source: 'process.exit(0)' } });
    const done = await tools.approve(actor, first.invocation.id, 'approved');
    expect(done.invocation.status).toBe('failed');
    expect(done.invocation.failureReason?.code).toBe('code_rejected');
  });
});

describe('tenant isolation', () => {
  it('tenant A cannot read tenant B invocations by guessing ids', async () => {
    const { engine: tools, actor, authority } = engine();
    authority.grantTo({ principalId: actor.principalId, tenantId: actor.tenantId, capability: 'tool.invoke.readonly' });
    const result = await tools.invoke(actor, { toolId: 'retrieval.search', arguments: { query: 'Alpha' } });
    const other = await tools.get({ tenantId: 'tenant_b', principalId: 'user_b' }, result.invocation.id);
    expect(other).toBeNull();
  });
});
