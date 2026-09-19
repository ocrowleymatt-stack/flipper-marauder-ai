export type Capability =
  | 'nexus/fast'
  | 'nexus/reason'
  | 'nexus/code'
  | 'nexus/vision'
  | 'nexus/cheap'
  | 'nexus/local'
  | 'nexus/frontier';

export const CAPABILITIES: Array<{ id: Capability; label: string }> = [
  { id: 'nexus/fast', label: 'Fast' },
  { id: 'nexus/reason', label: 'Reason' },
  { id: 'nexus/code', label: 'Code' },
  { id: 'nexus/cheap', label: 'Cheap' },
  { id: 'nexus/local', label: 'Local' },
];

export interface SessionState {
  authenticated: boolean;
  bootstrapAllowed: boolean;
  loginAvailable?: boolean;
  csrfToken: string | null;
  principal: { id: string; kind?: string; tenantBound: boolean } | null;
}

export interface Project {
  id: string;
  urn: string;
  name: string;
  description: string | null;
  dungeon?: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: string;
  urn: string;
  title: string;
  projectId: string | null;
  workspaceId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  urn: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  sequence: number;
  executionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionAttempt {
  index: number;
  provider: string;
  model: string;
  outcome: string;
  emittedVisibleOutput: boolean;
  error: { code: string; message: string } | null;
}

export interface ExecutionRecord {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  capability: string;
  selectedProvider: string | null;
  selectedModel: string | null;
  attempts: ExecutionAttempt[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  failureReason: { code: string; message: string; retryable?: boolean } | null;
  route: { target: string; resolvedRouteId: string; decisionReason: string; provider?: string; model?: string } | null;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  visibleOutputBegun?: boolean;
}

export interface ConversationSnapshot {
  conversation: Conversation;
  messages: Message[];
  executions: ExecutionRecord[];
}

export interface ProjectFile {
  id: string;
  path: string;
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  projectId: string;
}

export interface Citation {
  chunkId: string | null;
  fileId: string | null;
  path: string | null;
  locator: { path: string; startOffset: number; endOffset: number } | null;
  quote: string | null;
  confidence: 'sourced' | 'unknown';
  note?: string;
}

export interface AssembledContext {
  slices: Array<{
    chunkId: string;
    fileId: string;
    path: string;
    text: string;
    score: number;
    truncated: boolean;
    source: 'attachment' | 'retrieval';
    contentHash: string;
  }>;
  citations: Citation[];
  truncated: boolean;
  tokenCount: number;
  tokenBudget: number;
}

export interface ToolPresentation {
  id: string;
  toolId: string;
  title: string;
  description: string;
  status: string;
  arguments: Record<string, unknown>;
  argumentSummary: string;
  resource: string | null;
  conversationId: string | null;
  executionId: string | null;
  workspaceId: string | null;
  sideEffectClass: string;
  approvalPolicy: string;
  requiredCapabilities: string[];
  risk: 'read' | 'write' | 'external' | 'admin';
  awaitingApproval: boolean;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  approval: {
    id: string;
    decision: string;
    decidedBy: string | null;
    decidedAt: string | null;
    reason: string | null;
  } | null;
}

export type StreamEvent =
  | { type: 'message'; message: Message }
  | { type: 'message.delta'; messageId: string; content: string }
  | { type: 'execution'; execution: ExecutionRecord }
  | { type: 'error'; failure: { code: string; message: string } }
  | { type: 'done' }
  | { type: 'execution.started'; executionId: string; capability: string }
  | { type: 'attempt.started'; executionId: string; provider: string; model: string }
  | { type: 'attempt.failed'; failure: { message: string }; emittedVisibleOutput: boolean }
  | { type: 'assistant.delta'; text: string }
  | { type: 'assistant.completed'; text: string }
  | { type: 'provider.warning'; message: string; provider?: string }
  | { type: 'provider.failed'; failure: { message: string } }
  | { type: 'execution.failed'; failure: { code: string; message: string } }
  | { type: 'execution.completed'; provider: string | null; model: string | null }
  | { type: 'tool.lifecycle'; invocationId: string; toolId: string; status: string; reason?: string; executionId?: string }
  | { type: 'tool.result'; invocationId: string; toolId: string; resultRef?: string | null }
  | { type: string; [key: string]: unknown };

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

export function mutatingHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extra };
  if (csrfToken) headers['x-atlas-csrf'] = csrfToken;
  return headers;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? response.statusText;
  } catch {
    return response.statusText;
  }
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = new Error(await readError(response)) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return response.json() as Promise<T>;
}

