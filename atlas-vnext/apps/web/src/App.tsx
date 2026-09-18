import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  attachFile,
  bootstrapSession,
  CAPABILITIES,
  citationsFromBackend,
  createConversation,
  createProject,
  decideTool,
  getProjectContext,
  getSnapshot,
  inspectExecution,
  listApprovals,
  listConversationTools,
  listConversations,
  listDungeons,
  listFiles,
  listProjectConversations,
  listProjects,
  runtimeWaitingLabel,
  sendMessage,
  uploadTextFile,
  isProjectsUnavailable,
  type AssembledContext,
  type Capability,
  type Conversation,
  type DungeonRegistration,
  type ExecutionRecord,
  type Project,
  type ProjectFile,
  type SessionState,
  type ToolPresentation,
} from './api';
import { CaspaPanel } from './caspa';
import { EstatePanel } from './estate';
import { playCue, prefersReducedMotion, setSoundEnabled, soundEnabled } from './experience';
import { applyStream, emptyView, runStatusLabel, viewFromSnapshot, type StreamView } from './stream';

type InspectorTab = 'run' | 'files' | 'context' | 'tools';
type Surface = 'conversation' | 'writing' | 'osint' | 'investigation' | 'research' | 'website' | 'music' | 'privacy' | 'operations';

