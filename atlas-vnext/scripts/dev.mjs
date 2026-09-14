#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(new URL('..', import.meta.url)));
const bin = join(root, 'node_modules', '.bin');

const env = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH ?? ''}`,
  PORT: process.env.PORT ?? '8787',
};

const host = spawn('tsx', ['apps/host/src/main.ts'], { cwd: root, env, stdio: 'inherit' });
const web = spawn('npm', ['run', 'dev', '-w', '@atlas-vnext/web'], { cwd: root, env, stdio: 'inherit' });

function shutdown(code = 0) {
  host.kill('SIGTERM');
  web.kill('SIGTERM');
  process.exit(code);
}

host.on('exit', (code) => {
  if (code) shutdown(code);
});
web.on('exit', (code) => {
  if (code) shutdown(code);
});
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