export function isProjectsUnavailable(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'status' in error && (error as { status: number }).status === 503);
}

export async function getSession(): Promise<SessionState> {
  return parseJson(await fetch('/api/session', { credentials: 'include' }));
}

export async function bootstrapSession(): Promise<SessionState> {
  const current = await getSession();
  if (current.authenticated) {
    setCsrfToken(current.csrfToken);
    return current;
  }
  if (!current.bootstrapAllowed) {
    setCsrfToken(null);
    return current;
  }
  const issued = await parseJson<SessionState>(
    await fetch('/api/session', {
      method: 'POST',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: JSON.stringify({}),
    }),
  );
  setCsrfToken(issued.csrfToken);
  return issued;
}

export async function loginWithPassword(login: string, password: string): Promise<SessionState> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, password }),
  });
  if (response.status === 429) {
    const error = new Error(await readError(response)) as Error & { status: number };
    error.status = 429;
    throw error;
  }
  const issued = await parseJson<SessionState>(response);
  setCsrfToken(issued.csrfToken);
  return issued;
}

export async function revokeSession(): Promise<void> {
  await fetch('/api/session/revoke', {
    method: 'POST',
    credentials: 'include',
    headers: mutatingHeaders(),
    body: '{}',
  });
  setCsrfToken(null);
}

export async function listProjects(): Promise<Project[]> {
  return parseJson(await fetch('/api/projects', { credentials: 'include' }));
}

export async function createProject(name: string, dungeon?: string): Promise<Project> {
  return parseJson(
    await fetch('/api/projects', {
      method: 'POST',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: JSON.stringify(dungeon ? { name, dungeon } : { name }),
    }),
  );
}

export async function getProject(id: string): Promise<Project> {
  return parseJson(await fetch(`/api/projects/${encodeURIComponent(id)}`, { credentials: 'include' }));
}

export async function listProjectConversations(projectId: string): Promise<Conversation[]> {
  return parseJson(
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/conversations`, { credentials: 'include' }),
  );
}

export async function createConversation(projectId?: string | null, title?: string): Promise<Conversation> {
  const path = projectId
    ? `/api/projects/${encodeURIComponent(projectId)}/conversations`
    : '/api/conversations';
  return parseJson(
    await fetch(path, {
      method: 'POST',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: JSON.stringify(title ? { title } : {}),
    }),
  );
}

export async function listConversations(): Promise<Conversation[]> {
  return parseJson(await fetch('/api/conversations', { credentials: 'include' }));
}

export async function getSnapshot(id: string): Promise<ConversationSnapshot> {
  return parseJson(await fetch(`/api/conversations/${encodeURIComponent(id)}`, { credentials: 'include' }));
}

export async function* sendMessage(
  conversationId: string,
  content: string,
  capability: Capability,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    credentials: 'include',
    headers: mutatingHeaders(),
    body: JSON.stringify({ content, capability, tools: true }),
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(await readError(response));
  }
  yield* parseSse(response.body);
}

export async function listFiles(projectId: string): Promise<ProjectFile[]> {
  return parseJson(
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, { credentials: 'include' }),
  );
}

export async function uploadTextFile(projectId: string, path: string, text: string): Promise<ProjectFile> {
  return parseJson(
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
      method: 'POST',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: JSON.stringify({ path, text }),
    }),
  );
}

export async function attachFile(fileId: string, conversationId: string): Promise<unknown> {
  return parseJson(
    await fetch(`/api/files/${encodeURIComponent(fileId)}/attach`, {
      method: 'POST',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: JSON.stringify({ conversationId }),
    }),
  );
}

export async function getProjectContext(
  projectId: string,
  query: string,
  conversationId?: string,
): Promise<AssembledContext> {
  const params = new URLSearchParams({ query });
  if (conversationId) params.set('conversationId', conversationId);
  return parseJson(
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/context?${params}`, { credentials: 'include' }),
  );
}

