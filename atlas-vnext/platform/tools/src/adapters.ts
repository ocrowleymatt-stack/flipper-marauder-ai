import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import vm from 'node:vm';
import type { OperationalLimits, ToolDefinition, ToolInvocation } from '@atlas-vnext/contracts';
import type { DurableJobEngine } from '@atlas-vnext/jobs';
import { ToolError } from './errors.ts';
import { boundText, containPath, filterEnv } from './sandbox.ts';
import type { ToolActor } from './store.ts';

export interface ToolAdapterContext {
  actor: ToolActor;
  invocation: ToolInvocation;
  definition: ToolDefinition;
  signal: AbortSignal;
  jailRoot: string;
  limits: OperationalLimits;
  secretNames: string[];
  jobs?: DurableJobEngine;
  env?: Record<string, string | undefined>;
  recordEffect(key: string, value: unknown): Promise<'recorded' | 'replayed'>;
  lookupEffect(key: string): Promise<unknown | null>;
}

export interface ToolAdapterResult {
  output: Record<string, unknown>;
  resultRef?: string | null;
  artefactIds?: string[];
  fileIds?: string[];
  externalIds?: string[];
  jobId?: string | null;
}

export interface ToolAdapter {
  readonly id: string;
  execute(input: Record<string, unknown>, ctx: ToolAdapterContext): Promise<ToolAdapterResult>;
  cancel?(ctx: ToolAdapterContext): Promise<{ confirmed: boolean }>;
}

const retrievalDocs = [
  { id: 'doc_alpha', title: 'Alpha brief', text: 'Alpha is a read-only retrieval fixture.' },
  { id: 'doc_beta', title: 'Beta notes', text: 'Beta is tenant-scoped mock knowledge.' },
];

export const retrievalAdapter: ToolAdapter = {
  id: 'retrieval.readonly',
  async execute(input, ctx) {
    const query = String(input.query ?? '').toLowerCase();
    const hits = retrievalDocs.filter((doc) => doc.title.toLowerCase().includes(query) || doc.text.toLowerCase().includes(query));
    return {
      output: {
        hits: hits.map((doc) => ({ id: doc.id, title: doc.title, snippet: doc.text })),
        tenantId: ctx.actor.tenantId,
      },
    };
  },
};

export const fsReadAdapter: ToolAdapter = {
  id: 'fs.read',
  async execute(input, ctx) {
    const path = containPath(ctx.jailRoot, String(input.path ?? ''));
    const content = boundText(readFileSync(path, 'utf8'), ctx.limits.maxShellOutputBytes);
    return { output: { path: relative(ctx.jailRoot, path), content, bytes: Buffer.byteLength(content) } };
  },
};

export const fsWriteAdapter: ToolAdapter = {
  id: 'fs.write',
  async execute(input, ctx) {
    const path = containPath(ctx.jailRoot, String(input.path ?? ''));
    const content = String(input.content ?? '');
    const effectKey = `fs.write:${ctx.actor.tenantId}:${relative(ctx.jailRoot, path)}:${ctx.invocation.argumentHash}`;
    const replay = await ctx.recordEffect(effectKey, { path, bytes: Buffer.byteLength(content) });
    if (replay === 'replayed') {
      return { output: { path: relative(ctx.jailRoot, path), written: false, replayed: true } };
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
    return { output: { path: relative(ctx.jailRoot, path), written: true, bytes: Buffer.byteLength(content) } };
  },
};

interface BrowserPage {
  url: string;
  title: string;
  body: string;
}

const browsers = new Map<string, BrowserPage>();

export const browserReadAdapter: ToolAdapter = {
  id: 'browser.navigate',
  async execute(input, ctx) {
    const url = String(input.url ?? 'about:blank');
    const page: BrowserPage = {
      url,
      title: `Mock page for ${url}`,
      body: `Read-only snapshot of ${url}`,
    };
    browsers.set(ctx.actor.tenantId, page);
    return { output: { url: page.url, title: page.title, body: page.body } };
  },
};

export const browserSubmitAdapter: ToolAdapter = {
  id: 'browser.submit',
  async execute(input, ctx) {
    const url = String(input.url ?? '');
    const effectKey = `browser.submit:${ctx.actor.tenantId}:${url}:${ctx.invocation.argumentHash}`;
    const replay = await ctx.recordEffect(effectKey, { url });
    if (replay === 'replayed') return { output: { submitted: false, replayed: true, url } };
    browsers.set(ctx.actor.tenantId, { url, title: 'Submitted', body: 'form accepted' });
    return { output: { submitted: true, url }, externalIds: [`browser:${url}`] };
  },
};

export const apiReadAdapter: ToolAdapter = {
  id: 'api.read',
  async execute(input) {
    return {
      output: {
        url: String(input.url ?? ''),
        status: 200,
        body: { mock: true, method: 'GET' },
      },
    };
  },
};

export const apiMutateAdapter: ToolAdapter = {
  id: 'api.mutate',
  async execute(input, ctx) {
    const url = String(input.url ?? '');
    const method = String(input.method ?? 'POST');
    const effectKey = `api.mutate:${ctx.actor.tenantId}:${method}:${url}:${ctx.invocation.argumentHash}`;
    const replay = await ctx.recordEffect(effectKey, { url, method });
    if (replay === 'replayed') return { output: { replayed: true, status: 200, url } };
    return { output: { replayed: false, status: 201, url, method }, externalIds: [`api:${method}:${url}`] };
  },
};

export interface CommandRunner {
  run(input: {
    argv: string[];
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    maxBytes: number;
    signal: AbortSignal;
  }): Promise<{ code: number; stdout: string; stderr: string }>;
}

export const COMMAND_SIGTERM_GRACE_MS = 200;

export const defaultCommandRunner: CommandRunner = {
  async run(input) {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(input.argv[0] ?? 'true', input.argv.slice(1), {
        cwd: input.cwd,
        env: input.env,
        timeout: input.timeoutMs,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        input.signal.removeEventListener('abort', onAbort);
        if (killTimer) clearTimeout(killTimer);
        fn();
      };
      const armKill = (): void => {
        if (child.pid) child.kill('SIGTERM');
        if (killTimer) clearTimeout(killTimer);
        killTimer = setTimeout(() => {
          if (child.pid) child.kill('SIGKILL');
        }, COMMAND_SIGTERM_GRACE_MS);
      };
      const onAbort = (): void => {
        armKill();
      };
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener('abort', onAbort);
      child.once('spawn', () => {
        if (input.signal.aborted) armKill();
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = boundText(stdout + chunk.toString('utf8'), input.maxBytes);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = boundText(stderr + chunk.toString('utf8'), input.maxBytes);
      });
      child.on('error', (err) => {
        finish(() => reject(err));
      });
      child.on('close', (code) => {
        finish(() => resolvePromise({ code: code ?? 1, stdout, stderr }));
      });
    });
  },
};

