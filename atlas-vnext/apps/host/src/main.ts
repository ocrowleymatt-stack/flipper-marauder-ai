import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeSpine } from './compose.ts';
import { createHost, listen } from './server.ts';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const dataPath = process.env.ATLAS_VNEXT_DATA ?? join(root, '.data', 'state.json');
const staticDir = process.env.ATLAS_VNEXT_STATIC ?? join(root, 'apps/web/dist');
const port = Number(process.env.PORT ?? 8787);
const mode = process.env.ATLAS_USE_MOCK_PROVIDERS === '1' ? 'mock' : 'live';

const spine = await composeSpine({
  dataPath,
  mode,
  streamDelayMs: Number(process.env.ATLAS_VNEXT_STREAM_DELAY_MS ?? 18),
});
const server = createHost({
  runtime: spine.runtime,
  staticDir,
  health: { mode: spine.mode, providers: spine.health },
});
const bound = await listen(server, port, '127.0.0.1');
console.log(`Atlas vNext conversation spine at ${bound.url}`);
console.log(`Durable store: ${dataPath}`);
console.log(`Execution mode: ${spine.mode}`);
console.log(`Available runtimes: ${spine.availableRuntimes.join(', ') || '(none)'}`);