export async function listConversationTools(conversationId: string): Promise<ToolPresentation[]> {
  return parseJson(
    await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/tools`, { credentials: 'include' }),
  );
}

export async function listApprovals(): Promise<ToolPresentation[]> {
  return parseJson(await fetch('/api/approvals', { credentials: 'include' }));
}

export async function decideTool(id: string, decision: 'approve' | 'deny', reason?: string): Promise<{ invocation: ToolPresentation }> {
  return parseJson(
    await fetch(`/api/tools/${encodeURIComponent(id)}/${decision}`, {
      method: 'POST',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: JSON.stringify(reason ? { reason } : {}),
    }),
  );
}

export async function inspectExecution(id: string): Promise<{
  execution: ExecutionRecord;
  conversationId: string;
  tools: ToolPresentation[];
}> {
  return parseJson(await fetch(`/api/executions/${encodeURIComponent(id)}`, { credentials: 'include' }));
}

export async function cancelExecution(id: string): Promise<ExecutionRecord> {
  return parseJson(
    await fetch(`/api/executions/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: '{}',
    }),
  );
}

export function runtimeWaitingLabel(message: string | null | undefined): string | null {
  if (!message) return null;
  if (/gpu runtime starting|waiting_runtime|pod_starting|warming|starting the shared/i.test(message)) {
    return 'GPU runtime starting';
  }
  if (/waiting for (the )?shared gpu|pod_busy|profile_change/i.test(message)) {
    return 'Waiting for the shared GPU';
  }
  return message;
}

export function citationsFromBackend(context: AssembledContext | null): Citation[] {
  if (!context) return [];
  return context.citations.filter((citation) => citation.confidence === 'sourced' || citation.confidence === 'unknown');
}

export interface DungeonRegistration {
  id: string;
  slug: string;
  title: string;
  navLabel: string;
  description: string;
  surface: string;
  featureAvailable: boolean;
  ownerOnly?: boolean;
}

export interface DungeonRecord {
  id: string;
  dungeon: string;
  kind: string;
  title: string;
  status: string;
  payload: Record<string, unknown>;
  artefactId: string | null;
  contentHash: string | null;
  jobId: string | null;
  parentId: string | null;
  revision: number;
}

export interface EffectivePolicyView {
  policy: {
    processing: string;
    networkAccess: string;
    retrievalScope: string;
    projectFileAccess: string;
    toolsEnabled: boolean;
    pluginsEnabled: boolean;
    memoryEnabled: boolean;
    repoWrite: boolean;
    autonomyCeiling: string;
    approvalRequired: string[];
    telemetry: string;
    sandboxing: string;
    childProcesses: boolean;
    secretsExposure: string;
    sensitiveData: string;
    retentionDays: number | null;
    tenantSharing: string;
    revision: number;
  };
  modelContext: Record<string, unknown>;
}

export interface PolicyExplanation {
  action: string;
  allowed: boolean;
  reasonCode: string;
  authorityRule: string;
  policyRule: string;
  modelAccess: string[];
  canLeaveEnvironment: string[];
  canExecuteWithoutApproval: string[];
}

export interface WritingDocument {
  id: string;
  urn: string;
  projectId: string;
  title: string;
  status: string;
  currentVersion: number;
  revision: number;
  content: string;
  draft: string | null;
  currentContentHash: string | null;
  draftContentHash: string | null;
  originatingRunId: string | null;
  conversationId: string | null;
  failure: { code: string; message: string; retryable?: boolean } | null;
  createdAt: string;
  updatedAt: string;
}

export interface WritingDocumentVersion {
  id: string;
  documentId: string;
  version: number;
  contentHash: string;
  artefactId: string;
  title: string;
  operation: string;
  executionId: string | null;
  createdAt: string;
}

