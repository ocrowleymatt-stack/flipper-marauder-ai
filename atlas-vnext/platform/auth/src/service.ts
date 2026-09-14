import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  DEFAULT_OPERATIONAL_LIMITS,
  type SessionRecord,
  type TenantMembership,
  type WorkspaceMembership,
} from '@atlas-vnext/contracts';
import { logPlatform } from '@atlas-vnext/observability';
import { AuthenticationError, CsrfError, OriginError, SessionRevokedError } from './errors.ts';
import { guestPrincipal, systemPrincipal, userPrincipal, type AuthActor } from './principal.ts';

export interface DirectoryStore {
  getTenantMembership(principalId: string, tenantId: string): Promise<TenantMembership | null>;
  listTenantMemberships(principalId: string): Promise<TenantMembership[]>;
  getWorkspaceMembership(
    principalId: string,
    tenantId: string,
    workspaceId: string,
  ): Promise<WorkspaceMembership | null>;
  putTenantMembership(row: TenantMembership): Promise<TenantMembership>;
  putWorkspaceMembership(row: WorkspaceMembership): Promise<WorkspaceMembership>;
}

export interface SessionStore {
  insert(record: SessionRecord): Promise<SessionRecord>;
  get(id: string): Promise<SessionRecord | null>;
  save(record: SessionRecord): Promise<SessionRecord>;
  listByPrincipal(principalId: string): Promise<SessionRecord[]>;
}

export interface AuthClock {
  now(): string;
  nowMs(): number;
}

export interface AuthServiceOptions {
  sessions: SessionStore;
  directory: DirectoryStore;
  clock?: AuthClock;
  sessionTtlMs?: number;
  cookieName?: string;
  csrfHeader?: string;
  allowedOrigins?: string[];
  production?: boolean;
  secret?: string;
}

const defaultClock: AuthClock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

export class MemoryDirectoryStore implements DirectoryStore {
  private readonly tenants = new Map<string, TenantMembership>();
  private readonly workspaces = new Map<string, WorkspaceMembership>();

  async getTenantMembership(principalId: string, tenantId: string): Promise<TenantMembership | null> {
    return this.tenants.get(`${principalId}::${tenantId}`) ?? null;
  }
  async listTenantMemberships(principalId: string): Promise<TenantMembership[]> {
    return [...this.tenants.values()].filter((row) => row.principalId === principalId);
  }
  async getWorkspaceMembership(
    principalId: string,
    tenantId: string,
    workspaceId: string,
  ): Promise<WorkspaceMembership | null> {
    return this.workspaces.get(`${principalId}::${tenantId}::${workspaceId}`) ?? null;
  }
  async putTenantMembership(row: TenantMembership): Promise<TenantMembership> {
    this.tenants.set(`${row.principalId}::${row.tenantId}`, row);
    return row;
  }
  async putWorkspaceMembership(row: WorkspaceMembership): Promise<WorkspaceMembership> {
    this.workspaces.set(`${row.principalId}::${row.tenantId}::${row.workspaceId}`, row);
    return row;
  }
}

export class MemorySessionStore implements SessionStore {
  private readonly rows = new Map<string, SessionRecord>();
  async insert(record: SessionRecord): Promise<SessionRecord> {
    this.rows.set(record.id, record);
    return record;
  }
  async get(id: string): Promise<SessionRecord | null> {
    return this.rows.get(id) ?? null;
  }
  async save(record: SessionRecord): Promise<SessionRecord> {
    this.rows.set(record.id, record);
    return record;
  }
  async listByPrincipal(principalId: string): Promise<SessionRecord[]> {
    return [...this.rows.values()].filter((row) => row.principalId === principalId);
  }
}

export interface ResolvedAuth {
  actor: AuthActor;
  session: SessionRecord | null;
  csrfToken?: string;
}

export class AuthService {
  readonly cookieName: string;
  readonly csrfHeader: string;
  private readonly clock: AuthClock;
  private readonly ttl: number;
  private readonly allowedOrigins: string[];
  private readonly production: boolean;
  private readonly signingSecret: string | undefined;

