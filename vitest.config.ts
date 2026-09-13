import { defineConfig } from 'vitest/config';

const WORKSPACE_GROUPS = ['packages', 'platform', 'dungeons', 'runtimes', 'apps'] as const;

export default defineConfig({
  resolve: {
    conditions: ['atlas-source'],
  },
  ssr: {
    resolve: {
      conditions: ['atlas-source', 'node', 'import', 'module', 'default'],
    },
  },
  test: {
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'scripts',
          include: ['scripts/**/*.test.ts'],
        },
      },
      ...WORKSPACE_GROUPS.map((group) => ({
        extends: true as const,
        test: {
          name: group,
          include: [`${group}/*/src/**/*.test.ts`],
        },
      })),
    ],
  },
});
