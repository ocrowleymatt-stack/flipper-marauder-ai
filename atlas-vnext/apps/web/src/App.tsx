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
  getDoctorReport,
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
  type DoctorReport,
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
import { MarkdownBody } from './markdown';
import { playCue, prefersReducedMotion } from './experience';
import {
  applyStream,
  approvalAuthorityLine,
  conversationDisplayTitle,
  doctorTone,
  ellipsize,
  emptyView,
  ensureView,
  executionToStop,
  liveExecution,
  runStatusLabel,
  viewFromSnapshot,
  type StreamView,
} from './stream';

type Surface =
  | 'conversation'
  | 'files'
  | 'context'
  | 'writing'
  | 'osint'
  | 'investigation'
  | 'research'
  | 'website'
  | 'music'
  | 'privacy'
  | 'operations';

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
  const [surface, setSurface] = useState<Surface>('conversation');
  const [dungeons, setDungeons] = useState<DungeonRegistration[]>([]);
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [conversationQuery, setConversationQuery] = useState('');
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [doctorVisible, setDoctorVisible] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLElement>(null);
  const stickToBottom = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const composerId = useId();
  const liveId = useId();
  const draftRef = useRef('');

  const snapshot = view?.snapshot ?? null;
  const snapshotExecution = snapshot?.executions.at(-1) ?? null;
  const latestExecution = liveExecution(busy, snapshotExecution, inspection?.execution);
  const awaiting = tools.filter((item) => item.awaitingApproval);
  const runLabel = busy ? 'Generating…' : runStatusLabel(latestExecution?.status, awaiting.length > 0);
  const currentProject = projects.find((item) => item.id === projectId) ?? null;
  const doctorView = doctorVisible && doctor ? doctorTone(doctor.state, doctor.checks) : null;

  const loadProjects = useCallback(async () => {
    const items = await listProjects();
    setProjects(items);
    return items;
  }, []);

  const loadConversation = useCallback(async (conversationId: string) => {
    const nextSnapshot = await getSnapshot(conversationId);
    setView(viewFromSnapshot(nextSnapshot));
    const [conversationTools, assembled, pending] = await Promise.all([
      listConversationTools(conversationId).catch(() => []),
      nextSnapshot.conversation.projectId
        ? getProjectContext(nextSnapshot.conversation.projectId, nextSnapshot.conversation.title, conversationId).catch(
            () => null,
          )
        : Promise.resolve(null),
      listApprovals().catch(() => []),
    ]);
    setTools(conversationTools);
    setContext(assembled);
    setApprovals(pending);
    const executionId = nextSnapshot.executions.at(-1)?.id;
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
      const nextId =
        preferredConversationId && convos.some((item) => item.id === preferredConversationId)
          ? preferredConversationId
          : convos[0]?.id ?? null;
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
      setSurface('conversation');
      const report = await getDoctorReport().catch(() => null);
      if (report) {
        setDoctor(report);
        setDoctorVisible(true);
      }
      if (projectItems) {
        setProjectsAvailable(true);
        const first = projectItems[0]?.id ?? null;
        setProjectId(first);
        if (first) await loadProject(first);
        setStatus(first ? 'Ready.' : 'Create a project to begin.');
      } else {
        setProjectsAvailable(false);
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
    if (!stickToBottom.current) return;
    const scroller = messagesRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    else bottom.current?.scrollIntoView({ block: 'end' });
  }, [snapshot?.messages, snapshot?.executions, view?.waitLabel, busy]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        playCue('activate');
      }
      if (event.key === 'Escape') {
        setPaletteOpen(false);
        setDiagnosticsOpen(false);
        setNavOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function goToConversation() {
    setSurface('conversation');
    setNavOpen(false);
  }

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
      await loadProject(project.id);
      goToConversation();
      setStatus(`Opened ${project.name}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onSelectProject(id: string) {
    setProjectId(id);
    setError(null);
    try {
      await loadProject(id);
      goToConversation();
      setStatus(`Opened ${projects.find((item) => item.id === id)?.name ?? 'project'}.`);
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
      goToConversation();
      setStatus('New conversation.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onOpenConversation(id: string) {
    setActiveConversationId(id);
    setError(null);
    goToConversation();
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
    setSurface('conversation');
    setStatus('Generating…');
    setView((current) => {
      const base = ensureView(current, conversationId, {
        id: conversationId,
        urn: current?.snapshot.conversation.urn ?? '',
        title: current?.snapshot.conversation.title ?? 'New conversation',
        projectId: current?.snapshot.conversation.projectId ?? projectId,
        createdAt: current?.snapshot.conversation.createdAt ?? new Date().toISOString(),
        updatedAt: current?.snapshot.conversation.updatedAt ?? new Date().toISOString(),
      });
      const optimistic = {
        id: `local_user_${Date.now()}`,
        urn: '',
        conversationId,
        role: 'user' as const,
        content,
        sequence: (base.snapshot.messages.at(-1)?.sequence ?? 0) + 1,
        executionId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return {
        ...base,
        sealedResponse: false,
        classifiedFailure: null,
        waitLabel: 'Generating…',
        snapshot: { ...base.snapshot, messages: [...base.snapshot.messages, optimistic] },
      };
    });
    try {
      for await (const event of sendMessage(conversationId, content, selected, abort.signal)) {
        if (abort.signal.aborted) break;
        setView((current) => {
          const base =
            current ??
            emptyView({
              id: conversationId,
              urn: '',
              title: 'New conversation',
              projectId,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          return applyStream(base, conversationId, event, runtimeWaitingLabel);
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
      if (abort.signal.aborted) {
        setStatus('Stopped.');
        if (abortRef.current === abort) {
          await loadConversation(conversationId).catch(() => undefined);
        }
        return;
      }
      await loadConversation(conversationId);
      setConversations(projectId ? await listProjectConversations(projectId) : await listConversations());
      playCue('complete');
      setStatus('Completed.');
    } catch (err) {
      if (abort.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        setStatus('Stopped.');
        if (abortRef.current === abort) {
          await loadConversation(conversationId).catch(() => undefined);
        }
        return;
      }
      playCue('warn');
      setError(err instanceof Error ? err.message : String(err));
      setStatus('Request failed.');
    } finally {
      if (abortRef.current === abort) {
        abortRef.current = null;
        setBusy(false);
      }
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
    draftRef.current = content;
    await runPrompt(conversationId, content, capability);
  }

  async function onStop() {
    abortRef.current?.abort();
    const live = executionToStop(busy, snapshot?.executions.at(-1));
    if (live) {
      await cancelExecution(live.id).catch(() => undefined);
    }
    setStatus('Stopped.');
  }

  async function onUpload(event: FormEvent) {
    event.preventDefault();
    if (!projectId || !fileDraft.path.trim() || !fileDraft.text.trim()) return;
    try {
      await uploadTextFile(projectId, fileDraft.path.trim(), fileDraft.text);
      setFileDraft((current) => ({ ...current, text: '' }));
      setFiles(await listFiles(projectId));
      setStatus('File added to this project.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onAttach(fileId: string) {
    if (!activeConversationId || !projectId) return;
    try {
      await attachFile(fileId, activeConversationId);
      setContext(await getProjectContext(projectId, snapshot?.conversation.title ?? '', activeConversationId));
      setStatus('File available to this conversation.');
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
      setStatus('Files added to this project.');
    } catch (err) {
      playCue('warn');
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function openSurface(next: Surface) {
    setSurface(next);
    setNavOpen(false);
    setPaletteOpen(false);
    if (next === 'conversation') setDiagnosticsOpen(false);
    playCue('activate');
  }

  async function onDecide(id: string, decision: 'approve' | 'deny') {
    try {
      await decideTool(id, decision);
      if (activeConversationId) await loadConversation(activeConversationId);
      setApprovals(await listApprovals());
      setStatus(decision === 'approve' ? 'Approved on the server.' : 'Denied on the server.');
      playCue(decision === 'approve' ? 'complete' : 'warn');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const citations = useMemo(() => citationsFromBackend(context), [context]);
  const filteredConversations = useMemo(() => {
    const q = conversationQuery.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((item) => conversationDisplayTitle(item.title).toLowerCase().includes(q));
  }, [conversationQuery, conversations]);
  const paletteItems = useMemo(() => {
    const q = paletteQuery.trim().toLowerCase();
    const surfaces: Array<{ id: Surface; label: string }> = [
      { id: 'conversation', label: 'Conversation' },
      { id: 'files', label: 'Files' },
      { id: 'context', label: 'Context' },
      { id: 'writing', label: 'Caspa' },
      { id: 'operations', label: 'Help & Repair' },
      ...dungeons
        .filter((item) => item.featureAvailable)
        .map((item) => ({ id: item.id as Surface, label: item.navLabel.replace(/Studio/i, '').trim() })),
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
        Loading Atlas.
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

  const threadTitle = conversationDisplayTitle(snapshot?.conversation.title, currentProject?.name ?? 'Conversation');

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
        <div className="brand-row">
          <button type="button" className="ghost nav-toggle" onClick={() => setNavOpen((open) => !open)} aria-expanded={navOpen}>
            {navOpen ? 'Close menu' : 'Menu'}
          </button>
          <p className="eyebrow">Atlas</p>
        </div>
        <label className="project-switch">
          <span className="sr-only">Current project</span>
          <select
            value={projectId ?? ''}
            onChange={(event) => {
              if (event.target.value) void onSelectProject(event.target.value);
            }}
            aria-label="Current project"
          >
            {projects.length === 0 ? <option value="">No project</option> : null}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <div className="topbar-actions">
          <p id={liveId} className="status" aria-live="polite">
            {status}
          </p>
          <button type="button" className="ghost" onClick={() => setPaletteOpen(true)}>
            Search
          </button>
          {doctorView ? (
            <button
              type="button"
              className={`doctor-chip ${doctorView.tone}`}
              data-testid="doctor-chip"
              onClick={() => openSurface('operations')}
              title={doctor?.state === 'ATTENTION_REQUIRED' ? 'Optional services need attention. Atlas can still work.' : doctor?.state}
            >
              <span className="doctor-dot" aria-hidden="true" />
              {doctorView.label}
            </button>
          ) : null}
          <button
            type="button"
            className="ghost"
            data-testid="diagnostics-toggle"
            aria-pressed={diagnosticsOpen}
            onClick={() => setDiagnosticsOpen((open) => !open)}
          >
            {diagnosticsOpen ? 'Close details' : 'Run details'}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              void (async () => {
                await revokeSession();
                setSession({
                  authenticated: false,
                  bootstrapAllowed: false,
                  loginAvailable: true,
                  csrfToken: null,
                  principal: null,
                });
                setView(null);
                setStatus('Signed out.');
              })();
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <div className={`layout ${navOpen ? 'nav-open' : ''} ${diagnosticsOpen ? 'diagnostics-open' : ''}`}>
        <nav className="nav" aria-label="Workspace">
          <button type="button" className="primary new-conversation" data-testid="new-conversation" onClick={() => void onCreateConversation()} disabled={projectsAvailable && !projectId}>
            New conversation
          </button>
          <form className="stack compact-form" onSubmit={(event) => void onCreateProject(event)}>
            <label htmlFor="project-name">New project</label>
            <input
              id="project-name"
              data-testid="new-project-name"
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder="Named workspace"
              autoComplete="off"
            />
            <button type="submit" className="ghost compact" data-testid="create-project" disabled={!projectName.trim()}>
              Create project
            </button>
          </form>
          <div className="nav-section">
            <div className="row">
              <h2>Conversations</h2>
            </div>
            <label className="sr-only" htmlFor="conversation-search">
              Search conversations
            </label>
            <input
              id="conversation-search"
              value={conversationQuery}
              onChange={(event) => setConversationQuery(event.target.value)}
              placeholder="Search"
            />
            {filteredConversations.length === 0 ? (
              <p className="muted">No conversations yet.</p>
            ) : (
              <ul className="plain conversation-list">
                {filteredConversations.map((conversation) => (
                  <li key={conversation.id}>
                    <button
                      type="button"
                      className={conversation.id === activeConversationId && surface === 'conversation' ? 'active' : ''}
                      onClick={() => void onOpenConversation(conversation.id)}
                      aria-current={conversation.id === activeConversationId ? 'page' : undefined}
                    >
                      <span className="conv-title">{ellipsize(conversationDisplayTitle(conversation.title), 42)}</span>
                      <time className="conv-meta" dateTime={conversation.updatedAt}>
                        {formatTime(conversation.updatedAt)}
                      </time>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="nav-section">
            <h2>Project</h2>
            <ul className="plain">
              <li>
                <button type="button" className={surface === 'files' ? 'active' : ''} data-testid="surface-files" onClick={() => openSurface('files')} disabled={!projectId}>
                  Files
                </button>
              </li>
              <li>
                <button type="button" className={surface === 'context' ? 'active' : ''} onClick={() => openSurface('context')} disabled={!projectId}>
                  Context
                </button>
              </li>
              <li>
                <button type="button" className={surface === 'writing' ? 'active' : ''} data-testid="surface-writing" onClick={() => openSurface('writing')} disabled={!projectId}>
                  Caspa
                </button>
              </li>
            </ul>
          </div>
          <div className="nav-section">
            <h2>Tools</h2>
            <ul className="plain">
              {dungeons
                .filter((item) => item.featureAvailable && item.id !== 'writing')
                .map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={surface === item.id ? 'active' : ''}
                      onClick={() => openSurface(item.id as Surface)}
                      disabled={item.id !== 'privacy' && !projectId}
                    >
                      {item.navLabel.replace(/Studio/i, '').trim()}
                    </button>
                  </li>
                ))}
              <li>
                <button type="button" className={surface === 'operations' ? 'active' : ''} onClick={() => openSurface('operations')}>
                  Help & Repair
                </button>
              </li>
            </ul>
          </div>
        </nav>
        {surface === 'writing' && projectId ? (
          <section className="workspace-wrap">
            <SurfaceBack onBack={goToConversation} label="Caspa" />
            <CaspaPanel projectId={projectId} files={files} busy={busy} setBusy={setBusy} onStatus={setStatus} onError={setError} />
          </section>
        ) : surface === 'files' ? (
          <FilesSurface
            files={files}
            fileDraft={fileDraft}
            setFileDraft={setFileDraft}
            onUpload={onUpload}
            onAttach={onAttach}
            canAttach={Boolean(activeConversationId)}
            projectReady={Boolean(projectId)}
            onBack={goToConversation}
          />
        ) : surface === 'context' ? (
          <ContextSurface context={context} citations={citations} onBack={goToConversation} />
        ) : surface === 'operations' ? (
          <section className="workspace-wrap">
            <SurfaceBack onBack={goToConversation} label="Help & Repair" />
            <EstatePanel dungeonId="operations" projectId={projectId} files={files} busy={busy} setBusy={setBusy} onStatus={setStatus} onError={setError} />
          </section>
        ) : surface !== 'conversation' ? (
          <section className="workspace-wrap">
            <SurfaceBack onBack={goToConversation} label={dungeons.find((item) => item.id === surface)?.navLabel.replace(/Studio/i, '').trim() ?? 'Tool'} />
            <EstatePanel dungeonId={surface} projectId={projectId} files={files} busy={busy} setBusy={setBusy} onStatus={setStatus} onError={setError} />
          </section>
        ) : (
          <main className="workspace" aria-label="Conversation">
            <header className="thread-header">
              <div>
                <h1>{threadTitle}</h1>
                <p className="hint">{currentProject ? currentProject.name : 'Ask Atlas. Answers stay in this conversation.'}</p>
              </div>
              <p className={`pill ${busy ? 'running' : latestExecution?.status ?? 'idle'}`} data-testid="run-status" aria-live="polite">
                {runLabel}
              </p>
            </header>
            <section
              className="messages"
              ref={messagesRef}
              aria-label="Messages"
              data-testid="conversation-thread"
              onScroll={() => {
                const el = messagesRef.current;
                if (!el) return;
                stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
              }}
            >
              {!snapshot || snapshot.messages.length === 0 ? (
                <div className="empty">
                  <h2>Ask Atlas</h2>
                  <p>Type below. Atlas will answer in this conversation, and the answer stays after you refresh.</p>
                </div>
              ) : (
                snapshot.messages.map((message) => (
                  <article
                    key={message.id}
                    className={`message ${message.role}${busy && message.role === 'assistant' && message.id === snapshot.messages.at(-1)?.id ? ' streaming' : ''}`}
                    data-role={message.role}
                    data-testid={message.role === 'assistant' ? 'message-assistant' : 'message-user'}
                  >
                    <div className="role">{message.role === 'assistant' ? 'Atlas' : 'You'}</div>
                    <div className="body" data-testid={message.role === 'assistant' ? 'assistant-output' : 'user-turn'}>
                      {message.role === 'assistant' ? (
                        message.content ? (
                          <MarkdownBody text={message.content} />
                        ) : busy ? (
                          'Generating…'
                        ) : (
                          ''
                        )
                      ) : (
                        message.content
                      )}
                    </div>
                    {message.role === 'assistant' && message.content ? (
                      <button
                        type="button"
                        className="ghost compact copy"
                        onClick={() => void navigator.clipboard.writeText(message.content)}
                      >
                        Copy
                      </button>
                    ) : null}
                  </article>
                ))
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
                {activeConversationId && !busy ? (
                  <button
                    type="button"
                    className="ghost compact"
                    onClick={() => {
                      const lastUser = [...(snapshot?.messages ?? [])].reverse().find((item) => item.role === 'user');
                      const retry = lastUser?.content || draftRef.current;
                      if (retry && activeConversationId) void runPrompt(activeConversationId, retry, capability);
                    }}
                  >
                    Retry
                  </button>
                ) : null}
              </div>
            ) : null}
            {awaiting.map((item) => (
              <ApprovalCard key={item.id} tool={item} onDecide={onDecide} />
            ))}
            <form id={composerId} className="composer" data-testid="composer" onSubmit={(event) => void onSubmit(event)}>
              <label htmlFor="draft">Ask Atlas</label>
              <div className="composer-box">
                <textarea
                  id="draft"
                  data-testid="composer-draft"
                  value={draft}
                  placeholder={projectId || !projectsAvailable ? 'Ask Atlas…' : 'Create or open a project first.'}
                  disabled={(projectsAvailable && !projectId) || busy}
                  rows={3}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <div className="composer-actions">
                  {busy ? (
                    <button type="button" className="ghost" data-testid="composer-stop" onClick={() => void onStop()}>
                      Stop
                    </button>
                  ) : (
                    <button className="send" type="submit" data-testid="composer-send" disabled={!draft.trim() || (projectsAvailable && !projectId)}>
                      Send
                    </button>
                  )}
                </div>
              </div>
              <button type="button" className="ghost compact advanced-toggle" onClick={() => setAdvancedOpen((open) => !open)}>
                {advancedOpen ? 'Hide options' : 'More options'}
              </button>
              {advancedOpen ? (
                <label className="advanced">
                  Response speed
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
                </label>
              ) : null}
            </form>
          </main>
        )}
        {diagnosticsOpen ? (
          <DiagnosticsDrawer
            execution={latestExecution}
            tools={inspection?.tools ?? tools}
            onClose={() => setDiagnosticsOpen(false)}
          />
        ) : null}
      </div>
      {paletteOpen ? (
        <div className="palette-scrim" role="presentation" onClick={() => setPaletteOpen(false)}>
          <div className="palette" role="dialog" aria-modal="true" aria-label="Search" onClick={(event) => event.stopPropagation()}>
            <label htmlFor="palette-query">Search</label>
            <input
              id="palette-query"
              autoFocus
              value={paletteQuery}
              onChange={(event) => setPaletteQuery(event.target.value)}
              placeholder="Conversation, project, or tool"
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
          </div>
        </div>
      ) : null}
      <button type="button" className="sr-only" onClick={() => void refreshAll()}>
        Reload
      </button>
    </div>
  );
}

function SurfaceBack({ onBack, label }: { onBack: () => void; label: string }) {
  return (
    <div className="surface-back">
      <button type="button" className="ghost compact" data-testid="back-to-conversation" onClick={onBack}>
        Back to conversation
      </button>
      <span>{label}</span>
    </div>
  );
}

function FilesSurface({
  files,
  fileDraft,
  setFileDraft,
  onUpload,
  onAttach,
  canAttach,
  projectReady,
  onBack,
}: {
  files: ProjectFile[];
  fileDraft: { path: string; text: string };
  setFileDraft: (value: { path: string; text: string } | ((current: { path: string; text: string }) => { path: string; text: string })) => void;
  onUpload: (event: FormEvent) => void;
  onAttach: (fileId: string) => void;
  canAttach: boolean;
  projectReady: boolean;
  onBack: () => void;
}) {
  return (
    <main className="workspace" aria-label="Files">
      <SurfaceBack onBack={onBack} label="Files" />
      <section className="estate-body">
        <h1>Files</h1>
        <p className="hint">Project files Atlas can use. Upload stays on the server.</p>
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
            rows={6}
          />
          <button type="submit" className="primary" data-testid="upload-file" disabled={!projectReady || !fileDraft.text.trim()}>
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
                    {file.path} · {file.status}
                  </span>
                </div>
                <button type="button" className="ghost compact" onClick={() => void onAttach(file.id)} disabled={!canAttach}>
                  Use in conversation
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function ContextSurface({
  context,
  citations,
  onBack,
}: {
  context: AssembledContext | null;
  citations: ReturnType<typeof citationsFromBackend>;
  onBack: () => void;
}) {
  return (
    <main className="workspace" aria-label="Context">
      <SurfaceBack onBack={onBack} label="Context" />
      <section className="estate-body">
        <h1>What Atlas can use</h1>
        <p className="hint">Material from this project’s files. Atlas does not invent sources.</p>
        {citations.length === 0 && !context?.slices.length ? (
          <p className="muted">Nothing retrieved yet. Add files, then ask a question.</p>
        ) : (
          <ul className="plain">
            {context?.slices.map((slice) => (
              <li key={slice.chunkId}>
                <strong>{slice.path}</strong>
                <p>{slice.text}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function DiagnosticsDrawer({
  execution,
  tools,
  onClose,
}: {
  execution?: ExecutionRecord | null;
  tools: ToolPresentation[];
  onClose: () => void;
}) {
  return (
    <aside className="diagnostics" aria-label="Run details">
      <div className="row">
        <h2>Run details</h2>
        <button type="button" className="ghost compact" data-testid="diagnostics-close" onClick={onClose}>
          Close
        </button>
      </div>
      {!execution ? (
        <p className="muted">No run yet. Provider and model appear here after Atlas answers.</p>
      ) : (
        <dl className="facts">
          <div>
            <dt>Status</dt>
            <dd>{runStatusLabel(execution.status, false)}</dd>
          </div>
          <div>
            <dt>Provider / model</dt>
            <dd>
              {execution.selectedProvider ?? '—'} / {execution.selectedModel ?? '—'}
            </dd>
          </div>
          <div>
            <dt>Route</dt>
            <dd>{execution.route?.decisionReason ?? 'pending'}</dd>
          </div>
          <div>
            <dt>Run id</dt>
            <dd>{execution.id}</dd>
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
      )}
      {execution?.attempts?.length ? (
        <>
          <h3>Attempts</h3>
          <ul className="plain">
            {execution.attempts.map((attempt) => (
              <li key={`${attempt.index}-${attempt.provider}`}>
                {attempt.provider}/{attempt.model} · {attempt.outcome}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h3>Tools</h3>
      {tools.length === 0 ? <p className="muted">None.</p> : <p className="meta">{tools.map((item) => `${item.title}: ${item.status}`).join(' · ')}</p>}
    </aside>
  );
}

function ApprovalCard({
  tool,
  onDecide,
}: {
  tool: ToolPresentation;
  onDecide: (id: string, decision: 'approve' | 'deny') => Promise<void>;
}) {
  const desc = `${tool.title} ${tool.toolId} ${tool.argumentSummary} risk ${tool.risk}`;
  return (
    <section className="approval" aria-label={`Approval required for ${tool.toolId}`}>
      <h3>Approval required</h3>
      <p>
        <strong>{tool.title}</strong> wants to run <code>{tool.toolId}</code> on {tool.resource ?? 'this project'}.
      </p>
      <p className="meta">{tool.argumentSummary}</p>
      <p className="meta">{approvalAuthorityLine(tool)}</p>
      <p className="muted">Buttons do not grant permission. The host checks the session principal and Authority.</p>
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

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
