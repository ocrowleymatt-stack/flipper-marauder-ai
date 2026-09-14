import { describe, expect, it } from 'vitest';
import { PathSafetyError, UnsupportedMediaError, resolveMime, sanitiseRelPath } from '@atlas-vnext/files';

describe('path sanitisation and MIME', () => {
  it('rejects traversal, absolute paths, and control characters', () => {
    expect(sanitiseRelPath('notes/brief.md')).toBe('notes/brief.md');
    expect(() => sanitiseRelPath('../secret')).toThrow(PathSafetyError);
    expect(() => sanitiseRelPath('/etc/passwd')).toThrow(PathSafetyError);
    expect(() => sanitiseRelPath('a\\..\\b')).toThrow(PathSafetyError);
    expect(() => sanitiseRelPath('ok/\0x')).toThrow(PathSafetyError);
  });

  it('sniffs MIME instead of trusting extension, and refuses macros/scripts', () => {
    const pdf = new TextEncoder().encode('%PDF-1.4\n1 0 obj');
    expect(resolveMime({ bytes: pdf, filename: 'notes.txt' })).toBe('application/pdf');
    expect(() =>
      resolveMime({ bytes: pdf, filename: 'notes.txt', declared: 'text/plain' }),
    ).toThrow(UnsupportedMediaError);
    expect(() =>
      resolveMime({
        bytes: new TextEncoder().encode('alert(1)'),
        filename: 'x.js',
        declared: 'application/javascript',
      }),
    ).toThrow(/data/i);
  });
});
