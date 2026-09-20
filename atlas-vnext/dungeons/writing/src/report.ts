import type { QualityAssessment } from './quality.ts';

export function composeWritingReport(input: {
  title: string;
  documentId: string;
  revision: number;
  version: number;
  status: string;
  quality: QualityAssessment;
  operation: string;
  excerpt?: string;
}): string {
  const qualityLine =
    input.quality.state === 'blocked'
      ? 'Quality: blocked — manuscript was not committed.'
      : input.quality.state === 'advisory'
        ? `Quality: advisory — ${input.quality.findings.map((item) => item.message).join(' ')}`
        : 'Quality: pass';
  const lines = [
    `Writing: ${input.title}`,
    `Manuscript: ${input.title}`,
    `Revision: ${input.version || input.revision}`,
    `Status: ${input.status}`,
    qualityLine,
    `Operation: ${input.operation}`,
  ];
  if (input.operation !== 'canon' && input.documentId) {
    lines.push(`Document-id: ${input.documentId}`);
  }
  if (input.quality.findings.length && input.quality.state !== 'pass') {
    lines.push('Quality findings:');
    for (const finding of input.quality.findings.slice(0, 6)) {
      lines.push(`- ${finding.gate}: ${finding.message}`);
    }
  }
  if (input.excerpt?.trim()) {
    lines.push('', 'Excerpt:', input.excerpt.trim().slice(0, 400));
  }
  return lines.join('\n');
}

export function manuscriptLibraryPath(documentId: string): string {
  return `manuscripts/${documentId}.md`;
}

export function writingRunConversationTitle(documentId: string): string {
  return `__writing_run__:${documentId}`;
}

export function isWritingRunConversation(title: string | null | undefined): boolean {
  return Boolean(title?.startsWith('__writing_run__:'));
}
