import { PathSafetyError } from './errors.ts';

const MAX_PATH = 512;
const ILLEGAL = /[\0\r\n\u0001-\u001f]/;

/**
 * Uploaded paths are data labels, not filesystem locations.
 * Reject traversal, absolute paths, and control characters.
 */
export function sanitiseRelPath(raw: string): string {
  if (!raw || !raw.trim()) throw new PathSafetyError('File path is required.');
  let value = raw.trim().replace(/\\/g, '/');
  try {
    value = decodeURIComponent(value);
  } catch {
    // already decoded
  }
  if (ILLEGAL.test(value)) throw new PathSafetyError('File path contains illegal control characters.');
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value) || value.startsWith('\\\\')) {
    throw new PathSafetyError('Absolute file paths are not allowed.');
  }
  const parts: string[] = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new PathSafetyError('Path traversal is not allowed.');
    if (part === '~') throw new PathSafetyError('Home-relative paths are not allowed.');
    parts.push(part);
  }
  const joined = parts.join('/');
  if (!joined) throw new PathSafetyError('File path is empty after sanitisation.');
  if (joined.length > MAX_PATH) throw new PathSafetyError(`File path exceeds ${MAX_PATH} characters.`);
  return joined;
}

export function displayNameFromPath(path: string): string {
  const segment = path.split('/').at(-1);
  return segment && segment.length > 0 ? segment : path;
}
