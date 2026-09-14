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

  async function onCreate() {
    setError(null);
    const conversation = await createConversation();
    setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)]);
    setActiveId(conversation.id);
    setSnapshot({ conversation, messages: [], executions: [] });
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    setBusy(true);
    setError(null);
    try {
      let conversationId = activeId;
      if (!conversationId) {
        const conversation = await createConversation();
        conversationId = conversation.id;
        setActiveId(conversation.id);
        setConversations((current) => [conversation, ...current]);
        setSnapshot({ conversation, messages: [], executions: [] });
      }
      setDraft('');
      for await (const event of sendMessage(conversationId, content, capability)) {
        setSnapshot((current) => applyStream(current, conversationId!, event));
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
        {error ? <div className="error">{error}</div> : null}
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
  const route = execution.selectedProvider
    ? `${execution.selectedProvider}/${execution.selectedModel}`
    : execution.route?.resolvedRouteId;
  const usage = execution.usage ? `${execution.usage.totalTokens} tok` : null;
  return (
    <div className={`execution-chip ${execution.status}`}>
      <span>
        {execution.capability} → <strong>{route ?? 'routing'}</strong>
      </span>
      <span>{execution.status}</span>
      {usage ? <span>{usage}</span> : null}
      {execution.failureReason ? <span>{execution.failureReason.message}</span> : null}
    </div>
  );
}

function applyStream(
  current: ConversationSnapshot | null,
  conversationId: string,
  event: { type: string; message?: Message; messageId?: string; content?: string; execution?: ExecutionRecord; failure?: { message: string } },
): ConversationSnapshot | null {
  if (!current || current.conversation.id !== conversationId) return current;
  if (event.type === 'message' && event.message) {
    const messages = current.messages.some((item) => item.id === event.message!.id)
      ? current.messages.map((item) => (item.id === event.message!.id ? event.message! : item))
      : [...current.messages, event.message];
    return { ...current, messages };
  }
  if (event.type === 'message.delta' && event.messageId && event.content !== undefined) {
    return {
      ...current,
      messages: current.messages.map((item) =>
        item.id === event.messageId ? { ...item, content: event.content! } : item,
      ),
    };
  }
  if (event.type === 'execution' && event.execution) {
    const executions = current.executions.some((item) => item.id === event.execution!.id)
      ? current.executions.map((item) => (item.id === event.execution!.id ? event.execution! : item))
      : [...current.executions, event.execution];
    return { ...current, executions };
  }
  return current;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
