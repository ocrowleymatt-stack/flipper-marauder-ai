import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  attachFile,
  bootstrapSession,
  CAPABILITIES,
  cancelExecution,
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
  revokeSession,
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
import { LoginForm } from './login';
import { playCue, prefersReducedMotion, setSoundEnabled, soundEnabled } from './experience';
import {
  applyStream,
  capabilityLabel,
  emptyView,
  ensureView,
  runStatusLabel,
  userRunLabel,
  viewFromSnapshot,
  type StreamView,
} from './stream';

type InspectorTab = 'run' | 'files' | 'context' | 'tools';
type Surface = 'conversation' | 'writing' | 'osint' | 'investigation' | 'research' | 'website' | 'music' | 'privacy' | 'operations';

export function App() {
  const [session, setSession] = useState<SessionState | null>(null);
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
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(true);
  const [moreOpen, setMoreOpen] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLElement>(null);
  const stickToBottom = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const composerId = useId();
  const liveId = useId();

  const snapshot = view?.snapshot ?? null;
  const latestExecution = snapshot?.executions.at(-1) ?? null;
  const awaiting = tools.filter((item) => item.awaitingApproval);
  const runLabel = userRunLabel(latestExecution?.status, awaiting.length > 0, busy);
  const needsAttention = awaiting.length > 0 || Boolean(view?.classifiedFailure);
  const lastUserMessage = [...(snapshot?.messages ?? [])].reverse().find((item) => item.role === 'user');
  const canRetry = Boolean(
    !busy &&
      activeConversationId &&
      lastUserMessage &&
      (latestExecution?.status === 'failed' || latestExecution?.status === 'cancelled' || view?.classifiedFailure),
  );

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

  const enterWorkbench = useCallback(
    async (next: SessionState) => {
      setSession(next);
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
        setStatus(first ? 'Ready.' : 'Create a project to begin.');
      } else {
        setProjectsAvailable(false);
        setSurface('conversation');
        const convos = await listConversations();
        setConversations(convos);
        const nextId = convos[0]?.id ?? null;
        setActiveConversationId(nextId);
        if (nextId) await loadConversation(nextId);
        setStatus('Ready.');
      }
    },
    [loadConversation, loadProject, loadProjects],
  );

  useEffect(() => {
    void (async () => {
      try {
        const next = await bootstrapSession();
        if (!next.authenticated) {
          setSession(next);
          setStatus('Signed out.');
          setLoading(false);
          return;
        }
        await enterWorkbench(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus('Workbench failed to load.');
      } finally {
        setLoading(false);
      }
    })();
  }, [enterWorkbench]);

  useEffect(() => {
    if (needsAttention) setDetailsOpen(true);
  }, [needsAttention]);

  useEffect(() => {
    if (!stickToBottom.current) return;
    const scroller = messagesRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    else bottom.current?.scrollIntoView({ block: 'end' });
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
      setStatus('Reloaded.');
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
      setSurface('conversation');
      await loadProject(project.id);
      setStatus(`Opened ${project.name}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onSelectProject(id: string) {
    setProjectId(id);
    setNavOpen(false);
    setError(null);
    setSurface('conversation');
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
      setSurface('conversation');
      setStatus('New conversation.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onOpenConversation(id: string) {
    setActiveConversationId(id);
    setNavOpen(false);
    setError(null);
    setSurface('conversation');
    try {
      await loadConversation(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runPrompt(conversationId: string, content: string, selected: Capability) {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    stickToBottom.current = true;
    setBusy(true);
    setError(null);
    setStatus('Working…');
    setSurface('conversation');
    setView((current) =>
      ensureView(current, conversationId, {
        id: conversationId,
        urn: current?.snapshot.conversation.urn ?? `urn:atlas:conversation:${conversationId}`,
        title: current?.snapshot.conversation.title ?? 'Conversation',
        projectId: current?.snapshot.conversation.projectId ?? projectId,
        createdAt: current?.snapshot.conversation.createdAt ?? new Date().toISOString(),
        updatedAt: current?.snapshot.conversation.updatedAt ?? new Date().toISOString(),
      }),
    );
    try {
      for await (const event of sendMessage(conversationId, content, selected, abort.signal)) {
        if (abort.signal.aborted) break;
        setView((current) =>
          applyStream(
            ensureView(current, conversationId, {
              id: conversationId,
              urn: `urn:atlas:conversation:${conversationId}`,
              title: 'Conversation',
              projectId,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }),
            conversationId,
            event,
            runtimeWaitingLabel,
          ),
        );
        if (event.type === 'tool.lifecycle') {
          await listConversationTools(conversationId)
            .then(setTools)
            .catch(() => undefined);
          await listApprovals()
            .then(setApprovals)
            .catch(() => undefined);
        }
      }
      if (abort.signal.aborted) {
        setStatus('Stopped.');
        await loadConversation(conversationId).catch(() => undefined);
        return;
      }
      await loadConversation(conversationId);
      setConversations(projectId ? await listProjectConversations(projectId) : await listConversations());
      playCue('complete');
      setStatus('Done.');
    } catch (err) {
      if (abort.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        setStatus('Stopped.');
        await loadConversation(conversationId).catch(() => undefined);
        return;
      }
      playCue('warn');
      setError(err instanceof Error ? err.message : String(err));
      setStatus('Request failed.');
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
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
    stickToBottom.current = true;
    await runPrompt(conversationId, content, capability);
  }

  async function onStop() {
    abortRef.current?.abort();
    const executionId = latestExecution?.id;
    if (executionId && (latestExecution?.status === 'running' || latestExecution?.status === 'queued')) {
      await cancelExecution(executionId).catch(() => undefined);
    }
    setBusy(false);
    setStatus('Stopped.');
  }

  async function onRetry() {
    if (!canRetry || !activeConversationId || !lastUserMessage) return;
    await runPrompt(activeConversationId, lastUserMessage.content, capability);
  }

  async function onUpload(event: FormEvent) {
    event.preventDefault();
    if (!projectId || !fileDraft.path.trim() || !fileDraft.text.trim()) return;
    try {
      await uploadTextFile(projectId, fileDraft.path.trim(), fileDraft.text);
      setFileDraft((current) => ({ ...current, text: '' }));
      setFiles(await listFiles(projectId));
      setStatus('File stored in this project.');
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
      setStatus('Dropped files stored in this project.');
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
      setStatus(decision === 'approve' ? 'Approved.' : 'Denied.');
      playCue(decision === 'approve' ? 'complete' : 'warn');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const citations = useMemo(() => citationsFromBackend(context), [context]);
  const currentProject = projects.find((item) => item.id === projectId) ?? null;
  const writingDungeon = dungeons.find((item) => item.id === 'writing' && item.featureAvailable);
  const extraDungeons = dungeons.filter((item) => item.featureAvailable && item.id !== 'writing');
  const attachedIds = new Set(context?.slices.map((slice) => slice.fileId) ?? []);
  const modelLine = latestExecution
    ? [capabilityLabel(latestExecution.capability), latestExecution.selectedModel ?? latestExecution.route?.model]
        .filter(Boolean)
        .join(' · ')
    : capabilityLabel(capability);
  const paletteItems = useMemo(() => {
    const q = paletteQuery.trim().toLowerCase();
    const surfaces: Array<{ id: Surface; label: string }> = [
      { id: 'conversation', label: 'Conversation' },
      ...(writingDungeon ? [{ id: 'writing' as Surface, label: writingDungeon.navLabel }] : []),
      { id: 'operations', label: 'Help & Repair' },
      ...extraDungeons.map((item) => ({ id: item.id as Surface, label: item.navLabel })),
    ];
    return [
      ...surfaces.filter((item) => !q || item.label.toLowerCase().includes(q)),
      ...projects
        .filter((item) => !q || item.name.toLowerCase().includes(q))
        .map((item) => ({ id: `project:${item.id}` as const, label: `Project ${item.name}` })),
    ];
  }, [extraDungeons, paletteQuery, projects, writingDungeon]);

  if (loading) {
    return (
      <div className="boot" role="status">
        Loading Atlas Workbench.
      </div>
    );
  }

  if (!session?.authenticated) {
    return (
      <LoginForm
        onAuthenticated={async (next) => {
          setLoading(true);
          setError(null);
          try {
            await enterWorkbench(next);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setStatus('Workbench failed to load.');
          } finally {
            setLoading(false);
          }
        }}
      />
    );
  }

  const layoutClass = [
    'layout',
    navOpen ? 'nav-open' : '',
    detailsOpen || needsAttention ? 'details-open' : '',
    needsAttention ? 'needs-attention' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={`shell ${dropActive ? 'drop-active' : ''} ${prefersReducedMotion() ? 'reduced-motion' : 'atlas-motion'}`}
      data-testid="workbench-shell"
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
          <p className="eyebrow">Atlas</p>
          <h1>{currentProject?.name ?? 'Workbench'}</h1>
        </div>
        <div className="topbar-actions">
          <p id={liveId} className="status" aria-live="polite">
            {status}
          </p>
          <button
            type="button"
            className="ghost"
            data-testid="details-toggle"
            aria-pressed={detailsOpen}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            {detailsOpen ? 'Hide details' : 'Details'}
          </button>
          <button type="button" className="ghost nav-toggle" onClick={() => setNavOpen((open) => !open)} aria-expanded={navOpen}>
            {navOpen ? 'Close navigation' : 'Menu'}
          </button>
          <button type="button" className="ghost" onClick={() => void refreshAll()} disabled={busy}>
            Reload
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              void (async () => {
                abortRef.current?.abort();
                await revokeSession();
                setSession({ authenticated: false, bootstrapAllowed: false, loginAvailable: true, csrfToken: null, principal: null });
                setProjects([]);
                setConversations([]);
                setView(null);
                setStatus('Signed out.');
              })();
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <div className={layoutClass}>
        <nav className="nav" aria-label="Projects and conversations">
          <form className="stack" onSubmit={(event) => void onCreateProject(event)}>
            <label htmlFor="project-name">New project</label>
            <input
              id="project-name"
              data-testid="new-project-name"
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder="Named workspace"
              autoComplete="off"
            />
            <button type="submit" className="primary" data-testid="create-project" disabled={!projectName.trim()}>
              Create project
            </button>
          </form>
          <h2>Projects</h2>
          {projects.length === 0 ? (
            <p className="muted">Create a project to start a conversation.</p>
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
            <h2>Conversations</h2>
            <button
              type="button"
              className="ghost compact"
              data-testid="new-conversation"
              onClick={() => void onCreateConversation()}
              disabled={projectsAvailable && !projectId}
            >
              New
            </button>
          </div>
          {conversations.length === 0 ? (
            <p className="muted">No conversations yet. Send a message to start one.</p>
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
          <div className="row">
            <h2>Workspace</h2>
          </div>
          <ul className="plain">
            <li>
              <button
                type="button"
                className={surface === 'conversation' ? 'active' : ''}
                data-testid="surface-conversation"
                onClick={() => openSurface('conversation')}
                disabled={projectsAvailable && !projectId}
              >
                Conversation
              </button>
            </li>
            {writingDungeon ? (
              <li>
                <button
                  type="button"
                  className={surface === 'writing' ? 'active' : ''}
                  data-testid="surface-writing"
                  onClick={() => openSurface('writing')}
                  disabled={!projectId}
                >
                  {writingDungeon.navLabel}
                </button>
              </li>
            ) : null}
          </ul>
          <details className="nav-fold" open={filesOpen} onToggle={(event) => setFilesOpen(event.currentTarget.open)}>
            <summary>Files</summary>
            <p className="muted">Attach a file to this conversation. Bytes stay on the server.</p>
            <form className="stack" onSubmit={(event) => void onUpload(event)}>
              <label htmlFor="file-path">Name</label>
              <input
                id="file-path"
                data-testid="file-path"
                value={fileDraft.path}
                onChange={(event) => setFileDraft((current) => ({ ...current, path: event.target.value }))}
              />
              <label htmlFor="file-text">Text</label>
              <textarea
                id="file-text"
                data-testid="file-text"
                value={fileDraft.text}
                onChange={(event) => setFileDraft((current) => ({ ...current, text: event.target.value }))}
                rows={3}
              />
              <button type="submit" className="primary" data-testid="upload-file" disabled={!projectId || !fileDraft.text.trim()}>
                Add file
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
                        {attachedIds.has(file.id) ? 'attached' : file.status} · {file.sizeBytes} B
                      </span>
                    </div>
                    <button
                      type="button"
                      className="ghost compact"
                      data-testid={`attach-file-${file.id}`}
                      onClick={() => void onAttach(file.id)}
                      disabled={!activeConversationId}
                    >
                      {attachedIds.has(file.id) ? 'Attached' : 'Attach'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </details>
          <details className="nav-fold" open={moreOpen} onToggle={(event) => setMoreOpen(event.currentTarget.open)}>
            <summary>More</summary>
            <ul className="plain">
              <li>
                <button
                  type="button"
                  className={surface === 'operations' ? 'active' : ''}
                  data-testid="surface-operations"
                  onClick={() => openSurface('operations')}
                >
                  Help & Repair
                </button>
              </li>
              {extraDungeons.map((item) => (
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
            <p className="muted">Ctrl/Cmd+K jumps anywhere.</p>
          </details>
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
                <h2>{snapshot?.conversation.title ?? currentProject?.name ?? 'Start a conversation'}</h2>
                <p className="hint" data-testid="model-label">
                  {modelLine}
                  {context?.slices.length ? ` · ${context.slices.length} attached source${context.slices.length === 1 ? '' : 's'}` : ''}
                </p>
              </div>
              <p className={`pill ${latestExecution?.status ?? (busy ? 'running' : 'idle')}`} data-testid="run-status" aria-live="polite">
                {runLabel}
              </p>
            </header>
            <section
              className="messages"
              ref={messagesRef}
              aria-label="Messages"
              data-testid="conversation-messages"
              onScroll={() => {
                const el = messagesRef.current;
                if (!el) return;
                stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
              }}
            >
              {!snapshot || snapshot.messages.length === 0 ? (
                <div className="empty">
                  <h3>Where the answer appears</h3>
                  <p>Type below. Atlas replies in this thread, and the reply stays after you refresh.</p>
                </div>
              ) : (
                snapshot.messages.map((message) => {
                  const execution = snapshot.executions.find((item) => item.id === message.executionId);
                  const streaming = busy && message.role === 'assistant' && message.id === snapshot.messages.at(-1)?.id;
                  return (
                    <article
                      key={message.id}
                      className={`message ${message.role}${streaming ? ' streaming' : ''}`}
                      data-testid={`message-${message.role}`}
                      data-message-id={message.id}
                    >
                      {message.role === 'assistant' ? <div className="role">Atlas</div> : <div className="role">You</div>}
                      <div className="body">{message.content || (busy && message.role === 'assistant' ? '…' : '')}</div>
                      {message.role === 'assistant' && execution ? (
                        <p className="reply-meta">
                          {capabilityLabel(execution.capability)}
                          {execution.selectedModel ? ` · ${execution.selectedModel}` : ''}
                          {execution.status === 'failed' && execution.failureReason ? ` · ${execution.failureReason.message}` : ''}
                        </p>
                      ) : null}
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
              <div className="error" role="alert" data-testid="conversation-error">
                <span>{error ?? view?.classifiedFailure}</span>
                {view?.sealedResponse ? <span className="meta">Visible output already began; Atlas did not disguise a provider switch.</span> : null}
                {canRetry ? (
                  <button type="button" className="ghost compact" onClick={() => void onRetry()}>
                    Retry
                  </button>
                ) : null}
              </div>
            ) : null}
            {awaiting.map((item) => (
              <ApprovalCard key={item.id} tool={item} onDecide={onDecide} />
            ))}
            <form id={composerId} className="composer" data-testid="composer" onSubmit={(event) => void onSubmit(event)}>
              <label htmlFor="draft">Message</label>
              <div className="composer-box">
                <textarea
                  id="draft"
                  data-testid="composer-draft"
                  value={draft}
                  placeholder={projectId || !projectsAvailable ? 'Message Atlas…' : 'Create or open a project first.'}
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
                  Model
                </label>
                <select
                  id="capability"
                  data-testid="composer-model"
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
                {busy ? (
                  <button className="ghost" type="button" data-testid="composer-stop" onClick={() => void onStop()}>
                    Stop
                  </button>
                ) : canRetry ? (
                  <button className="ghost" type="button" data-testid="composer-retry" onClick={() => void onRetry()}>
                    Retry
                  </button>
                ) : null}
                <button
                  className="send"
                  type="submit"
                  data-testid="composer-send"
                  disabled={busy || !draft.trim() || (projectsAvailable && !projectId)}
                >
                  {busy ? 'Working' : 'Send'}
                </button>
              </div>
            </form>
          </main>
        )}
        <aside className="inspector" aria-label="Details">
          <div className="tabs" role="tablist" aria-label="Details">
            {([
              ['run', 'Reply'],
              ['files', 'Files'],
              ['context', 'Sources'],
              ['tools', 'Tools'],
            ] as const).map(([item, label]) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={tab === item}
                className={tab === item ? 'active' : ''}
                onClick={() => setTab(item)}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === 'run' ? (
            <RunInspector execution={inspection?.execution ?? latestExecution} tools={inspection?.tools ?? tools} />
          ) : null}
          {tab === 'files' ? (
            <section>
              <h3>Files</h3>
              <p className="muted">Same project files as the left rail. Attach them to this conversation.</p>
              {files.length === 0 ? (
                <p className="muted">No files in this project.</p>
              ) : (
                <ul className="plain">
                  {files.map((file) => (
                    <li key={file.id} className="file-row">
                      <div>
                        <strong>{file.displayName}</strong>
                        <span className="meta">
                          {file.path} · {file.status}
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
              <h3>Sources</h3>
              <p className="muted">Material retrieved for this conversation. Atlas does not invent citations.</p>
              {citations.length === 0 && !context?.slices.length ? (
                <p className="muted">No attached or retrieved material yet.</p>
              ) : (
                <ul className="plain">
                  {context?.slices.map((slice) => (
                    <li key={slice.chunkId}>
                      <strong>{slice.path}</strong>
                      <span className="meta">
                        {slice.source}
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
          <div className="inspector-foot">
            <button
              type="button"
              className="ghost compact"
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
          </div>
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
              placeholder="Conversation, writing, or project"
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
            <p className="muted">Ctrl/Cmd+K. Presentation only; the server still decides what is allowed.</p>
          </div>
        </div>
      ) : null}
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
        Risk {tool.risk} · {tool.sideEffectClass}
      </p>
      <p className="muted">Buttons do not grant permission. The host checks the session and Authority.</p>
      <div className="row">
        <button type="button" className="primary" title={desc} onClick={() => void onDecide(tool.id, 'approve')}>
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
        <h3>This reply</h3>
        <p className="muted">After you send a message, the model and status for that reply appear here.</p>
      </section>
    );
  }
  return (
    <section>
      <h3>This reply</h3>
      <dl className="facts">
        <div>
          <dt>Status</dt>
          <dd>{runStatusLabel(execution.status, false)}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>
            {capabilityLabel(execution.capability)}
            {execution.selectedModel ? ` · ${execution.selectedModel}` : ''}
          </dd>
        </div>
        <div>
          <dt>Provider</dt>
          <dd>{execution.selectedProvider ?? '—'}</dd>
        </div>
        {execution.failureReason ? (
          <div>
            <dt>Failure</dt>
            <dd>{execution.failureReason.message}</dd>
          </div>
        ) : null}
      </dl>
      <details className="nav-fold">
        <summary>Advanced</summary>
        <dl className="facts">
          <div>
            <dt>Identity</dt>
            <dd>{execution.id}</dd>
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
            <dt>Started</dt>
            <dd>{execution.startedAt ?? '—'}</dd>
          </div>
          <div>
            <dt>Completed</dt>
            <dd>{execution.completedAt ?? '—'}</dd>
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
      </details>
    </section>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
