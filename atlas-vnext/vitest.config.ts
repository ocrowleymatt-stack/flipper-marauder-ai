import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: [
      'platform/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/fixtures/**',
    ],
  },
  resolve: {
    alias: {
      '@atlas-vnext/contracts': resolve(root, 'packages/contracts/src/index.ts'),
      '@atlas-vnext/nexus': resolve(root, 'platform/nexus/src/index.ts'),
      '@atlas-vnext/execution': resolve(root, 'platform/execution/src/index.ts'),
    },
  },
});
