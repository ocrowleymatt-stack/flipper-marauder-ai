import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  createDocument,
  generateDocument,
  getDocument,
  getDocumentProvenance,
  listDocuments,
  listDocumentVersions,
  restoreDocument,
  type ProjectFile,
  type WritingDocument,
  type WritingDocumentVersion,
  type WritingProvenance,
} from './api';

const OPERATIONS = [
  'create',
  'rewrite',
  'shorten',
  'expand',
  'tone',
  'restructure',
  'correct',
  'continue',
  'transform',
] as const;

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
  const [documents, setDocuments] = useState<WritingDocument[]>([]);
  const [active, setActive] = useState<WritingDocument | null>(null);
  const [versions, setVersions] = useState<WritingDocumentVersion[]>([]);
  const [provenance, setProvenance] = useState<WritingProvenance[]>([]);
  const [instruction, setInstruction] = useState('');
  const [operation, setOperation] = useState<(typeof OPERATIONS)[number]>('create');
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [title, setTitle] = useState('');

  const loadList = useCallback(async () => {
    const items = await listDocuments(projectId);
    setDocuments(items);
    return items;
  }, [projectId]);

  const openDocument = useCallback(async (id: string) => {
    const document = await getDocument(id);
    setActive(document);
    const [nextVersions, nextProvenance] = await Promise.all([
      listDocumentVersions(id).catch(() => []),
      getDocumentProvenance(id).catch(() => []),
    ]);
    setVersions(nextVersions);
    setProvenance(nextProvenance);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const items = await loadList();
        if (items[0]) await openDocument(items[0].id);
        else {
          setActive(null);
          setVersions([]);
          setProvenance([]);
        }
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [loadList, openDocument, onError]);

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    try {
      const document = await createDocument(projectId, { title: title.trim() || undefined, instruction: instruction.trim() || undefined });
      setTitle('');
      await loadList();
      await openDocument(document.id);
      onStatus('Document created. It is durable on the server.');
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
    try {
      let latest = active;
      for await (const event of generateDocument(active.id, {
        operation,
        instruction: instruction.trim(),
        fileIds: selectedFiles,
        expectedRevision: active.revision,
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
      await openDocument(latest.id);
      onStatus(latest.status === 'committed' ? 'Revision committed.' : 'Writing run finished.');
    } catch (err) {
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

  const body = active?.status === 'streaming' || active?.status === 'candidate' ? (active.draft ?? active.content) : (active?.content ?? '');

  return (
    <main className="workspace caspa" aria-label="Caspa writing">
      <header className="thread-header">
        <div>
          <h2>{active?.title ?? 'Caspa'}</h2>
          <p className="hint">Documents belong to this project. Caspa does not route providers or grant Authority.</p>
        </div>
        <p className={`pill ${active?.status ?? 'idle'}`}>{active?.status ?? 'idle'}</p>
      </header>
      <div className="caspa-layout">
        <section className="caspa-list">
          <form className="stack" onSubmit={(event) => void onCreate(event)}>
            <label htmlFor="doc-title">New document</label>
            <input id="doc-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Title" />
            <button type="submit" className="primary">
              Create document
            </button>
          </form>
          <h3>Documents</h3>
          {documents.length === 0 ? (
            <p className="muted">No documents yet.</p>
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
          {!active ? (
            <div className="empty">
              <h3>Empty writing workspace</h3>
              <p>Create a document in this project. Reloading restores server state.</p>
            </div>
          ) : (
            <>
              <label htmlFor="doc-body">Current revision</label>
              <textarea id="doc-body" readOnly value={body} rows={16} />
              {active.failure ? (
                <p className="error" role="alert">
                  {active.failure.code}: {active.failure.message}
                </p>
              ) : null}
              <form className="stack" onSubmit={(event) => void onGenerate(event)}>
                <label htmlFor="operation">Writing operation</label>
                <select id="operation" value={operation} onChange={(event) => setOperation(event.target.value as (typeof OPERATIONS)[number])} disabled={busy}>
                  {OPERATIONS.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
                <label htmlFor="instruction">Instruction</label>
                <textarea id="instruction" value={instruction} onChange={(event) => setInstruction(event.target.value)} disabled={busy} rows={4} />
                <fieldset className="stack">
                  <legend>Context files</legend>
                  <p className="muted">Selected files only. Caspa does not dump the project.</p>
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
                  {busy ? 'Writing' : 'Generate'}
                </button>
              </form>
            </>
          )}
        </section>
        <aside className="caspa-meta">
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
          <h3>Provenance</h3>
          <p className="muted">Rendered from the backend. The browser does not infer sources.</p>
          {provenance.length === 0 ? (
            <p className="muted">No provenance yet.</p>
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
