#!/usr/bin/env node
// Dependency-boundary lint for the Atlas monorepo. No dependencies; run with `npm run boundaries`.
// Usage: node scripts/check-boundaries.mjs [--root <dir>] [--json]

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCOPE = '@atlas/';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/** Ordered list of boundary rules. `from`/`to` are workspace directories relative to the repo root (posix). */
export const RULES = [
  {
    id: 'contracts-is-a-leaf',
    describe: 'packages/contracts must not depend on anything in this repository',
    violates: (from) => from === 'packages/contracts',
  },
  {
    id: 'nexus-allowlist',
    describe:
      'platform/nexus may depend only on @atlas/contracts, @atlas/shared, @atlas/config and @atlas/platform-observability',
    violates: (from, to) =>
      from === 'platform/nexus' &&
      !['packages/contracts', 'packages/shared', 'packages/config', 'platform/observability'].includes(to),
  },
  {
    id: 'platform-never-dungeons-or-apps',
    describe: 'platform/* must not depend on dungeons/* or apps/*',
    violates: (from, to) => from.startsWith('platform/') && (to.startsWith('dungeons/') || to.startsWith('apps/')),
  },
  {
    id: 'dungeons-are-isolated',
    describe: 'dungeons/* must not depend on other dungeons/* or on apps/*',
    violates: (from, to) => from.startsWith('dungeons/') && (to.startsWith('dungeons/') || to.startsWith('apps/')),
  },
  {
    id: 'runtimes-never-dungeons-or-apps',
    describe: 'runtimes/* must not depend on dungeons/* or apps/*',
    violates: (from, to) => from.startsWith('runtimes/') && (to.startsWith('dungeons/') || to.startsWith('apps/')),
  },
];

const toPosix = (p) => p.split(sep).join('/');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function expandWorkspaceGlob(rootDir, pattern) {
  if (!pattern.endsWith('/*')) {
    const dir = join(rootDir, pattern);
    return existsSync(join(dir, 'package.json')) ? [dir] : [];
  }
  const parent = join(rootDir, pattern.slice(0, -2));
  if (!existsSync(parent)) return [];
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(parent, entry.name))
    .filter((dir) => existsSync(join(dir, 'package.json')));
}

export function discoverWorkspaces(rootDir) {
  const rootPkg = readJson(join(rootDir, 'package.json'));
  const patterns = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : rootPkg.workspaces?.packages ?? [];
  const workspaces = [];
  for (const pattern of patterns) {
    for (const dir of expandWorkspaceGlob(rootDir, pattern)) {
      const pkg = readJson(join(dir, 'package.json'));
      if (typeof pkg.name !== 'string') continue;
      workspaces.push({ name: pkg.name, dir: toPosix(relative(rootDir, dir)), absDir: dir, pkg });
    }
  }
  return workspaces;
}

function* walkSourceFiles(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkSourceFiles(full);
    } else if (SOURCE_EXTENSIONS.has(extensionOf(entry.name))) {
      yield full;
    }
  }
}

function extensionOf(name) {
  const index = name.lastIndexOf('.');
  return index === -1 ? '' : name.slice(index);
}

const IMPORT_PATTERN = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*|import\s+)['"](@atlas\/[^'"/]+)(?:\/[^'"]*)?['"]/g;

export function findScopedImports(source) {
  const found = [];
  const lines = source.split('\n');
  lines.forEach((line, index) => {
    for (const match of line.matchAll(IMPORT_PATTERN)) {
      found.push({ specifier: match[1], line: index + 1 });
    }
  });
  return found;
}

function tsconfigReferences(rootDir, absDir) {
  const path = join(absDir, 'tsconfig.json');
  if (!existsSync(path)) return null;
  const refs = readJson(path).references ?? [];
  return new Set(refs.map((ref) => toPosix(relative(rootDir, resolve(absDir, ref.path)))));
}

export function checkBoundaries(rootDir) {
  const workspaces = discoverWorkspaces(rootDir);
  const byName = new Map(workspaces.map((ws) => [ws.name, ws]));
  const violations = [];
  let edges = 0;

  const report = (ws, rule, detail, location) => {
    violations.push({ package: ws.name, dir: ws.dir, rule, detail, ...(location ? { location } : {}) });
  };

  const checkEdge = (ws, target, location) => {
    if (target.name === ws.name) return;
    edges += 1;
    for (const rule of RULES) {
      if (rule.violates(ws.dir, target.dir)) {
        report(ws, rule.id, `${ws.dir} -> ${target.dir} (${target.name}): ${rule.describe}`, location);
      }
    }
  };

  for (const ws of workspaces) {
    const declared = new Map();
    for (const field of DEPENDENCY_FIELDS) {
      for (const depName of Object.keys(ws.pkg[field] ?? {})) {
        if (!depName.startsWith(SCOPE)) continue;
        const target = byName.get(depName);
        if (!target) {
          report(ws, 'unknown-package', `${field} lists ${depName}, which is not a workspace in this repository`);
          continue;
        }
        declared.set(depName, field);
        checkEdge(ws, target, `${ws.dir}/package.json#${field}`);
      }
    }

    const references = tsconfigReferences(rootDir, ws.absDir);
    if (references) {
      for (const [depName, field] of declared) {
        if (field !== 'dependencies') continue;
        const target = byName.get(depName);
        if (!references.has(target.dir)) {
          report(
            ws,
            'missing-tsconfig-reference',
            `${depName} is a runtime dependency but tsconfig.json has no reference to ${target.dir}`,
            `${ws.dir}/tsconfig.json`,
          );
        }
      }
    }

    for (const file of walkSourceFiles(join(ws.absDir, 'src'))) {
      const relFile = toPosix(relative(rootDir, file));
      for (const { specifier, line } of findScopedImports(readFileSync(file, 'utf8'))) {
        if (specifier === ws.name) continue;
        const target = byName.get(specifier);
        const location = `${relFile}:${line}`;
        if (!target) {
          report(ws, 'unknown-package', `imports ${specifier}, which is not a workspace in this repository`, location);
          continue;
        }
        if (!declared.has(specifier)) {
          report(ws, 'undeclared-dependency', `imports ${specifier} but package.json does not declare it`, location);
        }
        checkEdge(ws, target, location);
      }
    }
  }

  return { workspaces: workspaces.length, edges, violations };
}

function parseArgs(argv) {
  const args = { root: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      args.root = resolve(argv[i + 1] ?? '.');
      i += 1;
    } else if (arg === '--json') {
      args.json = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = checkBoundaries(args.root);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.violations.length === 0) {
    console.log(
      `boundaries: ${result.workspaces} workspaces, ${result.edges} in-repo dependency edges (declared + imported), no violations`,
    );
  } else {
    console.error(`boundaries: ${result.violations.length} violation(s)`);
    for (const v of result.violations) {
      console.error(`  [${v.rule}] ${v.package}: ${v.detail}${v.location ? `\n      at ${v.location}` : ''}`);
    }
  }
  process.exitCode = result.violations.length === 0 ? 0 : 1;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
