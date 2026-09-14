import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export type Layer =
  | 'contracts'
  | 'nexus'
  | 'execution'
  | 'conversation'
  | 'persistence'
  | 'projects'
  | 'jobs'
  | 'events'
  | 'storage'
  | 'provenance'
  | 'permissions'
  | 'observability'
  | 'flags'
  | 'files'
  | 'context'
  | 'dungeon'
  | 'apps'
  | 'tests'
  | 'unknown';

export interface ModuleNode {
  relPath: string;
  layer: Layer;
  dungeon?: string;
  specifiers: string[];
  fetchCalls: boolean;
  definesCircuitBreaker: boolean;
  definesExecutionBroker: boolean;
  processEnvAccess: boolean;
}

export interface Violation {
  rule: string;
  file: string;
  detail: string;
}

export interface GraphReport {
  modules: ModuleNode[];
  violations: Violation[];
  packageViolations: Violation[];
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'fixtures']);

const PACKAGE_LAYER: Record<string, Layer> = {
  '@atlas-vnext/contracts': 'contracts',
  '@atlas-vnext/nexus': 'nexus',
  '@atlas-vnext/execution': 'execution',
  '@atlas-vnext/conversation': 'conversation',
  '@atlas-vnext/persistence': 'persistence',
  '@atlas-vnext/projects': 'projects',
  '@atlas-vnext/jobs': 'jobs',
  '@atlas-vnext/events': 'events',
  '@atlas-vnext/storage': 'storage',
  '@atlas-vnext/files': 'files',
  '@atlas-vnext/context': 'context',
  '@atlas-vnext/provenance': 'provenance',
  '@atlas-vnext/permissions': 'permissions',
  '@atlas-vnext/observability': 'observability',
  '@atlas-vnext/flags': 'flags',
};

const DUNGEON_PACKAGES: Record<string, string> = {
  '@atlas-vnext/dungeon-writing': 'writing',
  '@atlas-vnext/dungeon-investigation': 'investigation',
  '@atlas-vnext/dungeon-research': 'research',
  '@atlas-vnext/dungeon-website': 'website',
  '@atlas-vnext/dungeon-osint': 'osint',
  '@atlas-vnext/dungeon-music': 'music',
};

const TRANSPORT_MODULES = new Set([
  'undici',
  'axios',
  'node-fetch',
  'got',
  'node:http',
  'node:https',
  'node:net',
  'http',
  'https',
  'net',
  'openai',
  '@anthropic-ai/sdk',
  '@google/genai',
  '@google/generative-ai',
  'node:http2',
  'http2',
  'node:undici',
  'eventsource',
]);

const PROVIDER_CLIENT_MODULES = new Set([
  'undici',
  'axios',
  'node-fetch',
  'got',
  'openai',
  '@anthropic-ai/sdk',
  '@google/genai',
  '@google/generative-ai',
  'node:undici',
]);

const STORAGE_MODULES = new Set([
  'better-sqlite3',
  'sqlite3',
  'sqlite',
  'postgres',
  'pg',
  'mysql2',
  'knex',
  'drizzle-orm',
  'sql.js',
]);

const LEGACY_MODULES = [
  '@caspa/',
  'caspa',
  '@ocrowley/',
  'shakespeare',
  'the-big-brother',
  'the_big_brother',
];

const NEXUS_FORBIDDEN_LAYERS = new Set<Layer>([
  'execution',
  'conversation',
  'persistence',
  'dungeon',
  'jobs',
  'storage',
  'events',
  'projects',
  'provenance',
  'permissions',
  'observability',
  'flags',
  'files',
  'context',
]);

const PLATFORM_LAYERS = new Set<Layer>([
  'projects',
  'jobs',
  'events',
  'storage',
  'provenance',
  'permissions',
  'observability',
  'flags',
  'files',
  'context',
  'nexus',
  'execution',
  'conversation',
  'persistence',
]);