export interface WritingProvenance {
  artefactId: string;
  projectId: string;
  sourceInputs: string[];
  provider: string;
  model: string;
  jobId: string | null;
  timestamp: string;
  capability?: string;
}

export async function listDungeons(): Promise<DungeonRegistration[]> {
  return parseJson(await fetch('/api/dungeons', { credentials: 'include' }));
}

export async function listDocuments(projectId: string): Promise<WritingDocument[]> {
  return parseJson(await fetch(`/api/projects/${encodeURIComponent(projectId)}/documents`, { credentials: 'include' }));
}

export async function createDocument(projectId: string, input: { title?: string; instruction?: string }): Promise<WritingDocument> {
  return parseJson(
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/documents`, {
      method: 'POST',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: JSON.stringify(input),
    }),
  );
}

export async function getDocument(id: string): Promise<WritingDocument> {
  return parseJson(await fetch(`/api/documents/${encodeURIComponent(id)}`, { credentials: 'include' }));
}

export async function renameDocument(id: string, title: string, expectedRevision: number): Promise<WritingDocument> {
  return parseJson(
    await fetch(`/api/documents/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: JSON.stringify({ title, expectedRevision }),
    }),
  );
}

export async function deleteDocument(id: string, expectedRevision?: number): Promise<WritingDocument> {
  const suffix = expectedRevision != null ? `?expectedRevision=${expectedRevision}` : '';
  return parseJson(
    await fetch(`/api/documents/${encodeURIComponent(id)}${suffix}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: mutatingHeaders(),
    }),
  );
}

export async function listDocumentVersions(id: string): Promise<WritingDocumentVersion[]> {
  return parseJson(await fetch(`/api/documents/${encodeURIComponent(id)}/versions`, { credentials: 'include' }));
}

export async function restoreDocument(id: string, version: number, expectedRevision: number): Promise<WritingDocument> {
  return parseJson(
    await fetch(`/api/documents/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: JSON.stringify({ version, expectedRevision }),
    }),
  );
}

export async function getDocumentProvenance(id: string): Promise<WritingProvenance[]> {
  return parseJson(await fetch(`/api/documents/${encodeURIComponent(id)}/provenance`, { credentials: 'include' }));
}

export async function* generateDocument(
  id: string,
  input: { operation: string; instruction: string; fileIds: string[]; expectedRevision: number },
): AsyncGenerator<StreamEvent> {
  const response = await fetch(`/api/documents/${encodeURIComponent(id)}/generate`, {
    method: 'POST',
    credentials: 'include',
    headers: mutatingHeaders(),
    body: JSON.stringify(input),
  });
  if (!response.ok || !response.body) {
    throw new Error(await readError(response));
  }
  yield* parseSse(response.body);
}

export async function editDocument(id: string, text: string, expectedRevision: number, title?: string): Promise<WritingDocument> {
  return parseJson(
    await fetch(`/api/documents/${encodeURIComponent(id)}/edit`, {
      method: 'POST',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: JSON.stringify({ text, expectedRevision, title }),
    }),
  );
}

export async function cancelDocument(id: string): Promise<WritingDocument> {
  return parseJson(
    await fetch(`/api/documents/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: '{}',
    }),
  );
}

export async function listCompanions(id: string): Promise<DungeonRecord[]> {
  return parseJson(await fetch(`/api/documents/${encodeURIComponent(id)}/companions`, { credentials: 'include' }));
}

export async function saveCompanion(
  id: string,
  input: { kind: 'outline' | 'canon' | 'claims' | 'quality'; title: string; text: string },
): Promise<DungeonRecord> {
  return parseJson(
    await fetch(`/api/documents/${encodeURIComponent(id)}/companions`, {
      method: 'POST',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: JSON.stringify(input),
    }),
  );
}

export async function commissionDocument(
  id: string,
  input: { operation: string; instruction: string; fileIds: string[]; expectedRevision: number },
): Promise<{ jobId: string; document: WritingDocument }> {
  return parseJson(
    await fetch(`/api/documents/${encodeURIComponent(id)}/commission`, {
      method: 'POST',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: JSON.stringify(input),
    }),
  );
}

export async function scanOsint(projectId: string, kind: string, value: string): Promise<{
  target: DungeonRecord;
  findings: DungeonRecord[];
  dossier?: DungeonRecord;
}> {
  return parseJson(
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/osint/scans`, {
      method: 'POST',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: JSON.stringify({ kind, value }),
    }),
  );
}

