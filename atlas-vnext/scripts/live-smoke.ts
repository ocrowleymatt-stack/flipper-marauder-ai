/**
 * Optional live smoke. Requires ATLAS_LIVE_SMOKE=1 and at least one provider key
 * (or a reachable Ollama). Never treat a mock as live.
 *
 *   ATLAS_LIVE_SMOKE=1 OPENAI_API_KEY=... npm run smoke:live
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeSpine } from '../apps/host/src/compose.ts';

if (process.env.ATLAS_LIVE_SMOKE !== '1') {
  console.error('Refusing to run live smoke without ATLAS_LIVE_SMOKE=1');
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'atlas-live-'));
const spine = await composeSpine({ dataPath: join(dir, 'state.json'), mode: 'live' });
console.log('mode', spine.mode);
console.log('health', spine.health);
console.log('available', spine.availableRuntimes);

const usable = spine.availableRuntimes.filter((id) => id !== 'ollama' || spine.health.ollama === 'healthy');
if (usable.length === 0) {
  console.error('No live providers available. Fixture-test adapters instead; do not claim live-tested.');
  process.exit(1);
}

const conversation = await spine.runtime.createConversation({ title: 'live-smoke' });
const types: string[] = [];
let text = '';
for await (const event of spine.runtime.sendMessage(conversation.id, {
  content: 'Reply with exactly: ATLAS LIVE',
  capability: 'nexus/fast',
})) {
  types.push(event.type);
  if (event.type === 'message.delta') text += event.content;
  if (event.type === 'assistant.completed') text = event.text;
  if (event.type === 'error') {
    console.error('structured failure', event.failure);
    process.exit(1);
  }
}
const snapshot = await spine.runtime.getSnapshot(conversation.id);
console.log('events', types.join(','));
console.log('selected', snapshot?.executions[0]?.selectedProvider, snapshot?.executions[0]?.selectedModel);
console.log('text', text.slice(0, 200));
if (snapshot?.executions[0]?.status !== 'completed') {
  console.error('execution did not complete');
  process.exit(1);
}
console.log('live smoke ok');
