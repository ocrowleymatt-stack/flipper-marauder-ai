import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repoRoot = dirname(fileURLToPath(import.meta.url));

/**
 * Workspace packages publish `dist/`, but under test we want the TypeScript
 * sources so that `pnpm test` does not require a build first. The packages also
 * declare a `development` export condition pointing at `src/`; the explicit
 * aliases below make that resolution deterministic regardless of which
 * conditions Vite happens to activate.
 */
function workspaceAliases(): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const group of ['packages', 'apps', 'modules']) {
    const groupDir = join(repoRoot, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(groupDir, entry.name, 'package.json');
      const entrypoint = join(groupDir, entry.name, 'src', 'index.ts');
      if (!existsSync(manifestPath) || !existsSync(entrypoint)) continue;
      const { name } = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name: string };
      aliases[name] = entrypoint;
    }
  }
  return aliases;
}

const alias = workspaceAliases();

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          root: repoRoot,
          include: [
            'packages/*/test/**/*.test.ts',
            'apps/*/test/**/*.test.ts',
            'modules/*/test/**/*.test.ts',
          ],
          environment: 'node',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'arch',
          root: repoRoot,
          include: ['tests/architecture/test/**/*.test.ts'],
          environment: 'node',
          // dependency-cruiser walks the whole workspace graph; give it room.
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