export function classifyPath(relPath: string): { layer: Layer; dungeon?: string } {
  const normalised = relPath.split(sep).join('/');
  if (normalised.startsWith('packages/contracts/')) return { layer: 'contracts' };
  if (normalised.startsWith('platform/nexus/')) return { layer: 'nexus' };
  if (normalised.startsWith('platform/execution/')) return { layer: 'execution' };
  if (normalised.startsWith('platform/conversation/')) return { layer: 'conversation' };
  if (normalised.startsWith('platform/persistence/')) return { layer: 'persistence' };
  if (normalised.startsWith('platform/projects/')) return { layer: 'projects' };
  if (normalised.startsWith('platform/jobs/')) return { layer: 'jobs' };
  if (normalised.startsWith('platform/events/')) return { layer: 'events' };
  if (normalised.startsWith('platform/storage/')) return { layer: 'storage' };
  if (normalised.startsWith('platform/files/')) return { layer: 'files' };
  if (normalised.startsWith('platform/context/')) return { layer: 'context' };
  if (normalised.startsWith('platform/provenance/')) return { layer: 'provenance' };
  if (normalised.startsWith('platform/permissions/')) return { layer: 'permissions' };
  if (normalised.startsWith('platform/observability/')) return { layer: 'observability' };
  if (normalised.startsWith('platform/flags/')) return { layer: 'flags' };
  if (normalised.startsWith('apps/')) return { layer: 'apps' };
  const dungeonMatch = normalised.match(/^dungeons\/([^/]+)\//);
  if (dungeonMatch) return { layer: 'dungeon', dungeon: dungeonMatch[1] };
  if (normalised.startsWith('tests/')) return { layer: 'tests' };
  return { layer: 'unknown' };
}

export function walkSourceFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        visit(full);
      } else if ((entry.endsWith('.ts') && !entry.endsWith('.d.ts')) || entry.endsWith('.tsx')) {
        out.push(full);
      }
    }
  };
  visit(join(root, 'packages'));
  visit(join(root, 'platform'));
  visit(join(root, 'dungeons'));
  visit(join(root, 'apps'));
  return out;
}

function parseModule(
  filePath: string,
  sourceText: string,
): Pick<
  ModuleNode,
  'specifiers' | 'fetchCalls' | 'definesCircuitBreaker' | 'definesExecutionBroker' | 'processEnvAccess'
> {
  const kind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, kind);
  const specifiers: string[] = [];
  let fetchCalls = false;
  let definesCircuitBreaker = false;
  let definesExecutionBroker = false;
  let processEnvAccess = false;

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) specifiers.push(arg.text);
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) specifiers.push(arg.text);
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'fetch') {
        fetchCalls = true;
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'fetch'
      ) {
        fetchCalls = true;
      }
    }
    if (ts.isClassDeclaration(node) && node.name?.text === 'CircuitBreaker') {
      definesCircuitBreaker = true;
    }
    if (ts.isClassDeclaration(node) && node.name?.text === 'ExecutionBroker') {
      definesExecutionBroker = true;
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'env' &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'process'
    ) {
      processEnvAccess = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { specifiers, fetchCalls, definesCircuitBreaker, definesExecutionBroker, processEnvAccess };
}

function specifierLayer(
  specifier: string,
  fromFile: string,
  root: string,
): { layer: Layer; dungeon?: string; raw: string } {
  if (PACKAGE_LAYER[specifier]) {
    return { layer: PACKAGE_LAYER[specifier], raw: specifier };
  }
  if (DUNGEON_PACKAGES[specifier]) {
    return { layer: 'dungeon', dungeon: DUNGEON_PACKAGES[specifier], raw: specifier };
  }
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const resolved = resolve(dirname(fromFile), specifier);
    const withTs = resolved.endsWith('.ts') ? resolved : `${resolved}.ts`;
    const candidate = existsSync(withTs)
      ? withTs
      : existsSync(join(resolved, 'index.ts'))
        ? join(resolved, 'index.ts')
        : withTs;
    const rel = relative(root, candidate);
    const classified = classifyPath(rel);
    return { ...classified, raw: specifier };
  }
  if (specifier.startsWith('node:')) {
    return { layer: 'unknown', raw: specifier };
  }
  return { layer: 'unknown', raw: specifier };
}

