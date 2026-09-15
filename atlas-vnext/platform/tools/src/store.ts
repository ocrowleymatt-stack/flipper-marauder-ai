import type { ToolApproval, ToolInvocation, ToolInvocationStatus } from '@atlas-vnext/contracts';

export interface ToolActor {
  tenantId: string;
  principalId: string;
  workspaceId?: string | null;
}

export interface ToolInvocationStore {
  insert(record: ToolInvocation): Promise<ToolInvocation>;
  get(tenantId: string, id: string): Promise<ToolInvocation | null>;
  save(record: ToolInvocation, expected?: ToolInvocationStatus[]): Promise<ToolInvocation>;
  findByIdempotency(tenantId: string, key: string): Promise<ToolInvocation | null>;
  listByStatus(tenantId: string | null, statuses: ToolInvocationStatus[]): Promise<ToolInvocation[]>;
  listByConversation(tenantId: string, conversationId: string): Promise<ToolInvocation[]>;
  saveResult(tenantId: string, id: string, output: Record<string, unknown>): Promise<void>;
  getResult(tenantId: string, id: string): Promise<Record<string, unknown> | null>;
  saveEffect(tenantId: string, key: string, value: unknown): Promise<'recorded' | 'replayed'>;
}

export interface ToolApprovalStore {
  insert(record: ToolApproval): Promise<ToolApproval>;
  get(tenantId: string, id: string): Promise<ToolApproval | null>;
  getByInvocation(tenantId: string, invocationId: string): Promise<ToolApproval | null>;
  save(record: ToolApproval): Promise<ToolApproval>;
}

export class MemoryToolInvocationStore implements ToolInvocationStore {
  private readonly rows = new Map<string, ToolInvocation>();
  private readonly results = new Map<string, Record<string, unknown>>();
  private readonly effects = new Map<string, unknown>();

  async insert(record: ToolInvocation): Promise<ToolInvocation> {
    this.rows.set(record.id, clone(record));
    return clone(record);
  }
  async get(tenantId: string, id: string): Promise<ToolInvocation | null> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return null;
    return clone(row);
  }
  async save(record: ToolInvocation, expected?: ToolInvocationStatus[]): Promise<ToolInvocation> {
    const existing = this.rows.get(record.id);
    if (!existing || existing.tenantId !== record.tenantId) {
      throw new Error(`Fail-closed: tool invocation ${record.id} is not visible.`);
    }
    if (expected && !expected.includes(existing.status)) {
      throw new Error(`Fail-closed: expected status ${expected.join('|')}, found ${existing.status}.`);
    }
    this.rows.set(record.id, clone(record));
    return clone(record);
  }
  async findByIdempotency(tenantId: string, key: string): Promise<ToolInvocation | null> {
    for (const row of this.rows.values()) {
      if (row.tenantId === tenantId && row.idempotencyKey === key) return clone(row);
    }
    return null;
  }
  async listByStatus(tenantId: string | null, statuses: ToolInvocationStatus[]): Promise<ToolInvocation[]> {
    return [...this.rows.values()]
      .filter((row) => (!tenantId || row.tenantId === tenantId) && statuses.includes(row.status))
      .map(clone);
  }
  async listByConversation(tenantId: string, conversationId: string): Promise<ToolInvocation[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenantId === tenantId && row.conversationId === conversationId)
      .map(clone);
  }
  async saveResult(tenantId: string, id: string, output: Record<string, unknown>): Promise<void> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) throw new Error('Fail-closed: tool result is not visible.');
    this.results.set(id, clone(output));
  }
  async getResult(tenantId: string, id: string): Promise<Record<string, unknown> | null> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return null;
    const found = this.results.get(id);
    return found ? clone(found) : null;
  }
  async saveEffect(tenantId: string, key: string, value: unknown): Promise<'recorded' | 'replayed'> {
    const scoped = `${tenantId}::${key}`;
    if (this.effects.has(scoped)) return 'replayed';
    this.effects.set(scoped, clone(value));
    return 'recorded';
  }
}

export class MemoryToolApprovalStore implements ToolApprovalStore {
  private readonly rows = new Map<string, ToolApproval>();

  async insert(record: ToolApproval): Promise<ToolApproval> {
    this.rows.set(record.id, { ...record });
    return { ...record };
  }
  async get(tenantId: string, id: string): Promise<ToolApproval | null> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return null;
    return { ...row };
  }
  async getByInvocation(tenantId: string, invocationId: string): Promise<ToolApproval | null> {
    for (const row of this.rows.values()) {
      if (row.tenantId === tenantId && row.invocationId === invocationId) return { ...row };
    }
    return null;
  }
  async save(record: ToolApproval): Promise<ToolApproval> {
    this.rows.set(record.id, { ...record });
    return { ...record };
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
