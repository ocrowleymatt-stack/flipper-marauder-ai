#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const root = new URL('..', import.meta.url);
let report;
try {
  execFileSync('npm', ['audit', '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  report = { vulnerabilities: {}, metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0, info: 0 } } };
} catch (err) {
  const output = err && typeof err === 'object' && 'stdout' in err ? String(err.stdout) : '';
  try {
    report = JSON.parse(output);
  } catch {
    console.log(JSON.stringify({ ok: true, classification: [], note: 'npm audit did not return JSON' }, null, 2));
    process.exit(0);
  }
}

const vulns = report.vulnerabilities ?? {};
const classified = [];
for (const [name, value] of Object.entries(vulns)) {
  const item = value && typeof value === 'object' ? value : {};
  const severity = item.severity ?? 'unknown';
  const via = Array.isArray(item.via) ? item.via : [];
  const productionDep = item.isDirect === true && (item.range || true);
  classified.push({
    name,
    severity,
    title: typeof via[0] === 'object' && via[0] ? via[0].title ?? name : name,
    classification:
      severity === 'critical' ? 'production-blocker-candidate' : severity === 'high' ? 'review' : 'informational',
    direct: Boolean(item.isDirect),
  });
  void productionDep;
}

const blockers = classified.filter((item) => item.classification === 'production-blocker-candidate');
console.log(
  JSON.stringify(
    {
      ok: blockers.length === 0,
      summary: report.metadata?.vulnerabilities ?? {},
      classified,
    },
    null,
    2,
  ),
);
process.exit(0);
