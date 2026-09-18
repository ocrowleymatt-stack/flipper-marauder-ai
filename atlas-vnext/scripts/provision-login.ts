#!/usr/bin/env node
/**
 * Operator-only first-owner / credential provisioner.
 *
 * Reads the password from stdin (TTY: hidden prompt). Never from argv.
 * Uses existing principal + membership. Does not issue a session.
 *
 *   ATLAS_DATABASE_URL=... ATLAS_TENANT_ID=... ATLAS_PRINCIPAL_ID=... \
 *     npx tsx scripts/provision-login.ts --login owner
 */
import { parseArgs } from 'node:util';
import { readPersistenceConfig, openPlatformPersistence } from '@atlas-vnext/persistence';
import { AuthService, LoginService } from '@atlas-vnext/auth';
import { logPlatform } from '@atlas-vnext/observability';

const parsed = parseArgs({
  options: {
    login: { type: 'string' },
    principal: { type: 'string' },
    tenant: { type: 'string' },
    role: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
  allowPositionals: false,
});

if (parsed.values.help) {
  process.stderr.write(
    'provision-login --login <id> [--principal id] [--tenant id] [--role owner]\nPassword is read from stdin.\n',
  );
  process.exit(0);
}

if (process.argv.some((arg) => arg.startsWith('--password') || arg.startsWith('-p='))) {
  process.stderr.write('Refusing --password. Provide the secret on stdin.\n');
  process.exit(2);
}

const loginId = parsed.values.login?.trim();
if (!loginId) {
  process.stderr.write('Missing --login.\n');
  process.exit(2);
}

const tenantId = (parsed.values.tenant ?? process.env.ATLAS_TENANT_ID ?? '').trim();
const principalId = (parsed.values.principal ?? process.env.ATLAS_PRINCIPAL_ID ?? (tenantId ? `principal_${tenantId}` : '')).trim();
const role = (parsed.values.role ?? 'owner').trim() || 'owner';

if (!tenantId || !principalId) {
  process.stderr.write('ATLAS_TENANT_ID and a principal id are required.\n');
  process.exit(2);
}

const password = (await readSecret('Password: ')).replace(/\r?\n$/, '');
if (!password) {
  process.stderr.write('Empty password refused.\n');
  process.exit(2);
}

const config = readPersistenceConfig(process.env);
if (config.mode !== 'postgres') {
  process.stderr.write('provision-login requires PostgreSQL (ATLAS_DATABASE_URL).\n');
  process.exit(2);
}

const persistence = await openPlatformPersistence(config);
try {
  await persistence.ensureTenant({ id: tenantId, name: tenantId });
  await persistence.ensurePrincipal({ id: principalId, displayName: principalId });
  const bound = persistence.forActor({ tenantId, principalId });
  const existing = await bound.directory.getTenantMembership(principalId, tenantId);
  if (!existing) {
    await bound.directory.putTenantMembership({
      principalId,
      tenantId,
      role,
      capabilities: [],
      createdAt: new Date().toISOString(),
    });
  }
  const production = process.env.NODE_ENV === 'production' || process.env.ATLAS_ENV === 'production';
  const auth = new AuthService({
    sessions: bound.sessions,
    directory: bound.directory,
    secret: process.env.ATLAS_SESSION_SECRET,
    production,
  });
  const login = new LoginService({
    auth,
    credentials: bound.credentials,
    preferredTenantId: tenantId,
  });
  const result = await login.provision({ principalId, login: loginId, password });
  logPlatform('auth.credential.operator_provision', {
    principalId: result.principalId,
    loginHash: result.loginIdNormalized ? 'set' : 'missing',
    rotated: result.rotated,
    tenantId,
  });
  process.stderr.write(
    `Credential ${result.rotated ? 'rotated' : 'created'} for principal ${result.principalId} (login ${result.loginIdNormalized}).\n`,
  );
} finally {
  await persistence.close();
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  process.stderr.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  let value = '';
  return await new Promise((resolve, reject) => {
    const onData = (char: string) => {
      if (char === '\n' || char === '\r' || char === '\u0004') {
        cleanup();
        process.stderr.write('\n');
        resolve(value);
        return;
      }
      if (char === '\u0003') {
        cleanup();
        reject(new Error('cancelled'));
        return;
      }
      if (char === '\u007f' || char === '\b') {
        value = value.slice(0, -1);
        return;
      }
      value += char;
    };
    const cleanup = () => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.off('data', onData);
    };
    stdin.on('data', onData);
  });
}