export function createShellAdapter(runner: CommandRunner = defaultCommandRunner): ToolAdapter {
  return {
    id: 'shell.exec',
    async execute(input, ctx) {
      const argv = Array.isArray(input.argv) ? input.argv.map(String) : [];
      if (argv.length === 0) throw new ToolError('invalid_arguments', 'argv is required.', false);
      const cwd = containPath(ctx.jailRoot, String(input.cwd ?? '.'));
      const env = filterEnv(ctx.env ?? {}, ['PATH', 'HOME', 'LANG', 'TZ'], ctx.secretNames);
      const result = await runner.run({
        argv,
        cwd,
        env,
        timeoutMs: ctx.limits.shellTimeoutMs,
        maxBytes: ctx.limits.maxShellOutputBytes,
        signal: ctx.signal,
      });
      return { output: { code: result.code, stdout: result.stdout, stderr: result.stderr } };
    },
  };
}

export const codeExecAdapter: ToolAdapter = {
  id: 'code.exec',
  async execute(input, ctx) {
    const source = String(input.source ?? '');
    if (/\bprocess\b|\brequire\b|\bglobalThis\b|\bFunction\b|\bimport\b/.test(source)) {
      throw new ToolError('code_rejected', 'Fail-closed: code must not access process, require, or import.', false);
    }
    const sandbox = { result: undefined as unknown, console: { log() {} } };
    vm.runInNewContext(source, sandbox, { timeout: ctx.limits.codeTimeoutMs, displayErrors: false });
    const text = boundText(JSON.stringify(sandbox.result ?? null), ctx.limits.maxCodeOutputBytes);
    return { output: { result: JSON.parse(text) } };
  },
};

export const jobAdapter: ToolAdapter = {
  id: 'job.long_running',
  async execute(input, ctx) {
    if (!ctx.jobs) throw new ToolError('jobs_unavailable', 'Fail-closed: job engine is required.', false);
    const job = await ctx.jobs.enqueue(
      { tenantId: ctx.actor.tenantId, workspaceId: ctx.actor.workspaceId, principalId: ctx.actor.principalId },
      {
        dungeon: 'platform',
        type: 'tool.long_running',
        idempotencyKey: ctx.invocation.idempotencyKey ?? ctx.invocation.id,
        checkpoint: { toolId: ctx.definition.id, invocationId: ctx.invocation.id, input },
      },
    );
    return { output: { jobId: job.id, status: job.status }, jobId: job.id };
  },
};

export const projectFileAdapter: ToolAdapter = {
  id: 'project.file_op',
  async execute(input, ctx) {
    const op = String(input.op ?? 'stat');
    const path = containPath(ctx.jailRoot, String(input.path ?? '.'));
    return {
      output: { op, path: relative(ctx.jailRoot, path), tenantId: ctx.actor.tenantId },
      fileIds: op === 'attach' ? [`file:${relative(ctx.jailRoot, path)}`] : [],
    };
  },
};

export const publishAdapter: ToolAdapter = {
  id: 'communication.publish',
  async execute(input, ctx) {
    const channel = String(input.channel ?? 'outbox');
    const effectKey = `publish:${ctx.actor.tenantId}:${channel}:${ctx.invocation.argumentHash}`;
    const replay = await ctx.recordEffect(effectKey, { channel });
    if (replay === 'replayed') return { output: { published: false, replayed: true, channel } };
    return { output: { published: true, channel }, externalIds: [`pub:${channel}`] };
  },
};

export const adminAdapter: ToolAdapter = {
  id: 'admin.configure',
  async execute(input, ctx) {
    return {
      output: {
        applied: true,
        key: String(input.key ?? ''),
        tenantId: ctx.actor.tenantId,
      },
    };
  },
};

export const mockEchoAdapter: ToolAdapter = {
  id: 'mock.echo',
  async execute(input, ctx) {
    return {
      output: {
        echo: input,
        tenantId: ctx.actor.tenantId,
        plugin: ctx.definition.pluginId ?? null,
      },
    };
  },
};

export function defaultAdapters(runner?: CommandRunner): ToolAdapter[] {
  return [
    retrievalAdapter,
    fsReadAdapter,
    fsWriteAdapter,
    browserReadAdapter,
    browserSubmitAdapter,
    apiReadAdapter,
    apiMutateAdapter,
    createShellAdapter(runner),
    codeExecAdapter,
    jobAdapter,
    projectFileAdapter,
    publishAdapter,
    adminAdapter,
    mockEchoAdapter,
  ];
}
