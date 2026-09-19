import type { DungeonRecord } from './api';

export type ResultKind = 'osint' | 'research';

export interface ParsedFinding {
  id: string;
  title: string;
  source?: string;
  url?: string | null;
  status?: string;
  summary: string;
  epistemicKind?: string;
  confidence?: string;
  evidenceHash?: string | null;
}

export interface ParsedSource {
  title: string;
  url?: string;
  host?: string;
}

export interface ParsedResult {
  kind: ResultKind;
  headline: string;
  state: string;
  strongest?: string;
  findings: ParsedFinding[];
  sources: ParsedSource[];
  errors: string[];
}

const HASH_TAIL = /\s+hash=[a-f0-9]{8,}\b/gi;

export function stripPrimaryHashes(text: string): string {
  return text.replace(HASH_TAIL, '');
}

export function classifyAssistantResult(text: string): ParsedResult | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^OSINT\s+\w+\s+scan of/i.test(trimmed) || /Strongest public observations:/i.test(trimmed)) {
    return parseOsintReport(trimmed);
  }
  if (/^Researching:/i.test(trimmed) || /^## Sources inspected/m.test(trimmed)) {
    return parseResearchReport(trimmed);
  }
  return null;
}

export function parseOsintReport(text: string): ParsedResult {
  const headline = (text.split('\n')[0] ?? 'OSINT report').trim();
  const strongest = matchLine(text, /^Strongest finding:\s*(.+)$/im);
  const findings: ParsedFinding[] = [];
  const observationBlock = section(text, /Strongest public observations:/i, /^(Negative presence|Blocked\/error|Correlations|Specialist engine|This report)/im);
  for (const line of observationBlock) {
    const item = parseBullet(line);
    if (!item) continue;
    findings.push({
      id: slugId('osint', item.source ?? item.title, findings.length),
      title: item.title,
      source: item.source,
      url: item.url,
      summary: item.title,
      status: 'confirmed',
      epistemicKind: 'observation',
      confidence: 'confirmed',
      evidenceHash: item.hash,
    });
  }
  const errors: string[] = [];
  const blocked = matchLine(text, /^Blocked\/error\/rate-limited sources[^:]*:\s*(.+)$/im);
  if (blocked) errors.push(blocked);
  const negative = matchLine(text, /^Negative presence checks:\s*(.+)$/im);
  const state = strongest
    ? 'Findings ready'
    : /No confirmed public presence/i.test(text)
      ? 'No confirmed presence'
      : 'OSINT complete';
  return {
    kind: 'osint',
    headline,
    state,
    strongest: strongest ?? undefined,
    findings,
    sources: findings
      .filter((item) => item.url)
      .map((item) => ({ title: item.source ?? item.title, url: item.url ?? undefined })),
    errors: [negative ? `Negative: ${negative}` : '', ...errors].filter(Boolean),
  };
}

export function parseResearchReport(text: string): ParsedResult {
  const question = matchLine(text, /^Researching:\s*(.+)$/im) ?? 'Research';
  const strongest = matchLine(text, /^Strongest finding:\s*(.+)$/im);
  const sources: ParsedSource[] = [];
  for (const line of section(text, /^## Sources inspected/im, /^## /m)) {
    const md = line.match(/^\d+\.\s+\[([^\]]+)\]\(([^)]+)\)(?:\s+—\s+([^\s,]+))?/);
    if (md) {
      sources.push({ title: md[1]!, url: md[2], host: md[3] });
      continue;
    }
    const bullet = parseBullet(line);
    if (bullet) sources.push({ title: bullet.title, url: bullet.url ?? undefined });
  }
  const findings: ParsedFinding[] = [];
  for (const line of section(text, /^## Findings/im, /^## /m)) {
    const item = line.match(/^-\s+\*\*([^*]+)\*\*(?:\s+\(([^)]+)\))?/);
    if (!item) continue;
    findings.push({
      id: slugId('research', item[1]!, findings.length),
      title: item[1]!.trim(),
      summary: item[1]!.trim(),
      confidence: item[2]?.trim(),
      status: item[2]?.trim(),
      epistemicKind: 'observation',
    });
  }
  if (findings.length === 0) {
    for (const source of sources) {
      findings.push({
        id: slugId('research', source.title, findings.length),
        title: source.title,
        url: source.url,
        summary: source.title,
        status: 'sourced',
      });
    }
  } else {
    for (const finding of findings) {
      const match = sources.find((source) => source.title === finding.title);
      if (match) finding.url = match.url;
    }
  }
  return {
    kind: 'research',
    headline: `Research: ${question}`,
    state: sources.length ? `${sources.length} sources inspected` : 'Research complete',
    strongest: strongest && strongest !== 'none' ? strongest : undefined,
    findings,
    sources,
    errors: [],
  };
}

