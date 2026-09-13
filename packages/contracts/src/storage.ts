import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SchemaVersion, Sha256Hex } from './common.js';

export const MediaType = z
  .string()
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;.+)?$/i, 'expected a media type such as "text/markdown"');
export type MediaType = z.infer<typeof MediaType>;

export const BlobRef = z.object({
  digest: Sha256Hex,
  size: z.number().int().min(0),
  mediaType: MediaType,
});
export type BlobRef = z.infer<typeof BlobRef>;

/** Relative, slash-separated, no empty / `.` / `..` segments, no backslashes. */
export const ManifestPath = z
  .string()
  .min(1)
  .refine(
    (path) => {
      if (path.includes('\\') || path.startsWith('/') || path.endsWith('/')) return false;
      return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
    },
    { message: 'expected a normalised relative path such as "chapters/01.md"' },
  );
export type ManifestPath = z.infer<typeof ManifestPath>;

export const ManifestEntries = z.record(ManifestPath, BlobRef);
export type ManifestEntries = z.infer<typeof ManifestEntries>;

/**
 * Canonical encoding used for the manifest digest: one line per entry, sorted by path
 * (code-point order), `<path>\t<digest>\t<size>\t<mediaType>\n`.
 */
export function canonicalManifestEncoding(entries: ManifestEntries): string {
  return Object.keys(entries)
    .sort()
    .map((path) => {
      const ref = entries[path] as BlobRef;
      return `${path}\t${ref.digest}\t${ref.size}\t${ref.mediaType}\n`;
    })
    .join('');
}

export function manifestDigest(entries: ManifestEntries): Sha256Hex {
  return createHash('sha256').update(canonicalManifestEncoding(entries), 'utf8').digest('hex');
}

export const Manifest = z.object({
  schemaVersion: SchemaVersion,
  digest: Sha256Hex,
  entries: ManifestEntries,
});
export type Manifest = z.infer<typeof Manifest>;

export function createManifest(entries: ManifestEntries): Manifest {
  const parsed = ManifestEntries.parse(entries);
  return { schemaVersion: 1, digest: manifestDigest(parsed), entries: parsed };
}

export function verifyManifest(manifest: Manifest): boolean {
  return manifestDigest(manifest.entries) === manifest.digest;
}