export function App() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectsAvailable, setProjectsAvailable] = useState(true);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [view, setView] = useState<StreamView | null>(null);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [context, setContext] = useState<AssembledContext | null>(null);
  const [tools, setTools] = useState<ToolPresentation[]>([]);
  const [approvals, setApprovals] = useState<ToolPresentation[]>([]);
  const [inspection, setInspection] = useState<{ execution: ExecutionRecord; tools: ToolPresentation[] } | null>(null);
  const [draft, setDraft] = useState('');
  const [fileDraft, setFileDraft] = useState({ path: 'notes.md', text: '' });
  const [projectName, setProjectName] = useState('');
  const [capability, setCapability] = useState<Capability>('nexus/fast');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('Loading Workbench.');
  const [tab, setTab] = useState<InspectorTab>('run');
  const [surface, setSurface] = useState<Surface>('conversation');
  const [dungeons, setDungeons] = useState<DungeonRegistration[]>([]);
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [soundOn, setSoundOn] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const composerId = useId();
  const liveId = useId();

  const snapshot = view?.snapshot ?? null;
  const latestExecution = snapshot?.executions.at(-1) ?? null;
  const awaiting = tools.filter((item) => item.awaitingApproval);
  const runLabel = runStatusLabel(latestExecution?.status, awaiting.length > 0);

  const loadProjects = useCallback(async () => {
    const items = await listProjects();
    setProjects(items);
    return items;
  }, []);

  const loadConversation = useCallback(async (conversationId: string) => {
    const snapshot = await getSnapshot(conversationId);
    setView(viewFromSnapshot(snapshot));
    const [conversationTools, assembled, pending] = await Promise.all([
      listConversationTools(conversationId).catch(() => []),
      snapshot.conversation.projectId
        ? getProjectContext(snapshot.conversation.projectId, snapshot.conversation.title, conversationId).catch(() => null)
        : Promise.resolve(null),
      listApprovals().catch(() => []),
    ]);
    setTools(conversationTools);
    setContext(assembled);
    setApprovals(pending);
    const executionId = snapshot.executions.at(-1)?.id;
    if (executionId) {
      const inspected = await inspectExecution(executionId).catch(() => null);
      setInspection(inspected);
    } else {
      setInspection(null);
    }
  }, []);

  const loadProject = useCallback(
    async (id: string, preferredConversationId?: string | null) => {
      const [convos, projectFiles] = await Promise.all([listProjectConversations(id), listFiles(id)]);
      setConversations(convos);
      setFiles(projectFiles);
      const nextId = preferredConversationId && convos.some((item) => item.id === preferredConversationId) ? preferredConversationId : convos[0]?.id ?? null;
      setActiveConversationId(nextId);
      if (nextId) await loadConversation(nextId);
      else {
        setView(null);
        setTools([]);
        setContext(null);
        setInspection(null);
      }
    },
    [loadConversation],
  );

  useEffect(() => {
    void (async () => {
      try {
        const next = await bootstrapSession();
        setSession(next);
        if (!next.authenticated) {
          setSessionError('Authentication required. Workbench cannot guess a tenant.');
          setStatus('Signed out.');
          setLoading(false);
          return;
        }
        let projectItems: Project[] | null = null;
        try {
          projectItems = await loadProjects();
        } catch (err) {
          if (!isProjectsUnavailable(err)) throw err;
        }
        const registered = await listDungeons().catch(() => []);
        setDungeons(registered);
        setSoundOn(soundEnabled());
        if (projectItems) {
          setProjectsAvailable(true);
          const first = projectItems[0]?.id ?? null;
          setProjectId(first);
          if (first) await loadProject(first);
          setStatus(first ? 'Workbench ready.' : 'Create a project to begin.');
        } else {
          setProjectsAvailable(false);
          setSurface('conversation');
          const convos = await listConversations();
          setConversations(convos);
          const nextId = convos[0]?.id ?? null;
          setActiveConversationId(nextId);
          if (nextId) await loadConversation(nextId);
          setStatus('Conversation-only mode.');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus('Workbench failed to load.');
      } finally {
        setLoading(false);
      }
    })();
  }, [loadConversation, loadProject, loadProjects]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [snapshot?.messages, snapshot?.executions, view?.waitLabel]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        playCue('activate');
      }
      if (event.key === 'Escape') setPaletteOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function refreshAll() {
    setError(null);
    try {
      if (projectsAvailable) {
        await loadProjects();
        if (projectId) await loadProject(projectId, activeConversationId);
      } else {
        const convos = await listConversations();
        setConversations(convos);
        if (activeConversationId) await loadConversation(activeConversationId);
      }
      setStatus('Reloaded from the server.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onCreateProject(event: FormEvent) {
    event.preventDefault();
    const name = projectName.trim();
    if (!name) return;
    setError(null);
    try {
      const project = await createProject(name);
      setProjectName('');
      const items = await loadProjects();
      setProjects(items);
      setProjectId(project.id);
      await loadProject(project.id);
      setStatus(`Opened project ${project.name}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onSelectProject(id: string) {
    setProjectId(id);
    setNavOpen(false);
    setError(null);
    try {
      await loadProject(id);
      setStatus('Project switched.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onCreateConversation() {
    if (projectsAvailable && !projectId) return;
    setError(null);
    try {
      const conversation = await createConversation(projectId);
      setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)]);
      setActiveConversationId(conversation.id);
      setView(emptyView(conversation));
      setTools([]);
      setInspection(null);
      setStatus('New conversation.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onOpenConversation(id: string) {
    setActiveConversationId(id);
    setNavOpen(false);
    setError(null);
    try {
      await loadConversation(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runPrompt(conversationId: string, content: string, selected: Capability) {
    setBusy(true);
    setError(null);
    setStatus('Running.');
    setView((current) =>
      current ? { ...current, sealedResponse: false, classifiedFailure: null, waitLabel: null } : current,
    );
    try {
      for await (const event of sendMessage(conversationId, content, selected)) {
        setView((current) => {
          if (!current) return current;
          return applyStream(current, conversationId, event, runtimeWaitingLabel);
        });
        if (event.type === 'tool.lifecycle') {
          await listConversationTools(conversationId)
            .then(setTools)
            .catch(() => undefined);
          await listApprovals()
            .then(setApprovals)
            .catch(() => undefined);
        }
      }
      await loadConversation(conversationId);
      setConversations(projectId ? await listProjectConversations(projectId) : await listConversations());
      playCue('complete');
      setStatus('Run finished.');
    } catch (err) {
      playCue('warn');
      setError(err instanceof Error ? err.message : String(err));
      setStatus('Request failed.');
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || busy || (projectsAvailable && !projectId)) return;
    let conversationId = activeConversationId;
    if (!conversationId) {
      const conversation = await createConversation(projectId);
      conversationId = conversation.id;
      setActiveConversationId(conversation.id);
      setConversations((current) => [conversation, ...current]);
      setView(emptyView(conversation));
    }
    setDraft('');
    await runPrompt(conversationId, content, capability);
  }

  async function onUpload(event: FormEvent) {
    event.preventDefault();
    if (!projectId || !fileDraft.path.trim() || !fileDraft.text.trim()) return;
    try {
      await uploadTextFile(projectId, fileDraft.path.trim(), fileDraft.text);
      setFileDraft((current) => ({ ...current, text: '' }));
      setFiles(await listFiles(projectId));
      setStatus('File stored in CAS. Bytes stay on the server.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onAttach(fileId: string) {
    if (!activeConversationId || !projectId) return;
    try {
      await attachFile(fileId, activeConversationId);
      setContext(await getProjectContext(projectId, snapshot?.conversation.title ?? '', activeConversationId));
      setStatus('File attached to this conversation.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function ingestDroppedFiles(fileList: FileList | null) {
    if (!projectId || !fileList?.length) return;
    try {
      for (const file of Array.from(fileList)) {
        const text = await file.text();
        await uploadTextFile(projectId, file.name, text);
      }
      setFiles(await listFiles(projectId));
      playCue('complete');
      setStatus('Dropped files stored in CAS.');
    } catch (err) {
      playCue('warn');
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function openSurface(next: Surface) {
    setSurface(next);
    setNavOpen(false);
    setPaletteOpen(false);
    playCue('activate');
  }

  async function onDecide(id: string, decision: 'approve' | 'deny') {
    try {
      await decideTool(id, decision);
      if (activeConversationId) await loadConversation(activeConversationId);
      setApprovals(await listApprovals());
      setStatus(decision === 'approve' ? 'Approval recorded on the server.' : 'Denial recorded on the server.');
      playCue(decision === 'approve' ? 'complete' : 'warn');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const citations = useMemo(() => citationsFromBackend(context), [context]);
  const currentProject = projects.find((item) => item.id === projectId) ?? null;
  const paletteItems = useMemo(() => {
    const q = paletteQuery.trim().toLowerCase();
    const surfaces: Array<{ id: Surface; label: string }> = [
      { id: 'conversation', label: 'Conversation' },
      { id: 'operations', label: 'Help & Repair' },
      ...dungeons.filter((item) => item.featureAvailable).map((item) => ({ id: item.id as Surface, label: item.navLabel })),
    ];
    return [
      ...surfaces.filter((item) => !q || item.label.toLowerCase().includes(q)),
      ...projects
        .filter((item) => !q || item.name.toLowerCase().includes(q))
        .map((item) => ({ id: `project:${item.id}` as const, label: `Project ${item.name}` })),
    ];
  }, [dungeons, paletteQuery, projects]);

  if (loading) {
    return (
      <div className="boot" role="status">
        Loading Atlas Workbench.
      </div>
    );
  }

  if (!session?.authenticated) {
    return (
      <main className="boot" aria-labelledby="signed-out-title">
        <h1 id="signed-out-title">Atlas Workbench</h1>
        <p role="alert">{sessionError ?? 'Authentication required.'}</p>
      </main>
    );
  }

  return (
    <div
      className={`shell ${dropActive ? 'drop-active' : ''} ${prefersReducedMotion() ? 'reduced-motion' : 'atlas-motion'}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDropActive(true);
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDropActive(false);
        void ingestDroppedFiles(event.dataTransfer.files);
      }}
    >
      <a className="skip" href={`#${composerId}`}>
        Skip to composer
      </a>
      <header className="topbar">
        <div>
          <p className="eyebrow">Atlas Workbench</p>
          <h1>Projects, runs, files, tools</h1>
        </div>
        <div className="topbar-actions">
          <p id={liveId} className="status" aria-live="polite">
            {status}
          </p>
          <button
            type="button"
            className="ghost"
            aria-pressed={soundOn}
            onClick={() => {
              const next = !soundOn;
              setSoundEnabled(next);
              setSoundOn(next);
              if (next) playCue('activate');
            }}
          >
            {soundOn ? 'Sound on' : 'Sound off'}
          </button>
          <button type="button" className="ghost" onClick={() => setPaletteOpen(true)}>
            Command palette
          </button>
          <button type="button" className="ghost nav-toggle" onClick={() => setNavOpen((open) => !open)} aria-expanded={navOpen}>
            {navOpen ? 'Close navigation' : 'Open navigation'}
          </button>
          <button type="button" className="ghost" onClick={() => void refreshAll()} disabled={busy}>
            Reload
          </button>
        </div>
      </header>
      <div className={`layout ${navOpen ? 'nav-open' : ''}`}>
        <nav className="nav" aria-label="Projects and conversations">
          <form className="stack" onSubmit={(event) => void onCreateProject(event)}>
            <label htmlFor="project-name">New project</label>
            <input
              id="project-name"
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder="Named workspace"
              autoComplete="off"
            />
            <button type="submit" className="primary" disabled={!projectName.trim()}>
              Create project
            </button>
          </form>
          <h2>Projects</h2>
          {projects.length === 0 ? (
            <p className="muted">No projects yet. Creating one is authorised on the server.</p>
          ) : (
            <ul className="plain">
              {projects.map((project) => (
                <li key={project.id}>
                  <button
                    type="button"
                    className={project.id === projectId ? 'active' : ''}
                    onClick={() => void onSelectProject(project.id)}
                    aria-current={project.id === projectId ? 'page' : undefined}
                  >
                    <span>{project.name}</span>
                    <span className="meta">{formatTime(project.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="row">
            <h2>Surface</h2>
          </div>
          <ul className="plain">
            <li>
              <button type="button" className={surface === 'conversation' ? 'active' : ''} onClick={() => openSurface('conversation')} disabled={projectsAvailable && !projectId}>
                Conversation
              </button>
            </li>
            <li>
              <button type="button" className={surface === 'operations' ? 'active' : ''} onClick={() => openSurface('operations')}>
                Help & Repair
              </button>
            </li>
            {dungeons
              .filter((item) => item.featureAvailable)
              .map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={surface === item.id ? 'active' : ''}
                    onClick={() => openSurface(item.id as Surface)}
                    disabled={item.id !== 'privacy' && !projectId}
                  >
                    {item.navLabel}
                  </button>
                </li>
              ))}
          </ul>
          <div className="row">
            <h2>Conversations</h2>
            <button type="button" className="ghost compact" onClick={() => void onCreateConversation()} disabled={projectsAvailable && !projectId}>
              New
            </button>
          </div>
          {conversations.length === 0 ? (
            <p className="muted">No conversations in this project.</p>
          ) : (
            <ul className="plain">
              {conversations.map((conversation) => (
                <li key={conversation.id}>
                  <button
                    type="button"
                    className={conversation.id === activeConversationId ? 'active' : ''}
                    onClick={() => void onOpenConversation(conversation.id)}
                    aria-current={conversation.id === activeConversationId ? 'page' : undefined}
                  >
                    <span>{conversation.title}</span>
                    <span className="meta">{formatTime(conversation.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>
        {surface === 'writing' && projectId ? (
          <CaspaPanel
            projectId={projectId}
            files={files}
            busy={busy}
            setBusy={setBusy}
            onStatus={setStatus}
            onError={setError}
          />
        ) : surface === 'operations' ? (
          <EstatePanel
            dungeonId="operations"
            projectId={projectId}
            files={files}
            busy={busy}
            setBusy={setBusy}
            onStatus={setStatus}
            onError={setError}
          />
        ) : surface !== 'conversation' ? (
          <EstatePanel
            dungeonId={surface}
            projectId={projectId}
            files={files}
            busy={busy}
            setBusy={setBusy}
            onStatus={setStatus}
            onError={setError}
          />
        ) : (
        <main className="workspace" aria-label="Conversation">
          <header className="thread-header">
            <div>
              <h2>{snapshot?.conversation.title ?? currentProject?.name ?? 'Start in a project'}</h2>
              <p className="hint">
                Nexus routes. Execution runs. Authority decides tools. This thread is durable.
              </p>
            </div>
            <p className={`pill ${latestExecution?.status ?? 'idle'}`} aria-live="polite">
              {runLabel}
            </p>
          </header>
          <section className="messages" aria-label="Messages">
            {!snapshot || snapshot.messages.length === 0 ? (
              <div className="empty">
                <h3>Empty conversation</h3>
                <p>Send a turn. Reloading restores server state; the browser is not the source of truth.</p>
              </div>
            ) : (
              snapshot.messages.map((message) => {
                const execution = snapshot.executions.find((item) => item.id === message.executionId);
                return (
                  <article key={message.id} className={`message ${message.role}`}>
                    {message.role === 'assistant' ? <div className="role">Atlas</div> : <div className="role">You</div>}
                    <div className="body">{message.content || (busy ? '…' : '')}</div>
                    {execution ? <ExecutionChip execution={execution} sealed={Boolean(view?.sealedResponse)} /> : null}
                  </article>
                );
              })
            )}
            {busy && view?.waitLabel ? (
              <article className="message assistant waiting" aria-live="polite">
                <div className="role">Atlas</div>
                <div className="body waiting-runtime">{view.waitLabel}</div>
              </article>
            ) : null}
            <div ref={bottom} />
          </section>
          {error || view?.classifiedFailure ? (
            <div className="error" role="alert">
              <span>{error ?? view?.classifiedFailure}</span>
              {view?.sealedResponse ? <span className="meta">Visible output already began; Atlas did not disguise a provider switch.</span> : null}
            </div>
          ) : null}
          {awaiting.map((item) => (
            <ApprovalCard key={item.id} tool={item} onDecide={onDecide} />
          ))}
          <form id={composerId} className="composer" onSubmit={(event) => void onSubmit(event)}>
            <label htmlFor="draft">Message</label>
            <div className="composer-box">
              <textarea
                id="draft"
                value={draft}
                placeholder={projectId || !projectsAvailable ? 'Write to Atlas…' : 'Create or open a project first.'}
                disabled={(projectsAvailable && !projectId) || busy}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <label className="sr-only" htmlFor="capability">
                Capability alias
              </label>
              <select
                id="capability"
                value={capability}
                onChange={(event) => setCapability(event.target.value as Capability)}
                disabled={busy}
              >
                {CAPABILITIES.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
              <button className="send" type="submit" disabled={busy || !draft.trim() || (projectsAvailable && !projectId)}>
                {busy ? 'Running' : 'Send'}
              </button>
            </div>
          </form>
        </main>
        )}
        <aside className="inspector" aria-label="Run, files, context and tools">
          <div className="tabs" role="tablist" aria-label="Inspector">
            {(['run', 'files', 'context', 'tools'] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={tab === item}
                className={tab === item ? 'active' : ''}
                onClick={() => setTab(item)}
              >
                {item}
              </button>
            ))}
          </div>
          {tab === 'run' ? (
            <RunInspector execution={inspection?.execution ?? latestExecution} tools={inspection?.tools ?? tools} />
          ) : null}
          {tab === 'files' ? (
            <section>
              <h3>Files</h3>
              <p className="muted">Metadata only. CAS bytes stay on the host.</p>
              <form className="stack" onSubmit={(event) => void onUpload(event)}>
                <label htmlFor="file-path">Path</label>
                <input
                  id="file-path"
                  value={fileDraft.path}
                  onChange={(event) => setFileDraft((current) => ({ ...current, path: event.target.value }))}
                />
                <label htmlFor="file-text">Text</label>
                <textarea
                  id="file-text"
                  value={fileDraft.text}
                  onChange={(event) => setFileDraft((current) => ({ ...current, text: event.target.value }))}
                  rows={4}
                />
                <button type="submit" className="primary" disabled={!projectId || !fileDraft.text.trim()}>
                  Upload to CAS
                </button>
              </form>
              {files.length === 0 ? (
                <p className="muted">No files in this project.</p>
              ) : (
                <ul className="plain">
                  {files.map((file) => (
                    <li key={file.id} className="file-row">
                      <div>
                        <strong>{file.displayName}</strong>
                        <span className="meta">
                          {file.path} · {file.status} · {file.sizeBytes} B · {file.contentHash.slice(0, 12)}
                        </span>
                      </div>
                      <button type="button" className="ghost compact" onClick={() => void onAttach(file.id)} disabled={!activeConversationId}>
                        Attach
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
          {tab === 'context' ? (
            <section>
              <h3>Context</h3>
              <p className="muted">Citations come from the backend. The browser does not invent sources.</p>
              {citations.length === 0 && !context?.slices.length ? (
                <p className="muted">No retrieved material for this run.</p>
              ) : (
                <ul className="plain">
                  {context?.slices.map((slice) => (
                    <li key={slice.chunkId}>
                      <strong>{slice.path}</strong>
                      <span className="meta">
                        {slice.source} · hash {slice.contentHash.slice(0, 12)}
                        {slice.truncated ? ' · truncated' : ''}
                      </span>
                      <p>{slice.text}</p>
                    </li>
                  ))}
                </ul>
              )}
              {citations.some((citation) => citation.confidence === 'unknown') ? (
                <p className="muted">Some citations are honestly unknown. Nothing was fabricated.</p>
              ) : null}
            </section>
          ) : null}
          {tab === 'tools' ? (
            <section>
              <h3>Tools</h3>
              {tools.length === 0 && approvals.length === 0 ? (
                <p className="muted">No tool invocations on this conversation.</p>
              ) : (
                <ul className="plain">
                  {[...tools, ...approvals.filter((item) => !tools.some((tool) => tool.id === item.id))].map((tool) => (
                    <li key={tool.id}>
                      <strong>{tool.title}</strong>
                      <span className="meta">
                        {tool.status} · {tool.risk} · {tool.argumentSummary}
                      </span>
                      {tool.awaitingApproval ? <ApprovalCard tool={tool} onDecide={onDecide} /> : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
        </aside>
      </div>
      {paletteOpen ? (
        <div className="palette-scrim" role="presentation" onClick={() => setPaletteOpen(false)}>
          <div
            className="palette"
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            onClick={(event) => event.stopPropagation()}
          >
            <label htmlFor="palette-query">Jump</label>
            <input
              id="palette-query"
              autoFocus
              value={paletteQuery}
              onChange={(event) => setPaletteQuery(event.target.value)}
              placeholder="Dungeon, conversation, or project"
            />
            <ul className="plain">
              {paletteItems.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => {
                      if (item.id.startsWith('project:')) {
                        void onSelectProject(item.id.slice('project:'.length));
                        setPaletteOpen(false);
                        return;
                      }
                      openSurface(item.id as Surface);
                    }}
                  >
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
            <p className="muted">Ctrl/Cmd+K. Presentation only; Authority still decides on the server.</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ExecutionChip({ execution, sealed }: { execution: ExecutionRecord; sealed: boolean }) {
  const provider = execution.selectedProvider ?? execution.route?.provider ?? 'routing';
  const model = execution.selectedModel ?? execution.route?.model ?? '…';
  return (
    <div className={`execution-chip ${execution.status}`}>
      <span>
        <strong>
          {execution.capability} · {provider} · {model}
        </strong>
      </span>
      <span>{execution.status}</span>
      {sealed && execution.status === 'failed' ? <span>not continued on another provider</span> : null}
      {execution.failureReason ? <span>{execution.failureReason.message}</span> : null}
    </div>
  );
}

function ApprovalCard({
  tool,
  onDecide,
}: {
  tool: ToolPresentation;
  onDecide: (id: string, decision: 'approve' | 'deny') => Promise<void>;
}) {
  const desc = `${tool.title} ${tool.argumentSummary} risk ${tool.risk}`;
  return (
    <section className="approval atlas-motion" aria-label={`Approval required for ${tool.title}`}>
      <h3>Approval required</h3>
      <p>
        <strong>{tool.title}</strong> wants to run <code>{tool.toolId}</code> on {tool.resource ?? 'this project'}.
      </p>
      <p className="meta">{tool.argumentSummary}</p>
      <p className="meta">
        Risk {tool.risk} · {tool.sideEffectClass} · Authority {tool.requiredCapabilities.join(', ')}
      </p>
      <p className="muted">Buttons do not grant permission. The host checks the session principal and Authority.</p>
      <div className="row">
        <button type="button" className="primary" aria-describedby={undefined} title={desc} onClick={() => void onDecide(tool.id, 'approve')}>
          Approve
        </button>
        <button type="button" className="ghost" onClick={() => void onDecide(tool.id, 'deny')}>
          Deny
        </button>
      </div>
    </section>
  );
}

function RunInspector({ execution, tools }: { execution?: ExecutionRecord | null; tools: ToolPresentation[] }) {
  if (!execution) {
    return (
      <section>
        <h3>Run inspection</h3>
        <p className="muted">No run yet. Identity, route, provider, tools and provenance appear here after a turn.</p>
      </section>
    );
  }
  return (
    <section>
      <h3>Run inspection</h3>
      <dl className="facts">
        <div>
          <dt>Identity</dt>
          <dd>{execution.id}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{execution.status}</dd>
        </div>
        <div>
          <dt>Capability</dt>
          <dd>{execution.capability}</dd>
        </div>
        <div>
          <dt>Route</dt>
          <dd>{execution.route?.decisionReason ?? 'pending'}</dd>
        </div>
        <div>
          <dt>Provider / model</dt>
          <dd>
            {execution.selectedProvider ?? '—'} / {execution.selectedModel ?? '—'}
          </dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{execution.startedAt ?? '—'}</dd>
        </div>
        <div>
          <dt>Completed</dt>
          <dd>{execution.completedAt ?? '—'}</dd>
        </div>
        <div>
          <dt>Failure</dt>
          <dd>{execution.failureReason?.message ?? 'none'}</dd>
        </div>
      </dl>
      <h4>Attempts</h4>
      <ul className="plain">
        {execution.attempts.map((attempt) => (
          <li key={`${attempt.index}-${attempt.provider}`}>
            {attempt.provider}/{attempt.model} · {attempt.outcome}
            {attempt.emittedVisibleOutput ? ' · visible output begun' : ''}
          </li>
        ))}
      </ul>
      <h4>Tools on this run</h4>
      {tools.length === 0 ? <p className="muted">None.</p> : <p className="meta">{tools.map((item) => `${item.toolId}:${item.status}`).join(' · ')}</p>}
    </section>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
