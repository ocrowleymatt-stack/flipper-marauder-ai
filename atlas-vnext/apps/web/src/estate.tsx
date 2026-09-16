import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  challengeCase,
  composeMusic,
  createCase,
  createComposition,
  createResearch,
  createSite,
  decidePrivacyProposal,
  explainPolicy,
  generateSite,
  getEffectivePolicy,
  listCases,
  listCompositions,
  listOsintTargets,
  listPrivacyAudit,
  listPrivacyProposals,
  listResearch,
  listSites,
  promoteSite,
  runResearch,
  scanOsint,
  updatePolicy,
  type DungeonRecord,
  type EffectivePolicyView,
  type PolicyExplanation,
  type ProjectFile,
} from './api';
import { playCue } from './experience';

export function EstatePanel({
  dungeonId,
  projectId,
  files,
  busy,
  setBusy,
  onStatus,
  onError,
}: {
  dungeonId: string;
  projectId: string | null;
  files: ProjectFile[];
  busy: boolean;
  setBusy: (value: boolean) => void;
  onStatus: (value: string) => void;
  onError: (value: string | null) => void;
}) {
  if (dungeonId === 'privacy') {
    return <PrivacyPanel busy={busy} setBusy={setBusy} onStatus={onStatus} onError={onError} />;
  }
  if (!projectId) {
    return (
      <main className="workspace" aria-label="Dungeon">
        <div className="empty">
          <h3>Open a project</h3>
          <p>This dungeon stores its work in a project. Authority still decides access on the server.</p>
        </div>
      </main>
    );
  }
  if (dungeonId === 'osint') return <OsintPanel projectId={projectId} busy={busy} setBusy={setBusy} onStatus={onStatus} onError={onError} />;
  if (dungeonId === 'investigation') {
    return <InvestigationPanel projectId={projectId} busy={busy} setBusy={setBusy} onStatus={onStatus} onError={onError} />;
  }
  if (dungeonId === 'research') {
    return <ResearchPanel projectId={projectId} files={files} busy={busy} setBusy={setBusy} onStatus={onStatus} onError={onError} />;
  }
  if (dungeonId === 'website') {
    return <WebsitePanel projectId={projectId} busy={busy} setBusy={setBusy} onStatus={onStatus} onError={onError} />;
  }
  if (dungeonId === 'music') return <MusicPanel projectId={projectId} busy={busy} setBusy={setBusy} onStatus={onStatus} onError={onError} />;
  return (
    <main className="workspace" aria-label="Dungeon">
      <div className="empty">
        <h3>Unknown dungeon</h3>
        <p>The host catalogue did not provide a surface for this id.</p>
      </div>
    </main>
  );
}