function isAdapterImport(specifier: string, fromFile: string, root: string): boolean {
  if (specifier.includes('/adapters/') || specifier.endsWith('/adapters')) return true;
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const resolved = resolve(dirname(fromFile), specifier);
    const rel = relative(root, resolved).split(sep).join('/');
    if (rel.includes('platform/execution/src/adapters')) return true;
  }
  return PROVIDER_CLIENT_MODULES.has(specifier);
}

export function analyzeGraph(
  root: string,
  overlays: Record<string, string> = {},
): GraphReport {
  const files = walkSourceFiles(root);
  const modules: ModuleNode[] = [];
  const overlayAbs = new Map<string, string>();

  for (const [rel, content] of Object.entries(overlays)) {
    overlayAbs.set(resolve(root, rel), content);
  }

  const allFiles = new Set(files);
  for (const abs of overlayAbs.keys()) allFiles.add(abs);

  for (const abs of allFiles) {
    const relPath = relative(root, abs).split(sep).join('/');
    if (relPath.includes('/tests/') || relPath.endsWith('.test.ts')) continue;
    const classified = classifyPath(relPath);
    if (classified.layer === 'tests' || classified.layer === 'unknown') continue;
    const sourceText = overlayAbs.get(abs) ?? readFileSync(abs, 'utf8');
    const parsed = parseModule(abs, sourceText);
    modules.push({
      relPath,
      layer: classified.layer,
      dungeon: classified.dungeon,
      ...parsed,
    });
  }

  const violations: Violation[] = [];
  let executionDefinesBreaker = false;
  let executionDefinesBroker = false;

  for (const mod of modules) {
    if (mod.layer === 'execution' && mod.definesCircuitBreaker) executionDefinesBreaker = true;
    if (mod.layer === 'execution' && mod.definesExecutionBroker) executionDefinesBroker = true;

    if (mod.layer === 'nexus') {
      if (mod.fetchCalls) {
        violations.push({
          rule: 'nexus-no-transport',
          file: mod.relPath,
          detail: 'Nexus contains a fetch() call; provider transport belongs in execution.',
        });
      }
      if (mod.definesCircuitBreaker) {
        violations.push({
          rule: 'nexus-no-circuit-breaker',
          file: mod.relPath,
          detail: 'CircuitBreaker must live in the execution layer.',
        });
      }
      if (mod.processEnvAccess) {
        violations.push({
          rule: 'nexus-no-secrets',
          file: mod.relPath,
          detail: 'Nexus read process.env; secrets and runtime config belong at the host/execution boundary.',
        });
      }
    }

    if (mod.layer === 'conversation' && mod.processEnvAccess) {
      violations.push({
        rule: 'conversation-no-secrets',
        file: mod.relPath,
        detail: 'Conversation domain read process.env.',
      });
    }

    if (mod.layer === 'execution' && mod.processEnvAccess) {
      const allowed = mod.relPath.endsWith('/secrets.ts') || mod.relPath.endsWith('/config.ts');
      if (!allowed) {
        violations.push({
          rule: 'execution-secrets-abstraction',
          file: mod.relPath,
          detail: 'Execution module read process.env; use SecretStore / readExecutionConfig.',
        });
      }
    }

    if (mod.layer === 'apps' && mod.relPath.startsWith('apps/web/') && mod.processEnvAccess) {
      violations.push({
        rule: 'apps-no-secrets',
        file: mod.relPath,
        detail: 'Web UI read process.env; it must not hold provider secrets.',
      });
    }

    for (const specifier of mod.specifiers) {
      const target = specifierLayer(specifier, resolve(root, mod.relPath), root);

      if (mod.layer === 'nexus') {
        if (NEXUS_FORBIDDEN_LAYERS.has(target.layer)) {
          violations.push({
            rule: 'nexus-layer-import',
            file: mod.relPath,
            detail: `Nexus imported ${specifier} (${target.layer}${target.dungeon ? ':' + target.dungeon : ''}).`,
          });
        }
        if (TRANSPORT_MODULES.has(specifier)) {
          violations.push({
            rule: 'nexus-no-transport',
            file: mod.relPath,
            detail: `Nexus imported transport module ${specifier}.`,
          });
        }
        if (STORAGE_MODULES.has(specifier)) {
          violations.push({
            rule: 'nexus-no-storage',
            file: mod.relPath,
            detail: `Nexus imported storage/sql module ${specifier}.`,
          });
        }
        if (LEGACY_MODULES.some((prefix) => specifier === prefix || specifier.startsWith(prefix))) {
          violations.push({
            rule: 'nexus-no-legacy',
            file: mod.relPath,
            detail: `Nexus imported legacy module ${specifier}.`,
          });
        }
      }

      if (mod.layer === 'dungeon') {
        if (target.layer === 'dungeon' && target.dungeon && target.dungeon !== mod.dungeon) {
          violations.push({
            rule: 'dungeon-isolation',
            file: mod.relPath,
            detail: `Dungeon ${mod.dungeon} imported dungeon ${target.dungeon} via ${specifier}.`,
          });
        }
        if (isAdapterImport(specifier, resolve(root, mod.relPath), root) || TRANSPORT_MODULES.has(specifier)) {
          violations.push({
            rule: 'dungeon-no-adapters',
            file: mod.relPath,
            detail: `Dungeon ${mod.dungeon} imported provider adapter/transport ${specifier}.`,
          });
        }
      }

      if (mod.layer === 'conversation') {
        if (target.layer === 'nexus' || target.layer === 'execution' || target.layer === 'dungeon') {
          violations.push({
            rule: 'conversation-ports-only',
            file: mod.relPath,
            detail: `Conversation domain imported ${specifier} (${target.layer}); inject router/executor at the host.`,
          });
        }
        if (isAdapterImport(specifier, resolve(root, mod.relPath), root) || TRANSPORT_MODULES.has(specifier)) {
          violations.push({
            rule: 'conversation-no-adapters',
            file: mod.relPath,
            detail: `Conversation domain imported provider adapter/transport ${specifier}.`,
          });
        }
      }

      if (mod.layer === 'execution') {
        if (target.layer === 'nexus' || target.layer === 'dungeon') {
          violations.push({
            rule: 'execution-no-policy-or-domain',
            file: mod.relPath,
            detail: `Execution imported ${specifier} (${target.layer}).`,
          });
        }
      }

      if (PLATFORM_LAYERS.has(mod.layer) && target.layer === 'dungeon') {
        violations.push({
          rule: 'platform-no-dungeons',
          file: mod.relPath,
          detail: `Platform layer ${mod.layer} imported dungeon via ${specifier}.`,
        });
      }

      if (mod.layer === 'apps' && (isAdapterImport(specifier, resolve(root, mod.relPath), root) || PROVIDER_CLIENT_MODULES.has(specifier))) {
        violations.push({
          rule: 'apps-no-provider-impl',
          file: mod.relPath,
          detail: `App imported provider implementation ${specifier}; depend on contracts/interfaces.`,
        });
      }
      if (
        mod.layer === 'apps' &&
        mod.relPath.startsWith('apps/web/') &&
        (target.layer === 'execution' || target.layer === 'nexus' || target.layer === 'persistence')
      ) {
        violations.push({
          rule: 'apps-no-provider-impl',
          file: mod.relPath,
          detail: `Web UI imported ${specifier} (${target.layer}); it must consume the HTTP/SSE contract only.`,
        });
      }
    }
  }

  if (!executionDefinesBreaker) {
    violations.push({
      rule: 'execution-owns-resilience',
      file: 'platform/execution',
      detail: 'CircuitBreaker class is missing from the execution layer.',
    });
  }
  if (!executionDefinesBroker) {
    violations.push({
      rule: 'execution-owns-streaming',
      file: 'platform/execution',
      detail: 'ExecutionBroker is missing from the execution layer.',
    });
  }

  const packageViolations = analyzePackageJson(root, overlays);
  return { modules, violations: [...violations, ...packageViolations], packageViolations };
}