  constructor(private readonly options: AuthServiceOptions) {
    this.clock = options.clock ?? defaultClock;
    this.ttl = options.sessionTtlMs ?? DEFAULT_OPERATIONAL_LIMITS.sessionTtlMs;
    this.cookieName = options.cookieName ?? 'atlas_session';
    this.csrfHeader = options.csrfHeader ?? 'x-atlas-csrf';
    this.allowedOrigins = options.allowedOrigins ?? [];
    this.production = options.production ?? false;
    this.signingSecret = options.secret;
    if (this.production && !this.signingSecret) {
      throw new AuthenticationError(
        'secret_infra_missing',
        'Fail-closed: production authentication requires a session signing secret.',
      );
    }
  }

  async issueSession(input: {
    principalId: string;
    tenantId: string;
    kind?: 'user' | 'guest' | 'system';
    userAgent?: string;
  }): Promise<{ session: SessionRecord; csrfToken: string }> {
    if (input.kind !== 'system') {
      const membership = await this.options.directory.getTenantMembership(input.principalId, input.tenantId);
      if (!membership) {
        throw new AuthenticationError('not_a_member', 'Fail-closed: principal is not a member of the tenant.');
      }
    }
    const now = this.clock.now();
    const csrfSecret = randomBytes(32).toString('hex');
    const session: SessionRecord = {
      id: `ses_${randomBytes(16).toString('hex')}`,
      principalId: input.principalId,
      tenantId: input.tenantId,
      csrfSecret,
      createdAt: now,
      expiresAt: new Date(this.clock.nowMs() + this.ttl).toISOString(),
      rotatedAt: null,
      revokedAt: null,
      lastSeenAt: now,
      userAgentHash: input.userAgent ? hashOpaque(input.userAgent) : null,
    };
    await this.options.sessions.insert(session);
    logPlatform('auth.session.issued', {
      principalId: input.principalId,
      tenantId: input.tenantId,
      sessionId: session.id,
    });
    return { session, csrfToken: this.csrfToken(session) };
  }

  async resolve(input: {
    sessionId?: string | null;
    csrfToken?: string | null;
    origin?: string | null;
    mutating: boolean;
    claimedTenantId?: string | null;
    allowGuest?: boolean;
    system?: boolean;
  }): Promise<ResolvedAuth> {
    if (input.system) {
      return { actor: toSystemActor(), session: null };
    }
    if (!input.sessionId) {
      if (input.allowGuest && !this.production) {
        const guest = guestPrincipal();
        return {
          actor: {
            principalId: guest.id,
            kind: 'guest',
            tenantId: null,
            workspaceId: null,
            sessionId: null,
          },
          session: null,
        };
      }
      throw new AuthenticationError('unauthenticated', 'Authentication required.');
    }
    const session = await this.options.sessions.get(input.sessionId);
    if (!session) throw new AuthenticationError('unauthenticated', 'Authentication required.');
    if (session.revokedAt) throw new SessionRevokedError();
    if (Date.parse(session.expiresAt) <= this.clock.nowMs()) {
      throw new SessionRevokedError('Session expired.');
    }
    if (input.mutating) {
      this.assertOrigin(input.origin);
      this.assertCsrf(session, input.csrfToken);
    }
    if (input.claimedTenantId && input.claimedTenantId !== session.tenantId) {
      throw new AuthenticationError(
        'claimed_tenant_ignored',
        'Fail-closed: caller tenant id is not membership.',
      );
    }
    if (!session.tenantId) {
      throw new AuthenticationError('not_a_member', 'Fail-closed: session has no tenant membership.');
    }
    const membership = await this.options.directory.getTenantMembership(session.principalId, session.tenantId);
    if (!membership) {
      throw new AuthenticationError('not_a_member', 'Fail-closed: principal is not a member of the tenant.');
    }
    session.lastSeenAt = this.clock.now();
    await this.options.sessions.save(session);
    const principal = userPrincipal({
      id: session.principalId,
      tenantId: session.tenantId,
      sessionId: session.id,
    });
    return {
      actor: {
        principalId: principal.id,
        kind: 'user',
        tenantId: session.tenantId,
        sessionId: session.id,
        roles: [membership.role],
      },
      session,
      csrfToken: this.csrfToken(session),
    };
  }

