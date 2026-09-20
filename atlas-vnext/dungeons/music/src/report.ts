export function composeMusicReport(input: {
  title: string;
  compositionId: string;
  revision: number;
  durationSeconds: number;
  tempoBpm: number;
  key?: string;
  libraryOk: boolean;
}): string {
  const lines = [
    `Music: ${input.title}`,
    `Composition: ${input.compositionId}`,
    `Revision: ${input.revision}`,
    'Status: playable',
    `Duration: ${input.durationSeconds.toFixed(1)}s`,
    `Tempo: ${Math.round(input.tempoBpm)} BPM`,
  ];
  if (input.key) lines.push(`Key: ${input.key}`);
  if (!input.libraryOk) {
    lines.push('Library publication was not completed; the composition is still stored.');
  }
  lines.push('This is a score-first audition, not a studio master.');
  return lines.join('\n');
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = 'code' in err ? String((err as { code?: string }).code) : '';
  if (code === 'cancelled' || code === 'aborted') return true;
  return err instanceof Error && /aborted|AbortError|cancelled/i.test(`${err.name} ${err.message}`);
}

export function isContentFilterError(err: unknown): boolean {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: string }).code) : '';
  const message = err instanceof Error ? err.message : String(err);
  return code === 'content_filter' || /content filter/i.test(message);
}
