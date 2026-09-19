import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  cancelDocument,
  commissionDocument,
  createDocument,
  editDocument,
  generateDocument,
  getDocument,
  getDocumentProvenance,
  getStoryBible,
  getStructure,
  listCharacters,
  listCompanions,
  listContinuity,
  listDocuments,
  listDocumentVersions,
  listLineage,
  listWorld,
  restoreDocument,
  saveCharacter,
  saveCompanion,
  saveStoryBible,
  saveStructure,
  saveWorld,
  type DungeonRecord,
  type ProjectFile,
  type WritingDocument,
  type WritingDocumentVersion,
  type WritingProvenance,
} from './api';
import { playCue } from './experience';

const OPERATIONS = [
  'continue_scene',
  'draft_scene',
  'rewrite_selection',
  'expand',
  'tighten',
  'tone',
  'dialogue',
  'description',
  'character_voice',
  'continuity_check',
  'critique',
  'repair_from_critique',
  'outline',
  'create',
  'rewrite',
  'continue',
] as const;

type CaspaSurface = 'manuscript' | 'bible' | 'characters' | 'structure' | 'continuity';

const SURFACES: Array<{ id: CaspaSurface; label: string }> = [
  { id: 'manuscript', label: 'Manuscript' },
  { id: 'bible', label: 'Story bible' },
  { id: 'characters', label: 'Characters' },
  { id: 'structure', label: 'Structure' },
  { id: 'continuity', label: 'Continuity' },
];