function analyzePackageJson(root: string, overlays: Record<string, string>): Violation[] {
  const violations: Violation[] = [];
  const packages = [
    ['platform/nexus/package.json', 'nexus'],
    ['platform/execution/package.json', 'execution'],
    ['platform/conversation/package.json', 'conversation'],
    ['platform/persistence/package.json', 'platform'],
    ['platform/projects/package.json', 'platform'],
    ['apps/web/package.json', 'apps-web'],
    ['apps/host/package.json', 'apps-host'],
    ['platform/jobs/package.json', 'platform'],
    ['platform/events/package.json', 'platform'],
    ['platform/storage/package.json', 'platform'],
    ['platform/files/package.json', 'platform'],
    ['platform/context/package.json', 'platform'],
    ['platform/provenance/package.json', 'platform'],
    ['platform/permissions/package.json', 'platform'],
    ['platform/observability/package.json', 'platform'],
    ['platform/flags/package.json', 'platform'],
    ['dungeons/writing/package.json', 'dungeon'],
    ['dungeons/investigation/package.json', 'dungeon'],
    ['dungeons/research/package.json', 'dungeon'],
    ['dungeons/website/package.json', 'dungeon'],
    ['dungeons/osint/package.json', 'dungeon'],
    ['dungeons/music/package.json', 'dungeon'],
  ] as const;

  for (const [rel, kind] of packages) {
    const abs = resolve(root, rel);
    const raw = overlays[rel] ?? (existsSync(abs) ? readFileSync(abs, 'utf8') : null);
    if (!raw) continue;
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const name of Object.keys(deps)) {
      if (kind === 'nexus') {
        if (
          name === '@atlas-vnext/execution' ||
          name.startsWith('@atlas-vnext/dungeon-') ||
          name === '@atlas-vnext/jobs' ||
          name === '@atlas-vnext/storage' ||
          name === '@atlas-vnext/files' ||
          name === '@atlas-vnext/context' ||
          STORAGE_MODULES.has(name) ||
          TRANSPORT_MODULES.has(name) ||
          LEGACY_MODULES.some((prefix) => name === prefix || name.startsWith(prefix))
        ) {
          violations.push({
            rule: 'nexus-package-deps',
            file: rel,
            detail: `Nexus package.json depends on forbidden module ${name}.`,
          });
        }
      }
      if (kind === 'dungeon') {
        if (name.startsWith('@atlas-vnext/dungeon-') && !rel.includes(name.replace('@atlas-vnext/dungeon-', ''))) {
          violations.push({
            rule: 'dungeon-package-deps',
            file: rel,
            detail: `Dungeon package.json depends on another dungeon (${name}).`,
          });
        }
        if (TRANSPORT_MODULES.has(name) || name.includes('/adapters')) {
          violations.push({
            rule: 'dungeon-package-deps',
            file: rel,
            detail: `Dungeon package.json depends on provider transport ${name}.`,
          });
        }
      }
      if (kind === 'execution' && (name === '@atlas-vnext/nexus' || name.startsWith('@atlas-vnext/dungeon-'))) {
        violations.push({
          rule: 'execution-package-deps',
          file: rel,
          detail: `Execution package.json depends on ${name}.`,
        });
      }
      if (kind === 'platform' && name.startsWith('@atlas-vnext/dungeon-')) {
        violations.push({
          rule: 'platform-package-deps',
          file: rel,
          detail: `Platform package.json depends on product dungeon ${name}.`,
        });
      }
      if (kind === 'conversation') {
        if (
          name === '@atlas-vnext/nexus' ||
          name === '@atlas-vnext/execution' ||
          name.startsWith('@atlas-vnext/dungeon-') ||
          STORAGE_MODULES.has(name) ||
          TRANSPORT_MODULES.has(name)
        ) {
          violations.push({
            rule: 'conversation-package-deps',
            file: rel,
            detail: `Conversation package.json depends on forbidden module ${name}.`,
          });
        }
      }
      if (kind === 'apps-web') {
        if (
          name === '@atlas-vnext/nexus' ||
          name === '@atlas-vnext/execution' ||
          TRANSPORT_MODULES.has(name) ||
          name.includes('/adapters')
        ) {
          violations.push({
            rule: 'apps-package-deps',
            file: rel,
            detail: `Web UI package.json depends on ${name}; consume the host HTTP contract instead.`,
          });
        }
      }
    }
  }
  return violations;
}