  async rotate(sessionId: string): Promise<{ session: SessionRecord; csrfToken: string }> {
    const session = await this.requireActive(sessionId);
    const next: SessionRecord = {
      ...session,
      csrfSecret: randomBytes(32).toString('hex'),
      rotatedAt: this.clock.now(),
      expiresAt: new Date(this.clock.nowMs() + this.ttl).toISOString(),
      lastSeenAt: this.clock.now(),
    };
    await this.options.sessions.save(next);
    logPlatform('auth.session.rotated', { sessionId: next.id, principalId: next.principalId });
    return { session: next, csrfToken: this.csrfToken(next) };
  }

  async revoke(sessionId: string): Promise<SessionRecord> {
    const session = await this.options.sessions.get(sessionId);
    if (!session) throw new AuthenticationError('unauthenticated', 'Authentication required.');
    const next = { ...session, revokedAt: this.clock.now(), lastSeenAt: this.clock.now() };
    await this.options.sessions.save(next);
    logPlatform('auth.session.revoked', { sessionId, principalId: session.principalId });
    return next;
  }

  async revokeAll(principalId: string): Promise<number> {
    const rows = await this.options.sessions.listByPrincipal(principalId);
    let count = 0;
    for (const row of rows) {
      if (row.revokedAt) continue;
      await this.options.sessions.save({ ...row, revokedAt: this.clock.now() });
      count += 1;
    }
    return count;
  }

  cookieHeader(sessionId: string, secure = this.production): string {
    const parts = [
      `${this.cookieName}=${sessionId}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(this.ttl / 1000)}`,
    ];
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }

  parseCookie(header: string | undefined, name = this.cookieName): string | null {
    if (!header) return null;
    for (const part of header.split(';')) {
      const [rawKey, ...rest] = part.trim().split('=');
      if (rawKey === name) return rest.join('=') || null;
    }
    return null;
  }

  csrfToken(session: SessionRecord): string {
    const secret = this.signingSecret ?? session.csrfSecret;
    return createHmac('sha256', secret).update(`${session.id}:${session.csrfSecret}`).digest('hex');
  }

  private async requireActive(sessionId: string): Promise<SessionRecord> {
    const session = await this.options.sessions.get(sessionId);
    if (!session || session.revokedAt) throw new SessionRevokedError();
    if (Date.parse(session.expiresAt) <= this.clock.nowMs()) throw new SessionRevokedError('Session expired.');
    return session;
  }

  private assertCsrf(session: SessionRecord, token: string | null | undefined): void {
    if (!token) throw new CsrfError();
    const expected = this.csrfToken(session);
    const a = Buffer.from(expected);
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new CsrfError();
  }

  private assertOrigin(origin: string | null | undefined): void {
    if (this.allowedOrigins.length === 0) return;
    if (!origin) throw new OriginError();
    if (!this.allowedOrigins.includes(origin)) throw new OriginError();
  }
}

function toSystemActor(): AuthActor {
  const principal = systemPrincipal();
  return {
    principalId: principal.id,
    kind: 'system',
    tenantId: principal.tenantId,
    sessionId: null,
    roles: ['system'],
  };
}

function hashOpaque(value: string): string {
  return createHmac('sha256', 'atlas-ua').update(value).digest('hex');
}

export class BruteForceGuard {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly limit = 20,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  hit(key: string): { allowed: boolean; remaining: number } {
    const now = this.now();
    const row = this.hits.get(key);
    if (!row || row.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, remaining: this.limit - 1 };
    }
    row.count += 1;
    if (row.count > this.limit) return { allowed: false, remaining: 0 };
    return { allowed: true, remaining: this.limit - row.count };
  }
}
