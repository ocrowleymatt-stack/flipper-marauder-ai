import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  createConversation,
  getSnapshot,
  listConversations,
  sendMessage,
  type Capability,
  type Conversation,
  type ConversationSnapshot,
  type ExecutionRecord,
  type Message,
  type StreamEvent,
} from './api';

export function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null);
  const [draft, setDraft] = useState('');
  const [capability, setCapability] = useState<Capability>('nexus/fast');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        const items = await listConversations();
        setConversations(items);
        if (items[0]) {
          setActiveId(items[0].id);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  useEffect(() => {
    if (!activeId) {
      setSnapshot(null);
      return;
    }
    void (async () => {
      try {
        setSnapshot(await getSnapshot(activeId));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [activeId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [snapshot?.messages, snapshot?.executions]);

  const latestByMessage = useMemo(() => {
    const map = new Map<string, ExecutionRecord>();
    for (const execution of snapshot?.executions ?? []) {
      if (execution.id) {
        const assistant = snapshot?.messages.find((message) => message.executionId === execution.id);
        if (assistant) map.set(assistant.id, execution);
      }
    }
    return map;
  }, [snapshot]);

  const lastFailed = snapshot?.executions.at(-1)?.status === 'failed' ? snapshot.executions.at(-1) : null;
  const lastUser = [...(snapshot?.messages ?? [])].reverse().find((message) => message.role === 'user');

  async function onCreate() {
    setError(null);
    const conversation = await createConversation();
    setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)]);
    setActiveId(conversation.id);
    setSnapshot({ conversation, messages: [], executions: [] });
  }

  async function onReload() {
    if (!activeId) return;
    setError(null);
    try {
      setConversations(await listConversations());
      setSnapshot(await getSnapshot(activeId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runPrompt(conversationId: string, content: string, selected: Capability) {
    setBusy(true);
    setError(null);
    try {
      for await (const event of sendMessage(conversationId, content, selected)) {
        if (event.type === 'error' && event.failure && typeof event.failure === 'object' && 'message' in event.failure) {
          setError(String((event.failure as { message: string }).message));
        }
        setSnapshot((current) => applyStream(current, conversationId, event));
      }
      const items = await listConversations();
      setConversations(items);
      const latest = items.find((item) => item.id === conversationId);
      if (latest) {
        setSnapshot((current) => (current ? { ...current, conversation: latest } : current));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    let conversationId = activeId;
    if (!conversationId) {
      const conversation = await createConversation();
      conversationId = conversation.id;
      setActiveId(conversation.id);
      setConversations((current) => [conversation, ...current]);
      setSnapshot({ conversation, messages: [], executions: [] });
    }
    setDraft('');
    await runPrompt(conversationId, content, capability);
  }

  async function onRetry() {
    if (!lastUser || !activeId || busy) return;
    await runPrompt(activeId, lastUser.content, (lastFailed?.capability as Capability) || capability);
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <h1>Atlas</h1>
          <p>Conversation spine</p>
        </div>
        <button className="new-chat" type="button" onClick={() => void onCreate()}>
          New conversation
        </button>
        <div className="conversation-list">
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              className={conversation.id === activeId ? 'active' : ''}
              onClick={() => setActiveId(conversation.id)}
            >
              <span className="title">{conversation.title}</span>
              <span className="meta">{formatTime(conversation.updatedAt)}</span>
            </button>
          ))}
        </div>
      </aside>
      <main className="workspace">
        <header className="thread-header">
          <div>
            <h2>{snapshot?.conversation.title ?? 'Start a conversation'}</h2>
            <div className="hint">Nexus routes. Execution runs. This thread survives reload.</div>
          </div>
          <button className="ghost" type="button" onClick={() => void onReload()} disabled={!activeId || busy}>
            Reload
          </button>
        </header>
        <section className="messages">
          {!snapshot || snapshot.messages.length === 0 ? (
            <div className="empty">
              <h2>Ask Atlas</h2>
              <p>Choose Fast or Reason, send a prompt, and the reply is streamed through Nexus then the execution broker.</p>
            </div>
          ) : (
            snapshot.messages.map((message) => (
              <article key={message.id} className={`message ${message.role}`}>
                {message.role === 'assistant' ? <div className="role">Atlas</div> : null}
                <div className="body">{message.content || (busy ? '…' : '')}</div>
                {message.role === 'assistant' ? <ExecutionChip execution={latestByMessage.get(message.id)} /> : null}
              </article>
            ))
          )}
          <div ref={bottom} />
        </section>
        {error ? (
          <div className="error">
            <span>{error}</span>
            {lastUser && !busy ? (
              <button className="ghost" type="button" onClick={() => void onRetry()}>
                Retry
              </button>
            ) : null}
          </div>
        ) : null}
        <form className="composer" onSubmit={(event) => void onSubmit(event)}>
          <div className="composer-box">
            <textarea
              value={draft}
              placeholder="Write to Atlas…"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <select
              value={capability}
              onChange={(event) => setCapability(event.target.value as Capability)}
              aria-label="Capability"
            >
              <option value="nexus/fast">Fast</option>
              <option value="nexus/reason">Reason</option>
            </select>
            <button className="send" type="submit" disabled={busy || !draft.trim()}>
              {busy ? 'Running' : 'Send'}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}

function ExecutionChip({ execution }: { execution?: ExecutionRecord }) {
  if (!execution) return null;
  const label = provenanceLabel(execution);
  const usage = execution.usage ? `${execution.usage.totalTokens} tok` : null;
  return (
    <div className={`execution-chip ${execution.status}`}>
      <span>
        <strong>{label}</strong>
      </span>
      <span>{execution.status}</span>
      {usage ? <span>{usage}</span> : null}
      {execution.failureReason ? <span>{execution.failureReason.message}</span> : null}
    </div>
  );
}

function provenanceLabel(execution: ExecutionRecord): string {
  const cap = execution.capability === 'nexus/reason' ? 'Reason' : execution.capability === 'nexus/fast' ? 'Fast' : execution.capability;
  const provider = titleCase(execution.selectedProvider ?? execution.route?.resolvedRouteId?.split('/')[0] ?? 'routing');
  const model = execution.selectedModel ?? execution.route?.resolvedRouteId?.split('/')[1] ?? '…';
  return `${cap} · ${provider} · ${model}`;
}

function titleCase(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function applyStream(
  current: ConversationSnapshot | null,
  conversationId: string,
  event: StreamEvent,
): ConversationSnapshot | null {
  if (!current || current.conversation.id !== conversationId) return current;
  if (event.type === 'message' && 'message' in event && event.message && typeof event.message === 'object' && event.message && 'id' in event.message) {
    const next = event.message as Message;
    const messages = current.messages.some((item) => item.id === next.id)
      ? current.messages.map((item) => (item.id === next.id ? next : item))
      : [...current.messages, next];
    return { ...current, messages };
  }
  if (event.type === 'message.delta' && 'messageId' in event && 'content' in event && typeof event.messageId === 'string' && typeof event.content === 'string') {
    return {
      ...current,
      messages: current.messages.map((item) =>
        item.id === event.messageId ? { ...item, content: event.content as string } : item,
      ),
    };
  }
  if (event.type === 'execution' && 'execution' in event && event.execution) {
    const next = event.execution as ExecutionRecord;
    const executions = current.executions.some((item) => item.id === next.id)
      ? current.executions.map((item) => (item.id === next.id ? next : item))
      : [...current.executions, next];
    return { ...current, executions };
  }
  return current;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
