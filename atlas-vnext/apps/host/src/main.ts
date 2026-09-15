import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHost, listen } from './server.ts';
import { readPersistenceConfig } from '@atlas-vnext/persistence';
import { logPlatform } from '@atlas-vnext/observability';
import { bootSpine } from './startup.ts';
import { readProductionHostConfig, publicConfigView } from './production-config.ts';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const hostConfig = readProductionHostConfig(process.env);
const dataPath = process.env.ATLAS_VNEXT_DATA ?? join(root, '.data', 'state.json');
const staticDir = process.env.ATLAS_VNEXT_STATIC ?? join(root, 'apps/web/dist');
const mode = hostConfig.mockProviders ? 'mock' : 'live';
const persistence = readPersistenceConfig(process.env);

logPlatform('host.starting', publicConfigView(hostConfig));

const spine = await bootSpine({
  dataPath,
  mode,
  env: process.env,
  persistence,
  casRoot: hostConfig.casRoot ?? undefined,
  streamDelayMs: Number(process.env.ATLAS_VNEXT_STREAM_DELAY_MS ?? 18),
  production: hostConfig.production,
});

const server = createHost({
  runtime: spine.runtime,
  staticDir,
  health: { mode: spine.mode, providers: spine.health, runtime: () => spine.runtimeSnapshot() },
  probe: spine.healthProbe,
  shutdown: spine.shutdown,
  auth: spine.auth,
  tools: spine.tools,
  projects: spine.projects,
  files: spine.files,
  context: spine.context,
  persistence: spine.persistence,
  writing: spine.writing,
  tenantId: spine.tenantId,
  principalId: spine.principalId,
  production: hostConfig.production,
  allowedOrigins: hostConfig.allowedOrigins,
  flags: spine.flags,
  killSwitches: spine.killSwitches,
  rateLimiter: spine.rateLimiter,
  resources: spine.resources,
  hsts: hostConfig.hsts,
  timeouts: spine.timeouts,
});
const bound = await listen(server, hostConfig.port, hostConfig.bindHost);
spine.scheduler?.startIdleWatch();
logPlatform('host.listening', { url: bound.url, mode: spine.mode });
console.log(`Atlas vNext Workbench host at ${bound.url}`);
console.log(`Durable store: ${persistence.mode === 'postgres' ? 'postgresql' : dataPath}`);
console.log(`Execution mode: ${spine.mode}`);
console.log(`Available runtimes: ${spine.availableRuntimes.join(', ') || '(none)'}`);

async function shutdown(signal: string): Promise<void> {
  logPlatform('host.shutdown', { signal });
  console.log(`Shutting down (${signal})`);
  spine.shutdown.begin();
  spine.scheduler?.stopIdleWatch();
  const force = setTimeout(() => {
    logPlatform('host.shutdown_timeout', { ms: hostConfig.timeouts.shutdownMs }, 'error');
    process.exit(1);
  }, hostConfig.timeouts.shutdownMs);
  force.unref();
  await spine.close();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
