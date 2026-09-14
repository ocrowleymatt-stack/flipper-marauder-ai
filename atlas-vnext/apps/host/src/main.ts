import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeSpine } from './compose.ts';
import { createHost, listen } from './server.ts';
import { readPersistenceConfig } from '@atlas-vnext/persistence';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const dataPath = process.env.ATLAS_VNEXT_DATA ?? join(root, '.data', 'state.json');
const staticDir = process.env.ATLAS_VNEXT_STATIC ?? join(root, 'apps/web/dist');
const port = Number(process.env.PORT ?? 8787);
const mode = process.env.ATLAS_USE_MOCK_PROVIDERS === '1' ? 'mock' : 'live';
const persistence = readPersistenceConfig(process.env);

const spine = await composeSpine({
  dataPath,
  mode,
  env: process.env,
  persistence,
  streamDelayMs: Number(process.env.ATLAS_VNEXT_STREAM_DELAY_MS ?? 18),
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
  tenantId: spine.tenantId,
  principalId: spine.principalId,
  production: persistence.production,
});
const bound = await listen(server, port, '127.0.0.1');
spine.scheduler?.startIdleWatch();
console.log(`Atlas vNext Workbench host at ${bound.url}`);
console.log(`Durable store: ${persistence.mode === 'postgres' ? 'postgresql' : dataPath}`);
console.log(`Execution mode: ${spine.mode}`);
console.log(`Available runtimes: ${spine.availableRuntimes.join(', ') || '(none)'}`);

async function shutdown(signal: string): Promise<void> {
  console.log(`Shutting down (${signal})`);
  spine.scheduler?.stopIdleWatch();
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
