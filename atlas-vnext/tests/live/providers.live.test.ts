import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeSpine } from '../../apps/host/src/compose.ts';

const enabled = process.env.ATLAS_LIVE_SMOKE === '1';

describe.skipIf(!enabled)('optional live provider smoke', () => {
  it('streams ATLAS LIVE through a real backend and reloads provenance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-live-'));
    const spine = await composeSpine({ dataPath: join(dir, 'state.json'), mode: 'live' });
    const usable = spine.availableRuntimes.filter((id) => id !== 'ollama' || spine.health.ollama === 'healthy');
    expect(usable.length, `no live providers: ${JSON.stringify(spine.health)}`).toBeGreaterThan(0);

    const conversation = await spine.runtime.createConversation({ title: 'live-proof' });
    let text = '';
    let completed = false;
    for await (const event of spine.runtime.sendMessage(conversation.id, {
      content: 'Reply with exactly: ATLAS LIVE',
      capability: 'nexus/fast',
    })) {
      if (event.type === 'message.delta') text = event.content;
      if (event.type === 'execution.completed') completed = true;
      if (event.type === 'error') {
        throw new Error(event.failure.message);
      }
    }
    const snapshot = await spine.runtime.getSnapshot(conversation.id);
    expect(completed).toBe(true);
    expect(snapshot?.executions[0]?.status).toBe('completed');
    expect(snapshot?.executions[0]?.selectedProvider).toBeTruthy();
    expect(snapshot?.messages.some((message) => message.role === 'assistant')).toBe(true);
    expect(text.toLowerCase()).toContain('atlas live');
    expect(JSON.stringify(snapshot)).not.toMatch(/sk-[a-zA-Z0-9]{10,}/);
  });
});
