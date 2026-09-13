import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  AuditEntry,
  AuditEntryInput,
  LedgerVerificationResult,
  PolicyDecision,
  PolicyEvaluationRequest,
  PolicyEffect,
} from '@atlas/core-contracts';

// ============================================================================
// 1. Policy Engine Implementation
// ============================================================================

export interface CapabilityRule {
  readonly id: string;
  readonly description: string;
  readonly priority: number;
  readonly effect: PolicyEffect;
  matches(request: PolicyEvaluationRequest): boolean;
}

export class CapabilityPolicyEngine {
  readonly #rules: readonly CapabilityRule[];

  constructor(rules: readonly CapabilityRule[]) {
    const ids = new Set<string>();
    for (const rule of rules) {
      if (ids.has(rule.id)) {
        throw new Error(`Duplicate policy rule id: ${rule.id}`);
      }
      ids.add(rule.id);
    }
    // High priority first; tie-break deterministically on rule ID
    this.#rules = [...rules].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  }

  evaluate(request: PolicyEvaluationRequest): PolicyDecision {
    const matched = this.#rules.filter((rule) => rule.matches(request));

    // Deny-override: explicit deny takes immediate precedence
    const deny = matched.find((rule) => rule.effect === 'deny');
    if (deny) {
      return {
        allowed: false,
        matchedRuleIds: matched.map((r) => r.id),
        decisiveRuleId: deny.id,
        reason: deny.description,
      };
    }

    // Explicit allow
    const allow = matched.find((rule) => rule.effect === 'allow');
    if (allow) {
      return {
        allowed: true,
        matchedRuleIds: matched.map((r) => r.id),
        decisiveRuleId: allow.id,
        reason: allow.description,
      };
    }

    // Default-deny
    return {
      allowed: false,
      matchedRuleIds: [],
      reason: 'Default-deny: no explicit permission rule matched this request.',
    };
  }
}

// ============================================================================
// 2. Tamper-Evident Hash-Chained Audit Ledger
// ============================================================================

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashAuditEntry(entry: Omit<AuditEntry, 'hash'>): string {
  return createHash('sha256').update(canonicalJson(entry)).digest('hex');
}

export class TamperEvidentAuditLedger {
  readonly #entries: AuditEntry[] = [];

  append(input: AuditEntryInput): AuditEntry {
    const sequence = this.#entries.length + 1;
    const previousHash = this.#entries.at(-1)?.hash ?? 'GENESIS_BLOCK';
    const unsigned: Omit<AuditEntry, 'hash'> = {
      ...input,
      sequence,
      previousHash,
    };
    const hash = hashAuditEntry(unsigned);
    const entry: AuditEntry = { ...unsigned, hash };
    this.#entries.push(entry);
    return structuredClone(entry);
  }

  getEntries(): readonly AuditEntry[] {
    return structuredClone(this.#entries);
  }

  verify(): LedgerVerificationResult {
    let previousHash = 'GENESIS_BLOCK';
    for (const entry of this.#entries) {
      const { hash, ...unsigned } = entry;
      const expected = hashAuditEntry(unsigned);
      const isHashMatch =
        expected.length === hash.length &&
        timingSafeEqual(Buffer.from(expected), Buffer.from(hash));

      if (!isHashMatch || entry.previousHash !== previousHash) {
        return {
          valid: false,
          brokenAt: entry.sequence,
          totalEntries: this.#entries.length,
        };
      }
      previousHash = hash;
    }
    return {
      valid: true,
      totalEntries: this.#entries.length,
    };
  }
}