export async function listOsintTargets(projectId: string): Promise<DungeonRecord[]> {
  return parseJson(
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/osint/targets`, { credentials: 'include' }),
  );
}

export async function listCases(projectId: string): Promise<DungeonRecord[]> {
  return parseJson(await fetch(`/api/projects/${encodeURIComponent(projectId)}/cases`, { credentials: 'include' }));
}

export async function createCase(projectId: string, input: { title: string; question: string; findingIds: string[] }): Promise<DungeonRecord> {
  return parseJson(
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/cases`, {
      method: 'POST',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: JSON.stringify(input),
    }),
  );
}

export async function challengeCase(id: string, stance: 'advocate' | 'challenger' | 'arbiter'): Promise<DungeonRecord> {
  return parseJson(
    await fetch(`/api/cases/${encodeURIComponent(id)}/challenge`, {
      method: 'POST',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: JSON.stringify({ stance }),
    }),
  );
}

export interface InvestigationViews {
  timeline: {
    caseId: string;
    groups: Array<{
      date: string;
      items: Array<{ id: string; description: string; epistemicClass: string; occurredAt: string | null }>;
    }>;
    threads: Array<{ id: string; title: string; turns: Array<{ speaker: string; text: string; epistemicClass: string }> }>;
  };
  network: {
    caseId: string;
    nodes: Array<{ id: string; canonicalName: string; kind: string; status: string }>;
    edges: Array<{ id: string; fromId: string; toId: string; kind: string; epistemicClass: string }>;
    aliasCandidates: Array<{ id: string; surface: string; status: string; confidence: number }>;
  };
  matrix: {
    caseId: string;
    claims: Array<{ id: string; statement: string; kind: string }>;
    cells: Array<{ claimId: string; evidenceId: string; role: string }>;
    unmappedEvidenceIds: string[];
    unsupportedClaimIds: string[];
  };
  relations: Array<{ kind: string; statement: string; epistemicClass: string }>;
  gaps: Array<{ kind: string; statement: string }>;
  hypothesisTests: Array<{ id: string; result: string; gap: string | null }>;
}

export async function getCaseViews(id: string): Promise<InvestigationViews> {
  return parseJson(await fetch(`/api/cases/${encodeURIComponent(id)}/views`, { credentials: 'include' }));
}

export interface DoctorReport {
  state: string;
  checks: Array<{ id: string; state: string; summary: string }>;
  proposals: Array<{ id: string; title: string; repairClass: string }>;
  notes: Array<{ kind: string; summary: string }>;
}

export interface RepairExecution {
  proposalId: string;
  status: string;
  authorityDecision: string;
}

export async function getDoctorReport(): Promise<DoctorReport> {
  return parseJson(await fetch('/api/ops/doctor', { credentials: 'include' }));
}

export async function applyRepair(proposalId: string): Promise<RepairExecution> {
  return parseJson(
    await fetch(`/api/ops/repairs/${encodeURIComponent(proposalId)}/apply`, {
      method: 'POST',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: '{}',
    }),
  );
}

export async function listResearch(projectId: string): Promise<DungeonRecord[]> {
  return parseJson(await fetch(`/api/projects/${encodeURIComponent(projectId)}/research`, { credentials: 'include' }));
}

export async function createResearch(projectId: string, question: string, fileIds: string[]): Promise<DungeonRecord> {
  return parseJson(
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/research`, {
      method: 'POST',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: JSON.stringify({ question, fileIds }),
    }),
  );
}

export async function runResearch(id: string): Promise<{ brief: DungeonRecord; synthesis: DungeonRecord }> {
  return parseJson(
    await fetch(`/api/research/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: '{}',
    }),
  );
}

