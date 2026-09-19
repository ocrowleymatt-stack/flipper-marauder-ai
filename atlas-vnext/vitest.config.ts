import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    // Kernel bootstrap now applies nine migrations. Parallel workers queue on
    // the Postgres DDL advisory lock, so the default 5s cap is too tight in CI.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    include: [
      'platform/**/*.test.ts',
      'apps/**/*.test.ts',
      'dungeons/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/fixtures/**',
      'tests/live/**',
    ],
  },
  resolve: {
    alias: {
      '@atlas-vnext/contracts': resolve(root, 'packages/contracts/src/index.ts'),
      '@atlas-vnext/nexus': resolve(root, 'platform/nexus/src/index.ts'),
      '@atlas-vnext/execution': resolve(root, 'platform/execution/src/index.ts'),
      '@atlas-vnext/conversation': resolve(root, 'platform/conversation/src/index.ts'),
      '@atlas-vnext/events': resolve(root, 'platform/events/src/index.ts'),
      '@atlas-vnext/persistence': resolve(root, 'platform/persistence/src/index.ts'),
      '@atlas-vnext/provenance': resolve(root, 'platform/provenance/src/index.ts'),
      '@atlas-vnext/jobs': resolve(root, 'platform/jobs/src/index.ts'),
      '@atlas-vnext/permissions': resolve(root, 'platform/permissions/src/index.ts'),
      '@atlas-vnext/projects': resolve(root, 'platform/projects/src/index.ts'),
      '@atlas-vnext/observability': resolve(root, 'platform/observability/src/index.ts'),
      '@atlas-vnext/flags': resolve(root, 'platform/flags/src/index.ts'),
      '@atlas-vnext/operations': resolve(root, 'platform/operations/src/index.ts'),
      '@atlas-vnext/storage': resolve(root, 'platform/storage/src/index.ts'),
      '@atlas-vnext/files': resolve(root, 'platform/files/src/index.ts'),
      '@atlas-vnext/acquisition': resolve(root, 'platform/acquisition/src/index.ts'),
      '@atlas-vnext/context': resolve(root, 'platform/context/src/index.ts'),
      '@atlas-vnext/auth': resolve(root, 'platform/auth/src/index.ts'),
      '@atlas-vnext/tools': resolve(root, 'platform/tools/src/index.ts'),
      '@atlas-vnext/plugins': resolve(root, 'platform/plugins/src/index.ts'),
      '@atlas-vnext/secrets': resolve(root, 'platform/secrets/src/index.ts'),
      '@atlas-vnext/search': resolve(root, 'platform/search/src/index.ts'),
      '@atlas-vnext/dungeon-writing': resolve(root, 'dungeons/writing/src/index.ts'),
      '@atlas-vnext/dungeon-osint': resolve(root, 'dungeons/osint/src/index.ts'),
      '@atlas-vnext/dungeon-investigation': resolve(root, 'dungeons/investigation/src/index.ts'),
      '@atlas-vnext/dungeon-research': resolve(root, 'dungeons/research/src/index.ts'),
      '@atlas-vnext/dungeon-website': resolve(root, 'dungeons/website/src/index.ts'),
      '@atlas-vnext/dungeon-music': resolve(root, 'dungeons/music/src/index.ts'),
      '@atlas-vnext/dungeon-privacy': resolve(root, 'dungeons/privacy/src/index.ts'),
    },
  },
});
