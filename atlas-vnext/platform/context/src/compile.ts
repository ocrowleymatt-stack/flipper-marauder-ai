import {
  contextCompileRequestSchema,
  type CompiledContextItem,
  type CompiledOmittedItem,
  type CompiledWorkingSet,
  type ContextCompileRequest,
} from '@atlas-vnext/contracts';
import { estimateTokens } from '@atlas-vnext/files';

/**
 * Builds a bounded working set for a model invocation.
 * Durable history stays in Projects/CAS/retrieval; this compiler never dumps
 * an entire conversation or evidence estate into a prompt.
 */
export class ContextCompiler {
  compile(request: ContextCompileRequest): CompiledWorkingSet {
    const parsed = contextCompileRequestSchema.parse(request);
    const omitted: CompiledOmittedItem[] = [];
    const candidates: CompiledContextItem[] = [];

    const policyText = policyToText(parsed.policy);

    candidates.push(
      item('objective', 'objective', parsed.objective, 'task_objective', null),
    );

    if (policyText) {
      candidates.push(item('policy', 'policy', policyText, 'policy_constraint', null));
    }

    const structured = serialiseIfPresent(parsed.structuredState);
    if (structured) {
      candidates.push(
        item('structured-state', 'structured_state', structured, 'structured_state', null),
      );
    }

    for (const [index, entry] of (parsed.evidence ?? []).entries()) {
      if (!entry.content.trim()) {
        omitted.push({ id: evidenceId(entry.id, index), reason: 'empty' });
        continue;
      }
      candidates.push(
        item(
          evidenceId(entry.id, index),
          'evidence',
          entry.content,
          'task_evidence',
          entry.sourceRef ?? null,
        ),
      );
    }

    for (const [index, entry] of (parsed.history ?? []).entries()) {
      const id = historyId(entry.id, entry.attemptId, index);
      const dropped = failedAttemptReason(entry);
      const explicitlyRequested =
        Boolean(parsed.attemptId) && entry.attemptId === parsed.attemptId;
      if (dropped && !explicitlyRequested) {
        omitted.push({ id, reason: dropped });
        continue;
      }
      const content = entry.content?.trim() ? entry.content : '';
      if (!content) {
        omitted.push({ id, reason: 'empty' });
        continue;
      }
      candidates.push(
        item(
          id,
          'history',
          content,
          explicitlyRequested ? 'requested_attempt' : 'recent_history',
          entry.attemptId ?? null,
        ),
      );
    }

    const output = serialiseIfPresent(parsed.outputContract);
    if (output) {
      candidates.push(
        item('output-contract', 'output_contract', output, 'output_contract', null),
      );
    }

    const items: CompiledContextItem[] = [];
    let tokenCount = 0;
    let truncated = parsed.tokenBudget <= 0;

    for (const candidate of candidates) {
      const remaining = parsed.tokenBudget - tokenCount;
      if (remaining <= 0) {
        truncated = true;
        omitted.push({ id: candidate.id, reason: 'token_budget' });
        continue;
      }
      const cost = (content: string) => estimateTokens(content) + (candidate.kind === 'objective' ? estimateTokens(content) : candidate.kind === 'policy' ? estimateTokens(excerpt(content)) : 0);
      if (cost(candidate.content) <= remaining) {
        items.push(candidate);
        tokenCount += cost(candidate.content);
        continue;
      }
      const fitted = fitToBudget(candidate.content, remaining, cost);
      if (!fitted) {
        truncated = true;
        omitted.push({ id: candidate.id, reason: 'token_budget' });
        continue;
      }
      truncated = true;
      const next = { ...candidate, content: fitted, tokenCost: estimateTokens(fitted) };
      items.push(next);
      tokenCount += cost(next.content);
    }

    const keptObjective = items.find((entry) => entry.kind === 'objective');
    const keptPolicy = items.find((entry) => entry.kind === 'policy');
    return {
      objective: keptObjective?.content ?? '',
      policyExcerpt: keptPolicy ? excerpt(keptPolicy.content) : '',
      items,
      tokenCount,
      tokenBudget: parsed.tokenBudget,
      truncated,
      omitted,
    };
  }
}

function item(
  id: string,
  kind: CompiledContextItem['kind'],
  content: string,
  inclusionReason: string,
  sourceRef: string | null,
): CompiledContextItem {
  return {
    id,
    kind,
    tokenCost: estimateTokens(content),
    inclusionReason,
    content,
    sourceRef,
  };
}

function evidenceId(id: string | undefined, index: number): string {
  return id ? `evidence:${id}` : `evidence:${index}`;
}

function historyId(id: string | undefined, attemptId: string | undefined, index: number): string {
  if (id) return `history:${id}`;
  if (attemptId) return `history:${attemptId}`;
  return `history:${index}`;
}

function failedAttemptReason(entry: {
  status?: string;
  irrelevant?: boolean;
}): string | null {
  if (entry.irrelevant === true) return 'irrelevant';
  if (entry.status === 'failed') return 'failed_attempt';
  return null;
}

function policyToText(policy: ContextCompileRequest['policy']): string | null {
  if (policy === undefined) return null;
  if (typeof policy === 'string') return policy.trim() ? policy : null;
  if (typeof policy.excerpt === 'string' && policy.excerpt.trim()) return policy.excerpt;
  if (typeof policy.text === 'string' && policy.text.trim()) return policy.text;
  const serialised = stableStringify(policy);
  return serialised === '{}' ? null : serialised;
}

function serialiseIfPresent(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.trim() ? value : null;
  if (Array.isArray(value)) return value.length ? stableStringify(value) : null;
  if (typeof value === 'object') {
    const serialised = stableStringify(value);
    return serialised === '{}' ? null : serialised;
  }
  return String(value);
}

function excerpt(text: string, max = 240): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

/** Fit content under remaining tokens. estimateTokens is ceil(chars/4) and never 0 for non-empty text. */
function fitToBudget(text: string, remaining: number, cost: (text: string) => number): string | null {
  if (remaining <= 0) return null;
  if (cost(text) <= remaining) return text;
  let lo = 1;
  let hi = text.length;
  let best: string | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = `${text.slice(0, mid)}…`;
    if (cost(candidate) <= remaining) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
