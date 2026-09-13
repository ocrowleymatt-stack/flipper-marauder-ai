/**
 * Atlas vNext architecture boundaries.
 *
 * This file is the authority for the dependency graph. It is deliberately pure
 * data (no `require`, no path logic) for two reasons:
 *
 *  1. `tests/architecture` loads it and asserts every numbered rule is still
 *     present, so the rules cannot be silently deleted to make CI green.
 *  2. `tests/architecture` also runs this exact ruleset against a synthetic
 *     violating workspace in a temp directory, proving the rules still bite.
 *
 * Rule names ending in a numeric suffix map to the numbered rules in the
 * architecture specification; `ATLAS_RULE_INDEX` in the architecture tests is
 * the machine-readable mapping.
 */

/** Internal workspace roots, as a path prefix alternation. */
const INTERNAL = '^(packages|apps|modules)/';

/** Things `apps/nexus-router` is allowed to reach for (architecture rule 3). */
const NEXUS_ROUTER_ALLOWED = [
  'packages/contracts/',
  'packages/kernel-capabilities/',
  'packages/kernel-observability/',
  'packages/kernel-jobs/',
  'packages/kernel-events/',
  'apps/nexus-router/',
];

module.exports = {
  forbidden: [
    // ---------------------------------------------------------------- rule 1
    {
      name: 'rule-1-contracts-imports-nothing-internal',
      comment:
        'packages/contracts is the root of the dependency graph: it is the single source of truth and may not import any other internal package.',
      severity: 'error',
      from: { path: '^packages/contracts/' },
      to: { path: INTERNAL, pathNot: '^packages/contracts/' },
    },

    // ---------------------------------------------------------------- rule 2
    {
      name: 'rule-2-modules-only-contracts-and-sdk',
      comment:
        'A domain module (a "Dungeon") may import only @atlas/contracts and @atlas/module-sdk, plus its own files.',
      severity: 'error',
      from: { path: '^modules/([^/]+)/' },
      to: {
        path: INTERNAL,
        pathNot: '^(packages/contracts/|packages/module-sdk/|modules/$1/)',
      },
    },
    {
      name: 'rule-2a-no-module-to-module',
      comment: 'Domain modules are isolated from each other; they compose only through the host.',
      severity: 'error',
      from: { path: '^modules/([^/]+)/' },
      to: { path: '^modules/[^/]+/', pathNot: '^modules/$1/' },
    },
    {
      name: 'rule-2b-no-module-to-kernel',
      comment: 'Domain modules never touch kernel packages directly; the SDK is their whole world.',
      severity: 'error',
      from: { path: '^modules/' },
      to: { path: '^packages/kernel-' },
    },
    {
      name: 'rule-2c-no-module-to-module-host',
      comment: 'Domain modules are loaded by the host, never the other way around.',
      severity: 'error',
      from: { path: '^modules/' },
      to: { path: '^packages/module-host/' },
    },
    {
      name: 'rule-2d-no-module-to-app',
      comment: 'Domain modules must not depend on applications.',
      severity: 'error',
      from: { path: '^modules/' },
      to: { path: '^apps/' },
    },

    // ---------------------------------------------------------------- rule 3
    {
      name: 'rule-3-nexus-router-allowlist',
      comment:
        'apps/nexus-router is a thin edge. It may only use contracts, capabilities, observability and the job/event ports.',
      severity: 'error',
      from: { path: '^apps/nexus-router/' },
      to: {
        path: INTERNAL,
        pathNot: `^(${NEXUS_ROUTER_ALLOWED.join('|')})`,
      },
    },
    {
      name: 'rule-3a-nexus-router-no-module-host',
      comment: 'The edge never loads or dispatches to modules; that is the broker\u2019s job.',
      severity: 'error',
      from: { path: '^apps/nexus-router/' },
      to: { path: '^packages/module-host/' },
    },
    {
      name: 'rule-3b-nexus-router-no-modules',
      comment: 'The edge has no knowledge of any domain module.',
      severity: 'error',
      from: { path: '^apps/nexus-router/' },
      to: { path: '^modules/' },
    },
    {
      name: 'rule-3c-nexus-router-no-broker',
      comment: 'The edge hands work over through the durable job store, not by calling the broker.',
      severity: 'error',
      from: { path: '^apps/nexus-router/' },
      to: { path: '^apps/broker/' },
    },

    // ---------------------------------------------------------------- rule 4
    {
      name: 'rule-4-broker-no-nexus-router',
      comment: 'The broker must not depend on the edge; they communicate via jobs and events.',
      severity: 'error',
      from: { path: '^apps/broker/' },
      to: { path: '^apps/nexus-router/' },
    },

    // ---------------------------------------------------------------- rule 5
    {
      name: 'rule-5-kernel-no-apps-or-modules',
      comment: 'Kernel packages sit below applications and domain modules and never depend upward.',
      severity: 'error',
      from: { path: '^packages/kernel-' },
      to: { path: '^(apps|modules)/' },
    },
    {
      name: 'rule-5a-kernel-only-contracts-and-kernels',
      comment:
        'Kernel packages depend on @atlas/contracts and on other kernels\u2019 published types only.',
      severity: 'error',
      from: { path: '^packages/kernel-' },
      to: { path: INTERNAL, pathNot: '^(packages/contracts/|packages/kernel-)' },
    },

    // ---------------------------------------------------------------- rule 6
    {
      name: 'rule-6-no-deep-cross-package-imports',
      comment:
        'Cross-package imports must target a package entrypoint (src/index.ts), never a file inside another package.',
      severity: 'error',
      from: { path: '^((?:packages|apps|modules|tests)/[^/]+)/' },
      to: {
        path: '^(?:packages|apps|modules)/[^/]+/src/',
        pathNot: '^$1/|/src/index\\.ts$',
      },
    },
    {
      name: 'rule-6a-no-imports-of-build-output',
      comment:
        'Nothing may import another package\u2019s dist/. If this fires, module resolution stopped honouring the `development` export condition and rule 6 would be silently bypassed.',
      severity: 'error',
      from: { path: INTERNAL },
      to: { path: '/dist/' },
    },

    // ---------------------------------------------------------------- rule 7
    {
      name: 'rule-7-no-circular',
      comment: 'No dependency cycles, at file level or package level.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },

    // ------------------------------------------------- supporting invariants
    {
      name: 'module-sdk-only-contracts',
      comment:
        '@atlas/module-sdk is the only surface a domain module may depend on, so it must stay as small as contracts allows.',
      severity: 'error',
      from: { path: '^packages/module-sdk/' },
      to: { path: INTERNAL, pathNot: '^(packages/contracts/|packages/module-sdk/)' },
    },
    {
      name: 'nothing-depends-on-apps',
      comment: 'Applications are leaves of the graph; libraries never import them.',
      severity: 'error',
      from: { path: '^(packages|modules)/' },
      to: { path: '^apps/' },
    },
    {
      name: 'no-unresolvable',
      comment:
        'Every import must resolve. Without this, a typo in an @atlas/* specifier would make the boundary rules vacuously true.',
      severity: 'error',
      from: { path: INTERNAL },
      to: { couldNotResolve: true },
    },
    {
      name: 'no-production-dependency-on-dev-deps',
      comment: 'Runtime code must not import a devDependency.',
      severity: 'error',
      from: { path: INTERNAL, pathNot: '(^|/)(test|tools|fixtures)/' },
      to: { dependencyTypes: ['npm-dev'], dependencyTypesNot: ['type-only'] },
    },
  ],

  options: {
    doNotFollow: { path: '(^|/)node_modules/' },
    exclude: {
      path: '(^|/)(node_modules|dist|coverage)/|^tests/architecture/fixtures/',
    },
    // Count `import type` edges too: the boundaries are type-level as well as
    // runtime-level, and most kernel ports are types.
    tsPreCompilationDeps: true,
    moduleSystems: ['es6', 'cjs'],
    enhancedResolveOptions: {
      // NodeNext sources import siblings as `./foo.js`; map those back to
      // `./foo.ts` so the graph is built from source.
      extensionAlias: {
        '.js': ['.ts', '.js'],
        '.mjs': ['.mts', '.mjs'],
        '.cjs': ['.cts', '.cjs'],
      },
      extensions: ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'],
      // `development` first: workspace packages expose src/ under that
      // condition so the cruise sees real source files, not dist/.
      conditionNames: ['development', 'import', 'module', 'node', 'require', 'default'],
      exportsFields: ['exports'],
      mainFields: ['module', 'main'],
    },
    reporterOptions: {
      archi: {
        collapsePattern: '^(packages|apps|modules)/[^/]+',
      },
      dot: {
        collapsePattern: '^(packages|apps|modules)/[^/]+',
      },
    },
  },
};