export function findingsFromRecords(records: DungeonRecord[]): ParsedFinding[] {
  return records
    .filter((row) => row.kind === 'finding' || row.payload.epistemicKind === 'observation')
    .map((row, index) => ({
      id: row.id || slugId('record', row.title, index),
      title: row.title,
      source: typeof row.payload.source === 'string' ? row.payload.source : undefined,
      url: typeof row.payload.url === 'string' ? row.payload.url : null,
      status: String(row.payload.status ?? row.status),
      summary: typeof row.payload.summary === 'string' ? row.payload.summary : row.title,
      epistemicKind: typeof row.payload.epistemicKind === 'string' ? row.payload.epistemicKind : 'observation',
      confidence: typeof row.payload.confidence === 'string' ? row.payload.confidence : undefined,
      evidenceHash: typeof row.payload.contentHash === 'string' ? row.payload.contentHash : row.contentHash,
    }));
}

export function mergeFindings(parsed: ParsedFinding[], durable: ParsedFinding[]): ParsedFinding[] {
  if (durable.length === 0) return parsed;
  if (parsed.length === 0) return durable;
  return durable.map((row, index) => {
    const match =
      parsed.find((item) => item.source && row.source && item.source.toLowerCase() === row.source.toLowerCase()) ??
      parsed.find((item) => item.title === row.title) ??
      parsed[index];
    return {
      ...row,
      url: row.url || match?.url || null,
      summary: row.summary || match?.summary || row.title,
    };
  });
}

function parseBullet(line: string): { source?: string; title: string; url?: string; hash?: string } | null {
  const trimmed = line.replace(/^[-*]\s+/, '').trim();
  if (!trimmed) return null;
  const hash = trimmed.match(/hash=([a-f0-9]+)/i)?.[1];
  const url = trimmed.match(/\((https?:\/\/[^)]+)\)/)?.[1];
  const withoutHash = stripPrimaryHashes(trimmed);
  const sourceMatch = withoutHash.match(/^([^:]+):\s*(.+)$/);
  if (sourceMatch) {
    return {
      source: sourceMatch[1]!.trim(),
      title: sourceMatch[2]!.replace(/\s*\(https?:\/\/[^)]+\)\s*/g, ' ').trim(),
      url,
      hash,
    };
  }
  return { title: withoutHash.replace(/\s*\(https?:\/\/[^)]+\)\s*/g, ' ').trim(), url, hash };
}

function section(text: string, start: RegExp, end: RegExp): string[] {
  const startMatch = start.exec(text);
  if (!startMatch || startMatch.index == null) return [];
  const from = startMatch.index + startMatch[0].length;
  const rest = text.slice(from);
  const endMatch = end.exec(rest);
  const body = (endMatch && endMatch.index != null ? rest.slice(0, endMatch.index) : rest).trim();
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-') || /^\d+\./.test(line));
}

function matchLine(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  return match?.[1]?.trim() || null;
}

function slugId(prefix: string, value: string, index: number): string {
  return `${prefix}-${index}-${value.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`;
}
