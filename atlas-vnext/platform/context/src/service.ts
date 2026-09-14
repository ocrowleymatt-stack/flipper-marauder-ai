import type { PersistenceActor, PlatformPersistence, ChunkRecord, FileRecord } from '@atlas-vnext/persistence';
import { OwnershipError } from '@atlas-vnext/persistence';
import { estimateTokens } from '@atlas-vnext/files';

export interface ContextSlice {
  chunkId: string;
  fileId: string;
  path: string;
  text: string;
  locator: ChunkRecord['locator'];
  score: number;
  truncated: boolean;
  source: 'attachment' | 'retrieval';
  contentHash: string;
}

export interface Citation {
  chunkId: string | null;
  fileId: string | null;
  path: string | null;
  locator: ChunkRecord['locator'] | null;
  quote: string | null;
  confidence: 'sourced' | 'unknown';
  note?: string;
}

export interface AssembledContext {
  slices: ContextSlice[];
  citations: Citation[];
  truncated: boolean;
  tokenCount: number;
  tokenBudget: number;
}

export interface AssembleRequest {
  projectId: string;
  query: string;
  tokenBudget: number;
  conversationId?: string;
  attachmentFileIds?: string[];
  maxSlices?: number;
}

export class ContextService {
  constructor(private readonly persistence: PlatformPersistence) {}

  async search(
    actor: PersistenceActor,
    projectId: string,
    query: string,
    limit = 20,
  ): Promise<Array<ChunkRecord & { rank: number; file: FileRecord | null }>> {
    const scoped = this.actor(actor, 'search');
    const bound = this.persistence.forActor(scoped);
    const workspace = await bound.workspaces.get(scoped, projectId);
    if (!workspace) throw new OwnershipError(`Fail-closed: project ${projectId} is not visible.`);
    const hits = await bound.chunks.search(scoped, projectId, query, limit);
    const files = new Map(
      (await bound.files.list(scoped, projectId)).map((file) => [file.id, file] as const),
    );
    return hits
      .filter((hit) => files.get(hit.fileId) && !files.get(hit.fileId)?.deletedAt)
      .map((hit) => ({ ...hit, file: files.get(hit.fileId) ?? null }));
  }

  async assemble(actor: PersistenceActor, request: AssembleRequest): Promise<AssembledContext> {
    const scoped = this.actor(actor, 'assemble context');
    const bound = this.persistence.forActor(scoped);
    const workspace = await bound.workspaces.get(scoped, request.projectId);
    if (!workspace) throw new OwnershipError(`Fail-closed: project ${request.projectId} is not visible.`);
    if (request.tokenBudget <= 0) {
      return { slices: [], citations: [], truncated: true, tokenCount: 0, tokenBudget: request.tokenBudget };
    }

    const attachmentIds = new Set(request.attachmentFileIds ?? []);
    if (request.conversationId) {
      const attachments = await bound.attachments.listByConversation(scoped, request.conversationId);
      for (const attachment of attachments) attachmentIds.add(attachment.fileId);
    }

    const ranked = await this.search(scoped, request.projectId, request.query, 50);
    const attachmentFirst = [
      ...ranked.filter((hit) => attachmentIds.has(hit.fileId)),
      ...ranked.filter((hit) => !attachmentIds.has(hit.fileId)),
    ];

    const slices: ContextSlice[] = [];
    let tokens = 0;
    let truncated = false;
    const maxSlices = request.maxSlices ?? 12;
    for (const hit of attachmentFirst) {
      if (slices.length >= maxSlices) {
        truncated = true;
        break;
      }
      const remaining = request.tokenBudget - tokens;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const hitTokens = estimateTokens(hit.text);
      let text = hit.text;
      let sliceTruncated = false;
      if (hitTokens > remaining) {
        const charBudget = Math.max(16, remaining * 4);
        text = `${hit.text.slice(0, charBudget)}…`;
        sliceTruncated = true;
        truncated = true;
      }
      tokens += estimateTokens(text);
      slices.push({
        chunkId: hit.id,
        fileId: hit.fileId,
        path: hit.locator.path,
        text,
        locator: hit.locator,
        score: hit.rank,
        truncated: sliceTruncated,
        source: attachmentIds.has(hit.fileId) ? 'attachment' : 'retrieval',
        contentHash: hit.contentHash,
      });
    }
    if (attachmentFirst.length > slices.length) truncated = true;

    return {
      slices,
      citations: slices.map((slice) => this.citationFromSlice(slice)),
      truncated,
      tokenCount: tokens,
      tokenBudget: request.tokenBudget,
    };
  }

  cite(claim: string, slices: ContextSlice[]): Citation {
    const needle = claim.trim();
    if (!needle) {
      return {
        chunkId: null,
        fileId: null,
        path: null,
        locator: null,
        quote: null,
        confidence: 'unknown',
        note: 'Empty claim; no source selected.',
      };
    }
    const hit = slices.find((slice) => slice.text.toLowerCase().includes(needle.toLowerCase()));
    if (!hit) {
      return {
        chunkId: null,
        fileId: null,
        path: null,
        locator: null,
        quote: null,
        confidence: 'unknown',
        note: 'No assembled slice contains this claim; the system will not fabricate a source.',
      };
    }
    return this.citationFromSlice(hit, needle);
  }

  private citationFromSlice(slice: ContextSlice, quote?: string): Citation {
    return {
      chunkId: slice.chunkId,
      fileId: slice.fileId,
      path: slice.path,
      locator: slice.locator,
      quote: quote ?? slice.text.slice(0, 240),
      confidence: 'sourced',
    };
  }

  private actor(actor: PersistenceActor, action: string): PersistenceActor {
    if (!actor.tenantId?.trim()) {
      throw new OwnershipError(`Fail-closed: cannot ${action} without a tenant id.`);
    }
    return actor;
  }
}
