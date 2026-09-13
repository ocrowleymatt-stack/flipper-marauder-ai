import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'check-boundaries.mjs');
const REPO_ROOT = resolve(dirname(SCRIPT), '..');

interface FixturePackage {
  dir: string;
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  references?: string[];
  source?: string;
}

const tempDirs: string[] = [];

function writeFixture(packages: FixturePackage[]): string {
  const root = mkdtempSync(join(tmpdir(), 'atlas-boundaries-'));
  tempDirs.push(root);
  const groups = [...new Set(packages.map((p) => p.dir.split('/')[0]))];
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', workspaces: groups.map((g) => `${g}/*`) }));
  for (const pkg of packages) {
    const dir = join(root, pkg.dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: pkg.name,
        ...(pkg.dependencies ? { dependencies: pkg.dependencies } : {}),
        ...(pkg.devDependencies ? { devDependencies: pkg.devDependencies } : {}),
      }),
    );
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ references: (pkg.references ?? []).map((path) => ({ path: `../../${path}` })) }),
    );
    writeFileSync(join(dir, 'src/index.ts'), pkg.source ?? `export const PACKAGE_NAME = '${pkg.name}';\n`);
  }
  return root;
}

function run(root: string, json = false) {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root, ...(json ? ['--json'] : [])], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CLEAN: FixturePackage[] = [
  { dir: 'packages/contracts', name: '@atlas/contracts' },
  { dir: 'packages/shared', name: '@atlas/shared', dependencies: { '@atlas/contracts': '*' }, references: ['packages/contracts'] },
  { dir: 'platform/observability', name: '@atlas/platform-observability' },
  {
    dir: 'platform/nexus',
    name: '@atlas/platform-nexus',
    dependencies: { '@atlas/contracts': '*', '@atlas/platform-observability': '*' },
    references: ['packages/contracts', 'platform/observability'],
    source: "import { PACKAGE_NAME as C } from '@atlas/contracts';\nimport '@atlas/platform-observability';\nexport const x = C;\n",
  },
  { dir: 'platform/storage', name: '@atlas/platform-storage' },
  { dir: 'dungeons/writing', name: '@atlas/dungeon-writing', dependencies: { '@atlas/platform-storage': '*' }, references: ['platform/storage'] },
  { dir: 'dungeons/music', name: '@atlas/dungeon-music' },
  { dir: 'apps/web', name: '@atlas/app-web', dependencies: { '@atlas/dungeon-writing': '*' }, references: ['dungeons/writing'] },
];

describe('check-boundaries', () => {
  it('passes a fixture that respects every rule', () => {
    const { status, stdout, stderr } = run(writeFixture(CLEAN));
    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(stdout).toContain('no violations');
  });

  it('flags every kind of synthetic violation', () => {
    const root = writeFixture([
      { dir: 'packages/contracts', name: '@atlas/contracts', dependencies: { '@atlas/shared': '*' }, references: ['packages/shared'] },
      { dir: 'packages/shared', name: '@atlas/shared' },
      { dir: 'platform/storage', name: '@atlas/platform-storage' },
      {
        dir: 'platform/nexus',
        name: '@atlas/platform-nexus',
        dependencies: { '@atlas/platform-storage': '*' },
        references: ['platform/storage'],
      },
      {
        dir: 'platform/jobs',
        name: '@atlas/platform-jobs',
        source: "export * from '@atlas/app-web';\n",
      },
      {
        dir: 'dungeons/writing',
        name: '@atlas/dungeon-writing',
        dependencies: { '@atlas/dungeon-music': '*' },
        source: "const m = await import('@atlas/dungeon-music/subpath');\nexport default m;\n",
      },
      { dir: 'dungeons/music', name: '@atlas/dungeon-music' },
      { dir: 'runtimes/local', name: '@atlas/runtime-local', devDependencies: { '@atlas/app-web': '*' } },
      { dir: 'apps/web', name: '@atlas/app-web', dependencies: { '@atlas/nonexistent': '*' } },
    ]);

    const { status, stdout } = run(root, true);
    expect(status).toBe(1);
    const report = JSON.parse(stdout) as { violations: { rule: string; package: string; location?: string }[] };
    const rulesFor = (pkg: string) => report.violations.filter((v) => v.package === pkg).map((v) => v.rule);

    expect(rulesFor('@atlas/contracts')).toEqual(['contracts-is-a-leaf']);
    expect(rulesFor('@atlas/platform-nexus')).toEqual(['nexus-allowlist']);
    expect(rulesFor('@atlas/platform-jobs')).toEqual(['undeclared-dependency', 'platform-never-dungeons-or-apps']);
    expect(rulesFor('@atlas/dungeon-writing')).toEqual(['dungeons-are-isolated', 'missing-tsconfig-reference', 'dungeons-are-isolated']);
    expect(rulesFor('@atlas/runtime-local')).toEqual(['runtimes-never-dungeons-or-apps']);
    expect(rulesFor('@atlas/app-web')).toEqual(['unknown-package']);
    expect(rulesFor('@atlas/dungeon-music')).toEqual([]);
    expect(rulesFor('@atlas/platform-storage')).toEqual([]);

    const jobsImport = report.violations.find((v) => v.package === '@atlas/platform-jobs' && v.rule === 'platform-never-dungeons-or-apps');
    expect(jobsImport?.location).toBe('platform/jobs/src/index.ts:1');

    const { stderr } = run(root);
    expect(stderr).toContain('[nexus-allowlist] @atlas/platform-nexus');
    expect(stderr).toContain('at platform/jobs/src/index.ts:1');
  });

  it('accepts the real repository', () => {
    const { status, stderr } = run(REPO_ROOT);
    expect(stderr).toBe('');
    expect(status).toBe(0);
  });
});
