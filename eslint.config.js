import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/**
 * Lint-level mirror of a subset of the architecture rules. dependency-cruiser
 * (`.dependency-cruiser.cjs`) is the authority for the dependency graph; these
 * `no-restricted-imports` groups exist only to fail fast in the editor.
 */
const forbiddenForModules = [
  {
    group: ['@atlas/kernel-*'],
    message:
      'Domain modules may only depend on @atlas/contracts and @atlas/module-sdk (architecture rule 2).',
  },
  {
    group: ['@atlas/module-host'],
    message: 'Domain modules must not reach into the module host (architecture rule 2).',
  },
  {
    group: ['@atlas/nexus-router', '@atlas/broker'],
    message: 'Domain modules must not depend on applications (architecture rule 2).',
  },
  {
    group: ['@atlas/module-*', '!@atlas/module-sdk', '!@atlas/module-host'],
    message: 'Domain modules must not depend on other domain modules (architecture rule 2).',
  },
];

const noDeepAtlasImports = {
  group: ['@atlas/*/*'],
  message: 'Cross-package imports must go through the package entrypoint (architecture rule 6).',
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      'packages/contracts/schema/**',
      'tests/architecture/fixtures/**',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [noDeepAtlasImports] }],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      'no-param-reassign': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['modules/*/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [noDeepAtlasImports, ...forbiddenForModules] },
      ],
    },
  },
  {
    files: ['packages/contracts/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            noDeepAtlasImports,
            {
              group: ['@atlas/*'],
              message:
                '@atlas/contracts is the root of the dependency graph and imports nothing internal (architecture rule 1).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/contracts/src/tools/**/*.ts', 'tests/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly', __dirname: 'readonly' },
    },
  },
);
