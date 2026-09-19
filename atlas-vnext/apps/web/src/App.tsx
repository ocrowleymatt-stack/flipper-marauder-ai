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
  listOsintFindings,
  listOsintTargets,
  listProjectConversations,
  listProjects,
  listResearch,
  runtimeWaitingLabel,
  sendMessage,
  uploadTextFile,
  isProjectsUnavailable,
  revokeSession,
  type AssembledContext,
  type Capability,
  type Conversation,
  type DoctorReport,
  type DungeonRecord,
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
  classifyAssistantResult,
  findingsFromRecords,
  mergeFindings,
  stripPrimaryHashes,
  type ParsedFinding,
  type ParsedResult,
} from './results';
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
  | 'operations'
  | 'settings';

type PanelMode = 'closed' | 'run-details' | 'finding' | 'file' | 'sources' | 'project';

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
  const [status, setStatus] = useState('Loading Atlas.');
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
  const [panelMode, setPanelMode] = useState<PanelMode>('closed');
  const [selectedFinding, setSelectedFinding] = useState<ParsedFinding | null>(null);
  const [selectedFile, setSelectedFile] = useState<ProjectFile | null>(null);
  const [selectedResult, setSelectedResult] = useState<ParsedResult | null>(null);
  const [osintFindings, setOsintFindings] = useState<DungeonRecord[]>([]);
  const [researchBriefs, setResearchBriefs] = useState<DungeonRecord[]>([]);
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
  const panelOpen = panelMode !== 'closed' || diagnosticsOpen;
  const durableFindings = useMemo(() => findingsFromRecords(osintFindings), [osintFindings]);

  const loadProjects = useCallback(async () => {
    const items = await listProjects();
    setProjects(items);
    return items;
  }, []);

  const loadConversation = useCallback(async (conversationId: string) => {
    const nextSnapshot = await getSnapshot(conversationId);
    setView(viewFromSnapshot(nextSnapshot));
    const projectForConversation = nextSnapshot.conversation.projectId;
    const [conversationTools, assembled, pending, targets, briefs] = await Promise.all([
      listConversationTools(conversationId).catch(() => []),
      projectForConversation
        ? getProjectContext(projectForConversation, nextSnapshot.conversation.title, conversationId).catch(() => null)
        : Promise.resolve(null),
      listApprovals().catch(() => []),
      projectForConversation ? listOsintTargets(projectForConversation).catch(() => []) : Promise.resolve([]),
      projectForConversation ? listResearch(projectForConversation).catch(() => []) : Promise.resolve([]),
    ]);
    setTools(conversationTools);
    setContext(assembled);
    setApprovals(pending);
    const mine = targets.filter((row) => row.conversationId === conversationId);
    const findingsNested = await Promise.all(mine.map((target) => listOsintFindings(target.id).catch(() => [])));
    setOsintFindings(findingsNested.flat());
    setResearchBriefs(briefs.filter((row) => row.conversationId === conversationId));
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
        setOsintFindings([]);
        setResearchBriefs([]);
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
        setStatus('Atlas failed to load.');
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
        closePanel();
        setNavOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function closePanel() {
    setDiagnosticsOpen(false);
    setPanelMode('closed');
    setSelectedFinding(null);
    setSelectedFile(null);
    setSelectedResult(null);
  }

  function openRunDetails() {
    setSelectedFinding(null);
    setSelectedFile(null);
    setSelectedResult(null);
    setPanelMode('run-details');
    setDiagnosticsOpen(true);
    playCue('activate');
  }

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
      setOsintFindings([]);
      setResearchBriefs([]);
      closePanel();
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

  function openFinding(finding: ParsedFinding, result?: ParsedResult | null) {
    setSelectedFinding(finding);
    setSelectedResult(result ?? null);
    setSelectedFile(null);
    setDiagnosticsOpen(false);
    setPanelMode('finding');
    setSurface('conversation');
    playCue('activate');
  }

  function openSources(result: ParsedResult) {
    setSelectedResult(result);
    setSelectedFinding(null);
    setSelectedFile(null);
    setDiagnosticsOpen(false);
    setPanelMode('sources');
    setSurface('conversation');
    playCue('activate');
  }

  function openFileDetails(file: ProjectFile) {
    setSelectedFile(file);
    setSelectedFinding(null);
    setSelectedResult(null);
    setDiagnosticsOpen(false);
    setPanelMode('file');
    playCue('activate');
  }

  async function onSignOut() {
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
      { id: 'files', label: 'Library' },
      { id: 'writing', label: 'Caspa' },
      { id: 'settings', label: 'Settings' },
      ...dungeons
        .filter((item) => item.featureAvailable && item.id !== 'writing')
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
            setStatus('Atlas failed to load.');
          } finally {
            setLoading(false);
          }
        }}
      />
    );
  }

  const threadTitle = conversationDisplayTitle(snapshot?.conversation.title, currentProject?.name ?? 'Conversation');
  const showRunDetails = diagnosticsOpen || panelMode === 'run-details';

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
          <button
            type="button"
            className="ghost"
            data-testid="diagnostics-toggle"
            aria-pressed={showRunDetails}
            onClick={() => {
              if (showRunDetails) closePanel();
              else openRunDetails();
            }}
          >
            {showRunDetails ? 'Close details' : 'Run details'}
          </button>
          <button type="button" className="ghost" onClick={() => void onSignOut()}>
            Sign out
          </button>
        </div>
      </header>
      <div className={`layout ${navOpen ? 'nav-open' : ''} ${panelOpen ? 'diagnostics-open' : ''}`}>
        <nav className="nav" aria-label="Atlas">
          <button type="button" className="primary new-conversation" data-testid="new-conversation" onClick={() => void onCreateConversation()} disabled={projectsAvailable && !projectId}>
            New Chat
          </button>
          <div className="nav-section" data-testid="nav-chats">
            <div className="row">
              <h2>Chats</h2>
            </div>
            <label className="sr-only" htmlFor="conversation-search">
              Search chats
            </label>
            <input
              id="conversation-search"
              value={conversationQuery}
              onChange={(event) => setConversationQuery(event.target.value)}
              placeholder="Search"
            />
            {filteredConversations.length === 0 ? (
              <p className="muted">No chats yet.</p>
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
          <div className="nav-section" data-testid="nav-projects">
            <h2>Projects</h2>
            {projects.length === 0 ? (
              <p className="muted">A project is a named workspace for chats, files, and results.</p>
            ) : (
              <ul className="plain project-list">
                {projects.map((project) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      className={project.id === projectId ? 'active' : ''}
                      onClick={() => void onSelectProject(project.id)}
                      aria-current={project.id === projectId ? 'page' : undefined}
                    >
                      <span className="conv-title">{project.name}</span>
                      <span className="conv-meta">Workspace</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
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
          </div>
          <div className="nav-section" data-testid="nav-library">
            <h2>Library</h2>
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
            </ul>
          </div>
          <div className="nav-section" data-testid="nav-dungeons">
            <h2>Skills</h2>
            <ul className="plain">
              <li>
                <button type="button" className={surface === 'writing' ? 'active' : ''} data-testid="surface-writing" onClick={() => openSurface('writing')} disabled={!projectId}>
                  Caspa
                </button>
              </li>
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
            </ul>
          </div>
          <div className="nav-section nav-end" data-testid="nav-settings">
            <h2>Account</h2>
            <ul className="plain">
              <li>
                <button type="button" className={surface === 'settings' ? 'active' : ''} data-testid="surface-settings" onClick={() => openSurface('settings')}>
                  Settings
                </button>
              </li>
              <li>
                <button
                  type="button"
                  data-testid="surface-advanced"
                  className={showRunDetails ? 'active' : ''}
                  onClick={() => {
                    goToConversation();
                    openRunDetails();
                  }}
                >
                  Advanced
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
            projectName={currentProject?.name ?? 'This project'}
            conversationTitle={threadTitle}
            onOpenFile={openFileDetails}
            onBack={goToConversation}
          />
        ) : surface === 'context' ? (
          <ContextSurface context={context} citations={citations} onBack={goToConversation} />
        ) : surface === 'operations' ? (
          <section className="workspace-wrap">
            <SurfaceBack onBack={() => openSurface('settings')} label="Help & Repair" />
            <EstatePanel dungeonId="operations" projectId={projectId} files={files} busy={busy} setBusy={setBusy} onStatus={setStatus} onError={setError} />
          </section>
        ) : surface === 'settings' ? (
          <SettingsSurface
            session={session}
            doctorView={doctorView}
            doctor={doctor}
            onHelp={() => openSurface('operations')}
            onAdvanced={() => {
              goToConversation();
              openRunDetails();
            }}
            onSignOut={() => void onSignOut()}
            onBack={goToConversation}
          />
        ) : surface !== 'conversation' ? (
          <section className="workspace-wrap">
            <SurfaceBack onBack={goToConversation} label={dungeons.find((item) => item.id === surface)?.navLabel.replace(/Studio/i, '').trim() ?? 'Skill'} />
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
                <div className="empty" data-testid="empty-conversation">
                  <p className="eyebrow">Atlas</p>
                  <h2>Ask Atlas</h2>
                  <p>Talk here. Research, OSINT, files, and later specialist work return to this conversation.</p>
                </div>
              ) : (
                snapshot.messages.map((message) => {
                  const parsed = message.role === 'assistant' && message.content ? classifyAssistantResult(message.content) : null;
                  const card =
                    parsed?.kind === 'osint'
                      ? { ...parsed, findings: mergeFindings(parsed.findings, durableFindings) }
                      : parsed;
                  return (
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
                            <MarkdownBody text={stripPrimaryHashes(message.content)} />
                          ) : busy ? (
                            'Generating…'
                          ) : (
                            ''
                          )
                        ) : (
                          message.content
                        )}
                      </div>
                      {card ? (
                        <ResultCard
                          result={card}
                          onOpenFinding={(finding) => openFinding(finding, card)}
                          onOpenSources={() => openSources(card)}
                        />
                      ) : null}
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
        {panelOpen ? (
          showRunDetails ? (
            <DiagnosticsDrawer execution={latestExecution} tools={inspection?.tools ?? tools} onClose={closePanel} />
          ) : (
            <ContextPanel
              mode={panelMode}
              finding={selectedFinding}
              file={selectedFile}
              result={selectedResult}
              project={currentProject}
              conversationTitle={threadTitle}
              researchBriefs={researchBriefs}
              onClose={closePanel}
              onBackToChat={() => {
                closePanel();
                goToConversation();
              }}
            />
          )
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
              placeholder="Conversation, project, or skill"
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

function ResultCard({
  result,
  onOpenFinding,
  onOpenSources,
}: {
  result: ParsedResult;
  onOpenFinding: (finding: ParsedFinding) => void;
  onOpenSources: () => void;
}) {
  return (
    <section className="result-card" data-testid={`result-card-${result.kind}`} aria-label={`${result.kind} result`}>
      <div className="result-card-head">
        <p className="eyebrow">{result.kind === 'osint' ? 'OSINT' : 'Research'}</p>
        <p className="meta">{result.state}</p>
      </div>
      {result.strongest ? <p className="result-strongest">{result.strongest}</p> : null}
      {result.findings.length > 0 ? (
        <ul className="plain result-findings">
          {result.findings.slice(0, 6).map((finding) => (
            <li key={finding.id}>
              <button type="button" className="finding-open" data-testid="open-finding" onClick={() => onOpenFinding(finding)}>
                <strong>{finding.source ?? finding.title}</strong>
                <span className="meta">{finding.status ?? finding.confidence ?? 'observed'}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="row result-actions">
        {result.sources.length > 0 ? (
          <button type="button" className="ghost compact" data-testid="open-sources" onClick={onOpenSources}>
            Sources
          </button>
        ) : null}
      </div>
    </section>
  );
}

function fileOrigin(file: ProjectFile): string {
  if (file.path === 'acquisition' || file.path.startsWith('acquisition/')) return 'Acquired';
  if (/^(generated|osint|research|caspa|website|music)\//i.test(file.path)) return 'Generated';
  return 'Uploaded';
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
  projectName,
  conversationTitle,
  onOpenFile,
  onBack,
}: {
  files: ProjectFile[];
  fileDraft: { path: string; text: string };
  setFileDraft: (value: { path: string; text: string } | ((current: { path: string; text: string }) => { path: string; text: string })) => void;
  onUpload: (event: FormEvent) => void;
  onAttach: (fileId: string) => void;
  canAttach: boolean;
  projectReady: boolean;
  projectName: string;
  conversationTitle: string;
  onOpenFile: (file: ProjectFile) => void;
  onBack: () => void;
}) {
  return (
    <main className="workspace" aria-label="Library">
      <SurfaceBack onBack={onBack} label="Library" />
      <section className="estate-body">
        <h1>Library</h1>
        <p className="hint">Files in {projectName}. Open one to see where it came from. Atlas does not show storage keys as the name of the file.</p>
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
                    {fileOrigin(file)} · {projectName}
                    {canAttach ? ` · ${conversationTitle}` : ''}
                  </span>
                </div>
                <div className="row">
                  <button type="button" className="ghost compact" data-testid="open-file" onClick={() => onOpenFile(file)}>
                    Open
                  </button>
                  <button type="button" className="ghost compact" onClick={() => void onAttach(file.id)} disabled={!canAttach}>
                    Use in conversation
                  </button>
                </div>
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

function SettingsSurface({
  session,
  doctorView,
  doctor,
  onHelp,
  onAdvanced,
  onSignOut,
  onBack,
}: {
  session: SessionState;
  doctorView: { tone: string; label: string } | null;
  doctor: DoctorReport | null;
  onHelp: () => void;
  onAdvanced: () => void;
  onSignOut: () => void;
  onBack: () => void;
}) {
  return (
    <main className="workspace" aria-label="Settings" data-testid="settings-surface">
      <SurfaceBack onBack={onBack} label="Settings" />
      <section className="estate-body">
        <h1>Settings</h1>
        <p className="hint">Account and operator tools. Routing, jobs, and infrastructure stay out of ordinary chat.</p>
        <dl className="facts">
          <div>
            <dt>Signed in</dt>
            <dd>{session.principal?.kind ?? 'session'}</dd>
          </div>
        </dl>
        {doctorView ? (
          <p className={`doctor-chip ${doctorView.tone}`} data-testid="doctor-chip">
            <span className="doctor-dot" aria-hidden="true" />
            {doctorView.label}
            {doctor?.state === 'ATTENTION_REQUIRED' ? ' — optional services, Atlas can still work.' : null}
          </p>
        ) : null}
        <div className="stack">
          <button type="button" className="ghost" data-testid="open-help-repair" onClick={onHelp}>
            Help & Repair
          </button>
          <button type="button" className="ghost" onClick={onAdvanced}>
            Workbench / Run details
          </button>
          <button type="button" className="ghost" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </section>
    </main>
  );
}

function ContextPanel({
  mode,
  finding,
  file,
  result,
  project,
  conversationTitle,
  researchBriefs,
  onClose,
  onBackToChat,
}: {
  mode: PanelMode;
  finding: ParsedFinding | null;
  file: ProjectFile | null;
  result: ParsedResult | null;
  project: Project | null;
  conversationTitle: string;
  researchBriefs: DungeonRecord[];
  onClose: () => void;
  onBackToChat: () => void;
}) {
  const title = mode === 'file' ? 'File' : mode === 'sources' ? 'Sources' : mode === 'project' ? 'Project' : 'Finding';
  return (
    <aside className="diagnostics context-panel" aria-label={title} data-testid="context-panel">
      <div className="row">
        <h2>{title}</h2>
        <button type="button" className="ghost compact" data-testid="context-close" onClick={onClose}>
          Close
        </button>
      </div>
      {mode === 'finding' && finding ? (
        <dl className="facts" data-testid="finding-details">
          <div>
            <dt>Summary</dt>
            <dd>{finding.summary}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{finding.status ?? finding.confidence ?? 'observed'}</dd>
          </div>
          <div>
            <dt>Kind</dt>
            <dd>{finding.epistemicKind ?? 'observation'}</dd>
          </div>
          {finding.url ? (
            <div>
              <dt>Source</dt>
              <dd>
                <a href={finding.url} target="_blank" rel="noreferrer">
                  {finding.url}
                </a>
              </dd>
            </div>
          ) : null}
          {finding.evidenceHash ? (
            <div>
              <dt>Evidence</dt>
              <dd className="meta">Stored with provenance. Key is not the name of this finding.</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {mode === 'sources' && result ? (
        <ul className="plain" data-testid="source-list">
          {result.sources.map((source) => (
            <li key={`${source.title}-${source.url ?? ''}`}>
              <strong>{source.title}</strong>
              {source.url ? <p className="meta">{source.url}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {mode === 'file' && file ? (
        <dl className="facts" data-testid="file-details">
          <div>
            <dt>Name</dt>
            <dd>{file.displayName}</dd>
          </div>
          <div>
            <dt>Origin</dt>
            <dd>{fileOrigin(file)}</dd>
          </div>
          <div>
            <dt>Project</dt>
            <dd>{project?.name ?? 'This project'}</dd>
          </div>
          <div>
            <dt>Conversation</dt>
            <dd>{conversationTitle}</dd>
          </div>
          <div>
            <dt>Provenance</dt>
            <dd className="meta">Available to this project. Storage keys stay in Advanced details.</dd>
          </div>
        </dl>
      ) : null}
      {researchBriefs.length > 0 && mode === 'sources' ? (
        <p className="muted">{researchBriefs.length} stored research brief{researchBriefs.length === 1 ? '' : 's'} in this chat.</p>
      ) : null}
      <button type="button" className="ghost compact" data-testid="panel-back-to-chat" onClick={onBackToChat}>
        Back to chat
      </button>
    </aside>
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
      <p className="hint">Advanced / Workbench. Provider routing stays here, not in the conversation.</p>
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