export function CaspaPanel({
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
  const [surface, setSurface] = useState<CaspaSurface>('manuscript');
  const [documents, setDocuments] = useState<WritingDocument[]>([]);
  const [active, setActive] = useState<WritingDocument | null>(null);
  const [versions, setVersions] = useState<WritingDocumentVersion[]>([]);
  const [provenance, setProvenance] = useState<WritingProvenance[]>([]);
  const [lineage, setLineage] = useState<DungeonRecord[]>([]);
  const [instruction, setInstruction] = useState('');
  const [operation, setOperation] = useState<(typeof OPERATIONS)[number]>('continue_scene');
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [editor, setEditor] = useState('');
  const [selection, setSelection] = useState('');
  const [companions, setCompanions] = useState<DungeonRecord[]>([]);
  const [companionText, setCompanionText] = useState('');
  const [bible, setBible] = useState<DungeonRecord | null>(null);
  const [bibleForm, setBibleForm] = useState({
    premise: '',
    genre: '',
    tone: '',
    pov: '',
    tense: '',
    styleNotes: '',
    themes: '',
    settingRules: '',
  });
  const [characters, setCharacters] = useState<DungeonRecord[]>([]);
  const [characterForm, setCharacterForm] = useState({
    name: '',
    role: '',
    want: '',
    need: '',
    voice: '',
    notes: '',
  });
  const [worlds, setWorlds] = useState<DungeonRecord[]>([]);
  const [worldForm, setWorldForm] = useState({ name: '', rules: '', notes: '' });
  const [structure, setStructure] = useState<DungeonRecord | null>(null);
  const [structureText, setStructureText] = useState('');
  const [findings, setFindings] = useState<DungeonRecord[]>([]);

  const loadNovel = useCallback(async () => {
    const [nextBible, nextCharacters, nextStructure, nextFindings, nextWorlds] = await Promise.all([
      getStoryBible(projectId).catch(() => null),
      listCharacters(projectId).catch(() => []),
      getStructure(projectId).catch(() => null),
      listContinuity(projectId).catch(() => []),
      listWorld(projectId).catch(() => []),
    ]);
    setBible(nextBible);
    if (nextBible?.payload && typeof nextBible.payload === 'object') {
      const payload = nextBible.payload as Record<string, string | string[]>;
      setBibleForm({
        premise: String(payload.premise ?? ''),
        genre: String(payload.genre ?? ''),
        tone: String(payload.tone ?? ''),
        pov: String(payload.pov ?? ''),
        tense: String(payload.tense ?? ''),
        styleNotes: String(payload.styleNotes ?? ''),
        themes: Array.isArray(payload.themes) ? payload.themes.join(', ') : String(payload.themes ?? ''),
        settingRules: String(payload.settingRules ?? ''),
      });
    }
    setCharacters(nextCharacters);
    setStructure(nextStructure);
    if (nextStructure?.payload && typeof nextStructure.payload === 'object') {
      const chapters = (nextStructure.payload as { chapters?: Array<{ title: string }> }).chapters ?? [];
      setStructureText(chapters.map((chapter) => chapter.title).join('\n'));
    }
    setFindings(nextFindings);
    setWorlds(nextWorlds);
  }, [projectId]);

  const loadList = useCallback(async () => {
    const items = await listDocuments(projectId);
    setDocuments(items);
    return items;
  }, [projectId]);

  const openDocument = useCallback(async (id: string) => {
    const document = await getDocument(id);
    setActive(document);
    const [nextVersions, nextProvenance, nextCompanions, nextLineage] = await Promise.all([
      listDocumentVersions(id).catch(() => []),
      getDocumentProvenance(id).catch(() => []),
      listCompanions(id).catch(() => []),
      listLineage(id).catch(() => []),
    ]);
    setVersions(nextVersions);
    setProvenance(nextProvenance);
    setCompanions(nextCompanions);
    setLineage(nextLineage);
    setEditor(document.content || document.draft || '');
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const items = await loadList();
        await loadNovel();
        if (items[0]) await openDocument(items[0].id);
        else {
          setActive(null);
          setVersions([]);
          setProvenance([]);
          setLineage([]);
        }
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [loadList, loadNovel, openDocument, onError]);

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    try {
      const document = await createDocument(projectId, { title: title.trim() || undefined, instruction: instruction.trim() || undefined });
      setTitle('');
      await loadList();
      await openDocument(document.id);
      onStatus('Chapter created. It is durable on the server.');
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onGenerate(event: FormEvent) {
    event.preventDefault();
    if (!active || !instruction.trim() || busy) return;
    setBusy(true);
    onError(null);
    onStatus('Writing run requested.');
    playCue('activate');
    try {
      let latest = active;
      for await (const event of generateDocument(active.id, {
        operation,
        instruction: instruction.trim(),
        fileIds: selectedFiles,
        expectedRevision: active.revision,
        selection: selection.trim() || undefined,
      })) {
        if (event.type === 'document' && event.document) {
          latest = event.document as WritingDocument;
          setActive((current) => mergeStreamingDocument(current, latest));
        }
        if (event.type === 'draft.delta' && typeof event.text === 'string') {
          setActive((current) =>
            current
              ? { ...current, draft: `${current.draft ?? ''}${event.text as string}`, status: 'streaming' }
              : current,
          );
        }
        if (event.type === 'error') {
          const failure = event.failure as { message?: string } | undefined;
          if (failure?.message) onError(failure.message);
        }
      }
      await loadList();
      await loadNovel();
      await openDocument(latest.id);
      playCue(latest.status === 'committed' || latest.status === 'idle' ? 'complete' : 'warn');
      onStatus(operation === 'critique' || operation === 'continuity_check' ? 'Findings recorded. Manuscript unchanged.' : 'Revision committed.');
    } catch (err) {
      playCue('warn');
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onRestore(version: number) {
    if (!active) return;
    try {
      const restored = await restoreDocument(active.id, version, active.revision);
      await loadList();
      await openDocument(restored.id);
      onStatus(`Restored version ${version} as a new revision.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onSaveEdit() {
    if (!active || !editor.trim() || busy) return;
    setBusy(true);
    try {
      const saved = await editDocument(active.id, editor, active.revision, active.title);
      await loadList();
      await openDocument(saved.id);
      onStatus('Editor revision committed.');
      playCue('complete');
    } catch (err) {
      playCue('warn');
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onCancel() {
    if (!active) return;
    try {
      const cancelled = await cancelDocument(active.id);
      await openDocument(cancelled.id);
      onStatus('Cancel requested. The run is sealed on the server.');
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onCommission() {
    if (!active || !instruction.trim() || busy) return;
    setBusy(true);
    try {
      playCue('activate');
      const result = await commissionDocument(active.id, {
        operation,
        instruction: instruction.trim(),
        fileIds: selectedFiles,
        expectedRevision: active.revision,
      });
      await loadList();
      await openDocument(result.document.id);
      playCue('complete');
      onStatus(`Commission job ${result.jobId} finished.`);
    } catch (err) {
      playCue('warn');
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onCompanion(event: FormEvent) {
    event.preventDefault();
    if (!active || !companionText.trim()) return;
    try {
      await saveCompanion(active.id, { kind: 'outline', title: 'Outline', text: companionText.trim() });
      setCompanionText('');
      setCompanions(await listCompanions(active.id));
      onStatus('Companion artefact stored.');
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onSaveBible(event: FormEvent) {
    event.preventDefault();
    try {
      const saved = await saveStoryBible(projectId, {
        payload: {
          ...bibleForm,
          themes: bibleForm.themes
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
        },
        expectedRevision: bible?.revision,
      });
      setBible(saved);
      onStatus('Story bible saved.');
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onSaveCharacter(event: FormEvent) {
    event.preventDefault();
    if (!characterForm.name.trim()) return;
    try {
      await saveCharacter(projectId, { payload: characterForm, title: characterForm.name.trim() });
      setCharacterForm({ name: '', role: '', want: '', need: '', voice: '', notes: '' });
      setCharacters(await listCharacters(projectId));
      onStatus('Character saved.');
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onSaveStructure(event: FormEvent) {
    event.preventDefault();
    try {
      const chapters = structureText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, index) => {
          const existing = documents[index];
          return {
            id: `ch_${index + 1}`,
            title: line.replace(/^\d+\.\s*/, ''),
            documentId: existing?.id ?? null,
            summary: '',
            scenes: [],
          };
        });
      const saved = await saveStructure(projectId, { payload: { chapters }, expectedRevision: structure?.revision });
      setStructure(saved);
      onStatus('Structure saved.');
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onSaveWorld(event: FormEvent) {
    event.preventDefault();
    if (!worldForm.name.trim()) return;
    try {
      await saveWorld(projectId, { payload: worldForm, title: worldForm.name.trim() });
      setWorldForm({ name: '', rules: '', notes: '' });
      setWorlds(await listWorld(projectId));
      onStatus('World record saved.');
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  const streaming = active?.status === 'streaming' || active?.status === 'candidate';
  const body = streaming ? (active?.draft ?? active?.content ?? '') : editor;

  return (
    <main className="workspace caspa" aria-label="Caspa novelist workspace" data-testid="caspa-panel">
      <header className="thread-header">
        <div>
          <h2>{active?.title ?? 'Caspa'}</h2>
          <p className="hint">A novelist's room. The manuscript stays central. Story bible, characters, and structure feed writing without replacing it.</p>
        </div>
        <p className={`pill ${active?.status ?? 'idle'}`}>{active?.status ?? 'idle'}</p>
      </header>
      <nav className="caspa-surfaces" aria-label="Caspa surfaces">
        {SURFACES.map((item) => (
          <button
            key={item.id}
            type="button"
            className={surface === item.id ? 'active' : ''}
            data-testid={`caspa-surface-${item.id}`}
            onClick={() => setSurface(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="caspa-layout">
        <section className="caspa-list">
          <form className="stack compact-form" onSubmit={(event) => void onCreate(event)}>
            <label htmlFor="doc-title">New chapter</label>
            <input id="doc-title" data-testid="doc-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Chapter title" />
            <button type="submit" className="primary" data-testid="create-document">
              Create document
            </button>
          </form>
          <h3>Manuscript</h3>
          {documents.length === 0 ? (
            <p className="muted">No chapters yet.</p>
          ) : (
            <ul className="plain">
              {documents.map((document) => (
                <li key={document.id}>
                  <button type="button" className={document.id === active?.id ? 'active' : ''} onClick={() => void openDocument(document.id)}>
                    <span>{document.title}</span>
                    <span className="meta">
                      v{document.currentVersion} · {document.status}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="caspa-editor">
          {surface === 'manuscript' && !active ? (
            <div className="empty">
              <h3>Empty writing room</h3>
              <p>Create a chapter in this project. Reloading restores server state.</p>
            </div>
          ) : null}
          {surface === 'manuscript' && active ? (
            <>
              <label htmlFor="doc-body">Current revision</label>
              <textarea
                id="doc-body"
                data-testid="caspa-manuscript"
                value={body}
                readOnly={streaming || busy}
                onChange={(event) => setEditor(event.target.value)}
                rows={16}
              />
              <div className="row">
                <button type="button" className="ghost" disabled={busy || streaming || !editor.trim()} onClick={() => void onSaveEdit()}>
                  Save revision
                </button>
                <button type="button" className="ghost" disabled={!active} onClick={() => void onCancel()}>
                  Cancel run
                </button>
              </div>
              {active.failure ? (
                <p className="error" role="alert">
                  {active.failure.code}: {active.failure.message}
                </p>
              ) : null}
              <form className="stack" onSubmit={(event) => void onGenerate(event)}>
                <label htmlFor="operation">Writing behaviour</label>
                <select id="operation" value={operation} onChange={(event) => setOperation(event.target.value as (typeof OPERATIONS)[number])} disabled={busy}>
                  {OPERATIONS.map((item) => (
                    <option key={item} value={item}>
                      {item.replaceAll('_', ' ')}
                    </option>
                  ))}
                </select>
                <label htmlFor="instruction">Instruction</label>
                <textarea id="instruction" value={instruction} onChange={(event) => setInstruction(event.target.value)} disabled={busy} rows={3} />
                <label htmlFor="selection">Selection (optional)</label>
                <textarea id="selection" value={selection} onChange={(event) => setSelection(event.target.value)} disabled={busy} rows={2} placeholder="Paste a passage for rewrite selection / dialogue pass" />
                <fieldset className="stack">
                  <legend>Context files</legend>
                  <p className="muted">Selected files only, plus bible/characters/structure the server judges relevant. Caspa does not dump the novel.</p>
                  {files.length === 0 ? (
                    <p className="muted">No files in this project.</p>
                  ) : (
                    files.map((file) => (
                      <label key={file.id} className="file-check">
                        <input
                          type="checkbox"
                          checked={selectedFiles.includes(file.id)}
                          onChange={(event) => {
                            setSelectedFiles((current) =>
                              event.target.checked ? [...current, file.id] : current.filter((id) => id !== file.id),
                            );
                          }}
                        />
                        {file.displayName}
                      </label>
                    ))
                  )}
                </fieldset>
                <button type="submit" className="primary" disabled={busy || !instruction.trim()}>
                  {busy ? 'Writing' : 'Write'}
                </button>
                <button type="button" className="ghost" disabled={busy || !instruction.trim()} onClick={() => void onCommission()}>
                  Commission job
                </button>
              </form>
            </>
          ) : null}
          {surface === 'bible' ? (
            <div className="stack" data-testid="caspa-bible">
            <form className="stack" onSubmit={(event) => void onSaveBible(event)}>
              <h3>Story bible</h3>
              <p className="muted">Persistent creative context. Invented prose does not require evidential sources.</p>
              {(['premise', 'genre', 'tone', 'pov', 'tense', 'styleNotes', 'themes', 'settingRules'] as const).map((field) => (
                <label key={field} htmlFor={`bible-${field}`}>
                  {field.replace(/[A-Z]/g, (part) => ` ${part.toLowerCase()}`)}
                  {field === 'themes' || field === 'premise' || field === 'styleNotes' || field === 'settingRules' ? (
                    <textarea id={`bible-${field}`} value={bibleForm[field]} onChange={(event) => setBibleForm((current) => ({ ...current, [field]: event.target.value }))} rows={field === 'premise' ? 3 : 2} />
                  ) : (
                    <input id={`bible-${field}`} value={bibleForm[field]} onChange={(event) => setBibleForm((current) => ({ ...current, [field]: event.target.value }))} />
                  )}
                </label>
              ))}
              <button type="submit" className="primary">
                Save story bible
              </button>
            </form>
              <h3>World / setting</h3>
              <p className="muted">Named setting records supplied as bounded context. World rules also live in the bible.</p>
              <ul className="plain">
                {worlds.map((item) => (
                  <li key={item.id}>
                    <strong>{item.title}</strong>
                    <span className="meta">{String((item.payload as { rules?: string }).rules ?? '')}</span>
                  </li>
                ))}
              </ul>
              <form className="stack" onSubmit={(event) => void onSaveWorld(event)}>
                <label htmlFor="world-name">Setting name</label>
                <input id="world-name" value={worldForm.name} onChange={(event) => setWorldForm((current) => ({ ...current, name: event.target.value }))} />
                <label htmlFor="world-rules">Rules</label>
                <textarea id="world-rules" value={worldForm.rules} onChange={(event) => setWorldForm((current) => ({ ...current, rules: event.target.value }))} rows={2} />
                <button type="submit" className="ghost" disabled={!worldForm.name.trim()}>
                  Add setting
                </button>
              </form>
            </div>
          ) : null}
          {surface === 'characters' ? (
            <div className="stack" data-testid="caspa-characters">
              <h3>Characters</h3>
              <ul className="plain">
                {characters.map((item) => (
                  <li key={item.id}>
                    <strong>{item.title}</strong>
                    <span className="meta">{String((item.payload as { role?: string }).role ?? '')}</span>
                  </li>
                ))}
              </ul>
              <form className="stack" onSubmit={(event) => void onSaveCharacter(event)}>
                <label htmlFor="char-name">Name</label>
                <input id="char-name" value={characterForm.name} onChange={(event) => setCharacterForm((current) => ({ ...current, name: event.target.value }))} />
                <label htmlFor="char-role">Role</label>
                <input id="char-role" value={characterForm.role} onChange={(event) => setCharacterForm((current) => ({ ...current, role: event.target.value }))} />
                <label htmlFor="char-want">Want</label>
                <input id="char-want" value={characterForm.want} onChange={(event) => setCharacterForm((current) => ({ ...current, want: event.target.value }))} />
                <label htmlFor="char-need">Need</label>
                <input id="char-need" value={characterForm.need} onChange={(event) => setCharacterForm((current) => ({ ...current, need: event.target.value }))} />
                <label htmlFor="char-voice">Voice</label>
                <input id="char-voice" value={characterForm.voice} onChange={(event) => setCharacterForm((current) => ({ ...current, voice: event.target.value }))} />
                <label htmlFor="char-notes">Notes</label>
                <textarea id="char-notes" value={characterForm.notes} onChange={(event) => setCharacterForm((current) => ({ ...current, notes: event.target.value }))} rows={3} />
                <button type="submit" className="primary" disabled={!characterForm.name.trim()}>
                  Add character
                </button>
              </form>
            </div>
          ) : null}
          {surface === 'structure' ? (
            <form className="stack" onSubmit={(event) => void onSaveStructure(event)} data-testid="caspa-structure">
              <h3>Structure</h3>
              <p className="muted">One chapter title per line. Order is the novel outline, not a file browser.</p>
              <textarea value={structureText} onChange={(event) => setStructureText(event.target.value)} rows={12} />
              <button type="submit" className="primary">
                Save structure
              </button>
            </form>
          ) : null}
          {surface === 'continuity' ? (
            <div className="stack" data-testid="caspa-continuity">
              <h3>Continuity & critique</h3>
              <p className="muted">Findings with explanation and manuscript references. No quality scores. These do not silently rewrite the manuscript.</p>
              {findings.length === 0 ? (
                <p className="muted">No findings yet. Run continuity check or critique from the manuscript.</p>
              ) : (
                <ul className="plain">
                  {findings.map((item) => (
                    <li key={item.id}>
                      <strong>{item.kind}</strong>
                      <span className="meta">{item.title}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </section>
        <aside className="caspa-meta">
          <h3>Creative lineage</h3>
          <p className="muted">Manuscript history: parent revision, operation, execution, context snapshot. Distinct from evidential provenance.</p>
          {lineage.length === 0 ? (
            <p className="muted">No creative lineage yet.</p>
          ) : (
            <ul className="plain" data-testid="caspa-lineage">
              {lineage.map((item) => (
                <li key={item.id}>
                  <strong>{item.title}</strong>
                  <span className="meta">{String((item.payload as { operation?: string }).operation ?? item.kind)}</span>
                </li>
              ))}
            </ul>
          )}
          <h3>Companions</h3>
          {companions.length === 0 ? (
            <p className="muted">No outline notes yet.</p>
          ) : (
            <ul className="plain">
              {companions.map((item) => (
                <li key={item.id}>
                  <strong>{item.kind}</strong>
                  <span className="meta">{item.title}</span>
                </li>
              ))}
            </ul>
          )}
          {active ? (
            <form className="stack" onSubmit={(event) => void onCompanion(event)}>
              <label htmlFor="companion-text">Outline / canon note</label>
              <textarea id="companion-text" value={companionText} onChange={(event) => setCompanionText(event.target.value)} rows={3} />
              <button type="submit" className="ghost" disabled={!companionText.trim()}>
                Store companion
              </button>
            </form>
          ) : null}
          <h3>Versions</h3>
          {versions.length === 0 ? (
            <p className="muted">No committed revisions yet.</p>
          ) : (
            <ul className="plain">
              {versions.map((version) => (
                <li key={version.id} className="file-row">
                  <div>
                    <strong>v{version.version}</strong>
                    <span className="meta">
                      {version.operation} · {version.contentHash.slice(0, 12)}
                    </span>
                  </div>
                  <button type="button" className="ghost compact" onClick={() => void onRestore(version.version)} disabled={busy || !active}>
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          )}
          <h3>Evidential provenance</h3>
          <p className="muted">Research/file sources only. Invented prose does not require this.</p>
          {provenance.length === 0 ? (
            <p className="muted">No evidential provenance yet.</p>
          ) : (
            <ul className="plain">
              {provenance.map((entry) => (
                <li key={`${entry.artefactId}-${entry.timestamp}`}>
                  <span className="meta">
                    {entry.capability ?? 'writing'} · {entry.provider}/{entry.model}
                  </span>
                  <span className="meta">{entry.sourceInputs.slice(0, 4).join(' · ')}</span>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </main>
  );
}

function mergeStreamingDocument(current: WritingDocument | null, next: WritingDocument): WritingDocument {
  if (!current?.draft || next.status !== 'streaming') return next;
  const snapshot = next.draft ?? '';
  const assembled = current.draft;
  if (!snapshot || snapshot === assembled || assembled.startsWith(snapshot) || snapshot.startsWith(assembled)) {
    return { ...next, draft: assembled.length >= snapshot.length ? assembled : snapshot };
  }
  return next;
}