function OsintPanel({
  projectId,
  busy,
  setBusy,
  onStatus,
  onError,
}: {
  projectId: string;
  busy: boolean;
  setBusy: (value: boolean) => void;
  onStatus: (value: string) => void;
  onError: (value: string | null) => void;
}) {
  const [kind, setKind] = useState('username');
  const [value, setValue] = useState('');
  const [targets, setTargets] = useState<DungeonRecord[]>([]);
  const [latest, setLatest] = useState<{ findings: DungeonRecord[]; dossier?: DungeonRecord } | null>(null);

  const reload = useCallback(async () => {
    setTargets(await listOsintTargets(projectId));
  }, [projectId]);

  useEffect(() => {
    void reload().catch((err) => onError(err instanceof Error ? err.message : String(err)));
  }, [reload, onError]);

  async function onScan(event: FormEvent) {
    event.preventDefault();
    if (!value.trim() || busy) return;
    setBusy(true);
    onError(null);
    try {
      playCue('tool');
      const result = await scanOsint(projectId, kind, value.trim());
      setLatest({ findings: result.findings, dossier: result.dossier });
      await reload();
      playCue('complete');
      onStatus('OSINT scan stored as findings. Synthesis used Nexus, not a private provider.');
    } catch (err) {
      playCue('warn');
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="workspace estate" aria-label="OSINT">
      <header className="thread-header">
        <div>
          <h2>OSINT</h2>
          <p className="hint">Public lookup is host-injected. Jobs, CAS, Nexus, and Authority stay on the platform.</p>
        </div>
      </header>
      <section className="estate-body">
        <form className="stack" onSubmit={(event) => void onScan(event)}>
          <label htmlFor="osint-kind">Target kind</label>
          <select id="osint-kind" value={kind} onChange={(event) => setKind(event.target.value)} disabled={busy}>
            {['username', 'email', 'domain', 'person', 'organisation', 'ip'].map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <label htmlFor="osint-value">Value</label>
          <input id="osint-value" value={value} onChange={(event) => setValue(event.target.value)} disabled={busy} />
          <button type="submit" className="primary" disabled={busy || !value.trim()}>
            {busy ? 'Scanning' : 'Scan'}
          </button>
        </form>
        <RecordList title="Targets" items={targets} />
        {latest ? (
          <RecordList title="Latest findings" items={latest.findings} />
        ) : null}
        {latest?.dossier ? <p className="muted">Dossier artefact {latest.dossier.artefactId}</p> : null}
      </section>
    </main>
  );
}

function InvestigationPanel({
  projectId,
  busy,
  setBusy,
  onStatus,
  onError,
}: {
  projectId: string;
  busy: boolean;
  setBusy: (value: boolean) => void;
  onStatus: (value: string) => void;
  onError: (value: string | null) => void;
}) {
  const [title, setTitle] = useState('');
  const [question, setQuestion] = useState('');
  const [findingIds, setFindingIds] = useState('');
  const [cases, setCases] = useState<DungeonRecord[]>([]);
  const [active, setActive] = useState<DungeonRecord | null>(null);

  const reload = useCallback(async () => {
    setCases(await listCases(projectId));
  }, [projectId]);

  useEffect(() => {
    void reload().catch((err) => onError(err instanceof Error ? err.message : String(err)));
  }, [reload, onError]);

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    try {
      const created = await createCase(projectId, {
        title: title.trim() || 'Untitled case',
        question: question.trim(),
        findingIds: findingIds.split(',').map((item) => item.trim()).filter(Boolean),
      });
      setTitle('');
      setQuestion('');
      await reload();
      setActive(created);
      onStatus('Case stored. Investigation consumes OSINT findings by id.');
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onChallenge(stance: 'advocate' | 'challenger' | 'arbiter') {
    if (!active || busy) return;
    setBusy(true);
    try {
      playCue('tool');
      await challengeCase(active.id, stance);
      playCue('complete');
      onStatus(`${stance} challenge stored with provenance.`);
    } catch (err) {
      playCue('warn');
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="workspace estate" aria-label="Investigation">
      <header className="thread-header">
        <div>
          <h2>Investigation</h2>
          <p className="hint">Caseboards and challenge loops. Evidence arrives as OSINT finding ids, not package imports.</p>
        </div>
      </header>
      <section className="estate-body">
        <form className="stack" onSubmit={(event) => void onCreate(event)}>
          <label htmlFor="case-title">Case title</label>
          <input id="case-title" value={title} onChange={(event) => setTitle(event.target.value)} />
          <label htmlFor="case-question">Question</label>
          <textarea id="case-question" value={question} onChange={(event) => setQuestion(event.target.value)} rows={3} />
          <label htmlFor="case-findings">Finding ids</label>
          <input id="case-findings" value={findingIds} onChange={(event) => setFindingIds(event.target.value)} placeholder="comma separated" />
          <button type="submit" className="primary" disabled={!question.trim()}>
            Open case
          </button>
        </form>
        <RecordList title="Cases" items={cases} onOpen={setActive} activeId={active?.id} />
        {active ? (
          <div className="row">
            <button type="button" className="ghost" disabled={busy} onClick={() => void onChallenge('advocate')}>
              Advocate
            </button>
            <button type="button" className="primary" disabled={busy} onClick={() => void onChallenge('challenger')}>
              Challenge
            </button>
            <button type="button" className="ghost" disabled={busy} onClick={() => void onChallenge('arbiter')}>
              Arbiter
            </button>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function ResearchPanel({
  projectId,
  files,
  busy,
  setBusy,
  onStatus,
  onError,
}: {
  projectId: string;
  files: ProjectFile[];
  busy: boolean;
  setBusy: (value: boolean) => void;
  onStatus: (value: string) => void;
  onError: (value: string | null) => void;
}) {
  const [question, setQuestion] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [briefs, setBriefs] = useState<DungeonRecord[]>([]);

  const reload = useCallback(async () => {
    setBriefs(await listResearch(projectId));
  }, [projectId]);

  useEffect(() => {
    void reload().catch((err) => onError(err instanceof Error ? err.message : String(err)));
  }, [reload, onError]);

  async function onRun(event: FormEvent) {
    event.preventDefault();
    if (!question.trim() || busy) return;
    setBusy(true);
    try {
      playCue('tool');
      const brief = await createResearch(projectId, question.trim(), selected);
      await runResearch(brief.id);
      await reload();
      playCue('complete');
      onStatus('Research synthesis stored with backend citations.');
    } catch (err) {
      playCue('warn');
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="workspace estate" aria-label="Research">
      <header className="thread-header">
        <div>
          <h2>Research</h2>
          <p className="hint">Retrieval is platform ContextService. This dungeon does not own a search stack.</p>
        </div>
      </header>
      <section className="estate-body">
        <form className="stack" onSubmit={(event) => void onRun(event)}>
          <label htmlFor="research-q">Question</label>
          <textarea id="research-q" value={question} onChange={(event) => setQuestion(event.target.value)} rows={3} />
          <fieldset className="stack">
            <legend>Optional file restriction</legend>
            {files.length === 0 ? <p className="muted">No files. Empty selection retrieves from the project.</p> : null}
            {files.map((file) => (
              <label key={file.id} className="file-check">
                <input
                  type="checkbox"
                  checked={selected.includes(file.id)}
                  onChange={(event) => {
                    setSelected((current) => (event.target.checked ? [...current, file.id] : current.filter((id) => id !== file.id)));
                  }}
                />
                {file.displayName}
              </label>
            ))}
          </fieldset>
          <button type="submit" className="primary" disabled={busy || !question.trim()}>
            {busy ? 'Retrieving' : 'Run research'}
          </button>
        </form>
        <RecordList title="Briefs" items={briefs} />
      </section>
    </main>
  );
}

function WebsitePanel({
  projectId,
  busy,
  setBusy,
  onStatus,
  onError,
}: {
  projectId: string;
  busy: boolean;
  setBusy: (value: boolean) => void;
  onStatus: (value: string) => void;
  onError: (value: string | null) => void;
}) {
  const [name, setName] = useState('Site');
  const [brief, setBrief] = useState('');
  const [sites, setSites] = useState<Array<{ id: string; name: string; currentRevisionId: string | null }>>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const items = await listSites(projectId);
    setSites(items);
    return items;
  }, [projectId]);

  useEffect(() => {
    void reload().catch((err) => onError(err instanceof Error ? err.message : String(err)));
  }, [reload, onError]);

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    try {
      const site = await createSite(projectId, name.trim() || 'Site', brief);
      setActiveId(site.id);
      await reload();
      onStatus('Canonical site created. Preview is not production.');
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onGenerate() {
    if (!activeId || !brief.trim() || busy) return;
    setBusy(true);
    try {
      playCue('tool');
      await generateSite(activeId, brief.trim());
      await reload();
      playCue('complete');
      onStatus('Preview revision stored in CAS.');
    } catch (err) {
      playCue('warn');
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onPromote() {
    if (!activeId || busy) return;
    setBusy(true);
    try {
      playCue('approval');
      await promoteSite(activeId);
      playCue('complete');
      onStatus('Promote requested. Authority checked deployment.promote on the server.');
    } catch (err) {
      playCue('warn');
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="workspace estate" aria-label="Website Studio">
      <header className="thread-header">
        <div>
          <h2>Website Studio</h2>
          <p className="hint">One canonical site per project. Preview is ephemeral. Promote is Authority-gated.</p>
        </div>
      </header>
      <section className="estate-body">
        <form className="stack" onSubmit={(event) => void onCreate(event)}>
          <label htmlFor="site-name">Name</label>
          <input id="site-name" value={name} onChange={(event) => setName(event.target.value)} />
          <label htmlFor="site-brief">Brief</label>
          <textarea id="site-brief" value={brief} onChange={(event) => setBrief(event.target.value)} rows={4} />
          <button type="submit" className="primary">
            Create site
          </button>
        </form>
        <ul className="plain">
          {sites.map((site) => (
            <li key={site.id}>
              <button type="button" className={site.id === activeId ? 'active' : ''} onClick={() => setActiveId(site.id)}>
                <span>{site.name}</span>
                <span className="meta">{site.currentRevisionId ? 'has preview' : 'empty'}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="row">
          <button type="button" className="primary" disabled={!activeId || busy} onClick={() => void onGenerate()}>
            Generate preview
          </button>
          <button type="button" className="ghost" disabled={!activeId || busy} onClick={() => void onPromote()}>
            Promote
          </button>
        </div>
        {activeId ? (
          <iframe className="site-preview" title="Site preview" src={`/api/sites/${encodeURIComponent(activeId)}/preview`} />
        ) : null}
      </section>
    </main>
  );
}

function MusicPanel({
  projectId,
  busy,
  setBusy,
  onStatus,
  onError,
}: {
  projectId: string;
  busy: boolean;
  setBusy: (value: boolean) => void;
  onStatus: (value: string) => void;
  onError: (value: string | null) => void;
}) {
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [items, setItems] = useState<DungeonRecord[]>([]);

  const reload = useCallback(async () => {
    setItems(await listCompositions(projectId));
  }, [projectId]);

  useEffect(() => {
    void reload().catch((err) => onError(err instanceof Error ? err.message : String(err)));
  }, [reload, onError]);

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    if (!brief.trim() || busy) return;
    setBusy(true);
    try {
      playCue('tool');
      const created = await createComposition(projectId, title.trim() || 'Untitled composition', brief.trim());
      await composeMusic(created.id);
      await reload();
      playCue('complete');
      onStatus('Composition packet stored. GPU runtimes stay in Execution.');
    } catch (err) {
      playCue('warn');
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="workspace estate" aria-label="Music">
      <header className="thread-header">
        <div>
          <h2>Music</h2>
          <p className="hint">Structure and lyrics through Nexus. This surface does not lease GPUs.</p>
        </div>
      </header>
      <section className="estate-body">
        <form className="stack" onSubmit={(event) => void onCreate(event)}>
          <label htmlFor="music-title">Title</label>
          <input id="music-title" value={title} onChange={(event) => setTitle(event.target.value)} />
          <label htmlFor="music-brief">Brief</label>
          <textarea id="music-brief" value={brief} onChange={(event) => setBrief(event.target.value)} rows={4} />
          <button type="submit" className="primary" disabled={busy || !brief.trim()}>
            {busy ? 'Composing' : 'Compose'}
          </button>
        </form>
        <RecordList title="Compositions" items={items} />
      </section>
    </main>
  );
}

function PrivacyPanel({
  busy,
  setBusy,
  onStatus,
  onError,
}: {
  busy: boolean;
  setBusy: (value: boolean) => void;
  onStatus: (value: string) => void;
  onError: (value: string | null) => void;
}) {
  const [view, setView] = useState<EffectivePolicyView | null>(null);
  const [explanation, setExplanation] = useState<PolicyExplanation | null>(null);
  const [confirm, setConfirm] = useState('');
  const [network, setNetwork] = useState('public');
  const [audit, setAudit] = useState<Array<{ id: string; action: string; reasonCode: string; stepUp: boolean; at: string }>>([]);
  const [proposals, setProposals] = useState<Array<{ id: string; status: string; patch: Record<string, unknown> }>>([]);

  const reload = useCallback(async () => {
    const next = await getEffectivePolicy();
    setView(next);
    setNetwork(next.policy.networkAccess);
    setAudit(await listPrivacyAudit().catch(() => []));
    setProposals(await listPrivacyProposals().catch(() => []));
  }, []);

  useEffect(() => {
    void reload().catch((err) => onError(err instanceof Error ? err.message : String(err)));
  }, [reload, onError]);

  async function onExplain() {
    try {
      setExplanation(await explainPolicy({ action: 'inspect network egress', capability: 'network.public', dungeonId: 'osint' }));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onUpdate(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      playCue('approval');
      await updatePolicy({
        patch: { networkAccess: network },
        confirm: confirm.trim() || undefined,
        expectedRevision: view?.policy.revision,
      });
      setConfirm('');
      await reload();
      playCue('complete');
      onStatus('Effective policy updated. Authority still decides grants.');
    } catch (err) {
      playCue('warn');
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="workspace estate" aria-label="Privacy and Safety">
      <header className="thread-header">
        <div>
          <h2>Privacy &amp; Safety</h2>
          <p className="hint">Owner-only. Hiding this page is not a control. Authority enforces the boundary.</p>
        </div>
      </header>
      <section className="estate-body">
        {!view ? (
          <p className="muted">Loading effective policy from the server.</p>
        ) : (
          <>
            <dl className="facts">
              <div>
                <dt>Processing</dt>
                <dd>{view.policy.processing}</dd>
              </div>
              <div>
                <dt>Network</dt>
                <dd>{view.policy.networkAccess}</dd>
              </div>
              <div>
                <dt>Retrieval</dt>
                <dd>{view.policy.retrievalScope}</dd>
              </div>
              <div>
                <dt>Files</dt>
                <dd>{view.policy.projectFileAccess}</dd>
              </div>
              <div>
                <dt>Autonomy</dt>
                <dd>{view.policy.autonomyCeiling}</dd>
              </div>
              <div>
                <dt>Approvals</dt>
                <dd>{view.policy.approvalRequired.join(', ') || 'none'}</dd>
              </div>
              <div>
                <dt>Tools / plugins</dt>
                <dd>
                  {view.policy.toolsEnabled ? 'tools on' : 'tools off'} · {view.policy.pluginsEnabled ? 'plugins on' : 'plugins off'}
                </dd>
              </div>
              <div>
                <dt>Memory / repo / children</dt>
                <dd>
                  {view.policy.memoryEnabled ? 'memory' : 'no memory'} · {view.policy.repoWrite ? 'repo write' : 'no repo write'} ·{' '}
                  {view.policy.childProcesses ? 'child processes' : 'no child processes'}
                </dd>
              </div>
            </dl>
            <button type="button" className="ghost" onClick={() => void onExplain()}>
              Explain OSINT network.public
            </button>
            {explanation ? (
              <section className="stack">
                <h3>Why this action is {explanation.allowed ? 'allowed' : 'denied'}</h3>
                <p>{explanation.authorityRule}</p>
                <p>{explanation.policyRule}</p>
                <p className="meta">Model access: {explanation.modelAccess.join(' · ')}</p>
                <p className="meta">Can leave environment: {explanation.canLeaveEnvironment.join(' · ')}</p>
                <p className="meta">Without approval: {explanation.canExecuteWithoutApproval.join(' · ')}</p>
              </section>
            ) : null}
            <form className="stack" onSubmit={(event) => void onUpdate(event)}>
              <label htmlFor="network-access">Network access</label>
              <select id="network-access" value={network} onChange={(event) => setNetwork(event.target.value)}>
                <option value="none">none</option>
                <option value="public">public</option>
                <option value="private">private</option>
              </select>
              <label htmlFor="policy-confirm">Type CONFIRM for consequential changes</label>
              <input id="policy-confirm" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="off" />
              <button type="submit" className="primary" disabled={busy}>
                Update policy
              </button>
            </form>
            <h3>Proposals</h3>
            {proposals.length === 0 ? (
              <p className="muted">No model proposals waiting.</p>
            ) : (
              <ul className="plain">
                {proposals.map((item) => (
                  <li key={item.id} className="file-row">
                    <span>
                      {item.status} · {JSON.stringify(item.patch)}
                    </span>
                    {item.status === 'proposed' ? (
                      <button type="button" className="ghost compact" onClick={() => void decidePrivacyProposal(item.id, 'denied').then(reload)}>
                        Deny
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <h3>Audit</h3>
            {audit.length === 0 ? (
              <p className="muted">No audit rows yet.</p>
            ) : (
              <ul className="plain">
                {audit.slice(0, 12).map((row) => (
                  <li key={row.id}>
                    <span className="meta">
                      {row.action} · {row.reasonCode}
                      {row.stepUp ? ' · step-up' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </main>
  );
}

function RecordList({
  title,
  items,
  onOpen,
  activeId,
}: {
  title: string;
  items: DungeonRecord[];
  onOpen?: (item: DungeonRecord) => void;
  activeId?: string;
}) {
  return (
    <section>
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <ul className="plain">
          {items.map((item) => (
            <li key={item.id}>
              {onOpen ? (
                <button type="button" className={item.id === activeId ? 'active' : ''} onClick={() => onOpen(item)}>
                  <span>{item.title}</span>
                  <span className="meta">
                    {item.kind} · {item.status}
                  </span>
                </button>
              ) : (
                <span>
                  {item.title}
                  <span className="meta">
                    {' '}
                    · {item.kind} · {item.status}
                  </span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
