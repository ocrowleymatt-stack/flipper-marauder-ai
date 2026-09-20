export type QualitySeverity = 'block' | 'advisory';

export interface QualityFinding {
  id: string;
  gate: string;
  severity: QualitySeverity;
  message: string;
}

export interface QualityAssessment {
  blocking: boolean;
  state: 'pass' | 'advisory' | 'blocked';
  findings: QualityFinding[];
}

const PLACEHOLDER_HINT =
  /\b(?:TBD|TK|TODO|INSERT (?:SOURCE|CITATION|FIGURE)|SOURCE NEEDED|CITATION NEEDED|lorem ipsum)\b|\[[A-Z][A-Z0-9_-]{2,}\]/gi;

const AI_FOG_PATTERNS = [
  /\bin today's (?:fast[- ]paced|ever[- ]changing) world\b/gi,
  /\bit is important to (?:note|remember|understand) that\b/gi,
  /\bit's important to (?:note|remember|understand) that\b/gi,
  /\bdelve(?:s|d|ing)? into\b/gi,
  /\btapestry of\b/gi,
  /\btestament to\b/gi,
  /\bserves as a reminder\b/gi,
  /\bjourney of (?:self[- ]discovery|discovery|transformation)\b/gi,
  /\bnavigate(?:s|d|ing)? the complexities\b/gi,
  /\bcomplex interplay\b/gi,
  /\bmultifaceted\b/gi,
  /\bnuanced understanding\b/gi,
];

export function assessWritingQuality(content: string): QualityAssessment {
  const text = content.trim();
  const findings: QualityFinding[] = [];

  if (!text) {
    findings.push({
      id: 'empty',
      gate: 'integrity',
      severity: 'block',
      message: 'Generation produced no usable manuscript text.',
    });
  } else if (/^(\.{3}|…|<empty>|n\/?a)$/i.test(text)) {
    findings.push({
      id: 'corrupt',
      gate: 'integrity',
      severity: 'block',
      message: 'Manuscript is structurally corrupt.',
    });
  }

  const placeholders = uniqueMatches(text, PLACEHOLDER_HINT);
  if (placeholders.length) {
    findings.push({
      id: 'placeholder',
      gate: 'integrity',
      severity: 'block',
      message: `Unresolved placeholders: ${placeholders.slice(0, 4).join(', ')}.`,
    });
  }

  const fogHits: string[] = [];
  for (const pattern of AI_FOG_PATTERNS) {
    fogHits.push(...uniqueMatches(text, pattern));
  }
  if (fogHits.length) {
    findings.push({
      id: 'ai-fog',
      gate: 'style',
      severity: 'advisory',
      message: `AI-fog constructions: ${fogHits.slice(0, 4).join('; ')}.`,
    });
  }

  const repeats = repeatedSentenceStarts(text);
  if (repeats.length) {
    findings.push({
      id: 'repetition',
      gate: 'style',
      severity: 'advisory',
      message: `Repeated openings: ${repeats.slice(0, 3).join('; ')}.`,
    });
  }

  const blocking = findings.some((item) => item.severity === 'block');
  const advisory = findings.some((item) => item.severity === 'advisory');
  return {
    blocking,
    state: blocking ? 'blocked' : advisory ? 'advisory' : 'pass',
    findings,
  };
}

export function formatQualityForPrompt(findings: QualityFinding[], budget = 800): string {
  const actionable = findings.filter((item) => item.severity === 'advisory' || item.severity === 'block');
  if (!actionable.length) return '';
  const lines = ['Quality findings to address in this pass:'];
  for (const finding of actionable) {
    const line = `- ${finding.gate}: ${finding.message}`;
    if ([...lines, line].join('\n').length > budget) break;
    lines.push(line);
  }
  lines.push('Remove or rewrite the flagged constructions. Preserve plot, names, and established facts.');
  return lines.join('\n');
}

function uniqueMatches(text: string, pattern: RegExp): string[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  const seen = new Set<string>();
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const value = match[0]!.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function repeatedSentenceStarts(text: string): string[] {
  const sentences = text.split(/[.!?]+/).map((item) => item.trim()).filter(Boolean);
  const counts = new Map<string, number>();
  for (const sentence of sentences) {
    const key = sentence.toLowerCase().split(/\s+/).slice(0, 4).join(' ');
    if (key.split(' ').length < 3) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n >= 3).map(([key]) => `"${key}"`);
}
