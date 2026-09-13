/**
 * Evaluation harness (placeholder).
 *
 * Suites become real as dungeons and retrieval land. Each folder must keep a
 * README stating the oracle, fixtures, and pass/fail rule. Do not hide evals
 * inside Nexus.
 */
export const EVAL_SUITES = [
  'route-selection',
  'provider-failover',
  'retrieval',
  'citations',
  'writing',
  'code-tasks',
  'website-studio',
  'osint-orchestration',
  'contradiction-detection',
  'tool-selection',
] as const;

export type EvalSuiteName = (typeof EVAL_SUITES)[number];
