import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: [
      'platform/**/*.test.ts',
      'apps/**/*.test.ts',
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
    },
  },
});
