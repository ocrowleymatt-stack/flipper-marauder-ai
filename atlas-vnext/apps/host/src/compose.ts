import { ConversationRuntime } from '@atlas-vnext/conversation';
import { ExecutionBroker, MockAdapter } from '@atlas-vnext/execution';
import { NexusRegistry, NexusRouter } from '@atlas-vnext/nexus';
import { openDurableStore, type DurableConversationStore } from '@atlas-vnext/persistence';
import { DEV_CATALOGUE } from './catalogue.ts';

export interface Spine {
  runtime: ConversationRuntime;
  store: DurableConversationStore;
  router: NexusRouter;
  broker: ExecutionBroker;
}

export interface ComposeOptions {
  dataPath: string;
  streamDelayMs?: number;
}

/**
 * Composition root. Apps/UI never import adapters; this host wires
 * Nexus (WHERE) to Execution (HOW) and the conversation domain (WHAT).
 */
export async function composeSpine(options: ComposeOptions): Promise<Spine> {
  const store = openDurableStore(options.dataPath);
  const registry = new NexusRegistry();
  for (const model of DEV_CATALOGUE) {
    registry.register(model);
  }
  const router = new NexusRouter(registry);
  const broker = new ExecutionBroker(1);
  const delayMs = options.streamDelayMs ?? 0;
  broker.register(new MockAdapter('openai', { delayMs }));
  broker.register(new MockAdapter('anthropic', { delayMs }));
  broker.register(new MockAdapter('gemini', { delayMs }));
  broker.register(new MockAdapter('ollama', { delayMs }));

  const runtime = new ConversationRuntime({
    conversations: store.conversations,
    messages: store.messages,
    executions: store.executions,
    provenance: store.provenance,
    events: store.events,
    router,
    executor: broker,
  });
  await runtime.recoverInFlight();
  return { runtime, store, router, broker };
}