export async function listSites(projectId: string): Promise<Array<{ id: string; name: string; currentRevisionId: string | null }>> {
  return parseJson(await fetch(`/api/projects/${encodeURIComponent(projectId)}/sites`, { credentials: 'include' }));
}

export async function createSite(projectId: string, name: string, brief: string): Promise<{ id: string; name: string }> {
  return parseJson(
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/sites`, {
      method: 'POST',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: JSON.stringify({ name, brief }),
    }),
  );
}

export async function generateSite(id: string, brief: string): Promise<{ site: { id: string }; html: string }> {
  return parseJson(
    await fetch(`/api/sites/${encodeURIComponent(id)}/generate`, {
      method: 'POST',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: JSON.stringify({ brief }),
    }),
  );
}

export async function previewSiteHtml(id: string): Promise<string> {
  const response = await fetch(`/api/sites/${encodeURIComponent(id)}/preview`, { credentials: 'include' });
  if (!response.ok) {
    const error = new Error(await readError(response)) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return response.text();
}

export async function promoteSite(id: string): Promise<unknown> {
  return parseJson(
    await fetch(`/api/sites/${encodeURIComponent(id)}/promote`, {
      method: 'POST',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: '{}',
    }),
  );
}

export async function listCompositions(projectId: string): Promise<DungeonRecord[]> {
  return parseJson(
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/compositions`, { credentials: 'include' }),
  );
}

export async function createComposition(projectId: string, title: string, brief: string): Promise<DungeonRecord> {
  return parseJson(
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/compositions`, {
      method: 'POST',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: JSON.stringify({ title, brief }),
    }),
  );
}

export async function composeMusic(id: string): Promise<DungeonRecord> {
  return parseJson(
    await fetch(`/api/compositions/${encodeURIComponent(id)}/compose`, {
      method: 'POST',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: '{}',
    }),
  );
}

export async function getEffectivePolicy(dungeon?: string): Promise<EffectivePolicyView> {
  const suffix = dungeon ? `?dungeon=${encodeURIComponent(dungeon)}` : '';
  return parseJson(await fetch(`/api/privacy/effective${suffix}`, { credentials: 'include' }));
}

export async function explainPolicy(input: { action: string; capability: string; dungeonId?: string | null }): Promise<PolicyExplanation> {
  return parseJson(
    await fetch('/api/privacy/explain', {
      method: 'POST',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: JSON.stringify(input),
    }),
  );
}

export async function updatePolicy(input: {
  dungeonId?: string | null;
  patch: Record<string, unknown>;
  confirm?: string;
  expectedRevision?: number;
}): Promise<EffectivePolicyView['policy']> {
  return parseJson(
    await fetch('/api/privacy/policy', {
      method: 'POST',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: JSON.stringify(input),
    }),
  );
}

export async function listPrivacyAudit(): Promise<Array<{ id: string; action: string; reasonCode: string; stepUp: boolean; at: string }>> {
  return parseJson(await fetch('/api/privacy/audit', { credentials: 'include' }));
}

export async function listPrivacyProposals(): Promise<Array<{ id: string; status: string; patch: Record<string, unknown> }>> {
  return parseJson(await fetch('/api/privacy/proposals', { credentials: 'include' }));
}

export async function decidePrivacyProposal(id: string, status: 'approved' | 'denied'): Promise<unknown> {
  return parseJson(
    await fetch(`/api/privacy/proposals/${encodeURIComponent(id)}/decide`, {
      method: 'POST',
      credentials: 'include',
      headers: mutatingHeaders(),
      body: JSON.stringify({ status }),
    }),
  );
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const event = decodeFrame(chunk);
      if (event) yield event;
    }
    if (done) {
      const event = decodeFrame(buffer);
      if (event) yield event;
      break;
    }
  }
}

function decodeFrame(chunk: string): StreamEvent | null {
  let type = '';
  let data = '';
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event: ')) type = line.slice(7).trim();
    if (line.startsWith('data: ')) data += line.slice(6);
  }
  if (!data) return null;
  const parsed: unknown = JSON.parse(data);
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as StreamEvent;
  if (!('type' in record) && type) return { ...(record as object), type } as StreamEvent;
  return record;
}
