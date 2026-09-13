import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, "../..");

export function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export type DepRules = {
  workspaces: string[];
  nexus: { package: string; src: string; maxProdLines: number; maxFiles: number; allowedDependencies: string[] };
  packages: Record<string, { mayDependOn: string[] }>;
  forbiddenDependencyNames: string[];
  forbiddenImportSubstrings: string[];
  brokerOnlyPackages: string[];
  dungeonPackagePrefix: string;
};

export const rules = loadJson<DepRules>(join(REPO_ROOT, "architecture/dependency-rules.json"));

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".github"]);

export function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

export function workspacePackageJsons(): { dir: string; pkg: Record<string, unknown> }[] {
  const found: { dir: string; pkg: Record<string, unknown> }[] = [];
  for (const glob of rules.workspaces) {
    const [top, child] = glob.split("/");
    if (!top || child !== "*") continue;
    const parent = join(REPO_ROOT, top);
    if (!existsSync(parent)) continue;
    for (const name of readdirSync(parent)) {
      const dir = join(parent, name);
      const pj = join(dir, "package.json");
      if (existsSync(pj)) found.push({ dir, pkg: loadJson(pj) });
    }
  }
  return found;
}

const IMPORT_RE =
  /(?:(?:import|export)\s+(?:type\s+)?(?:[^'"\n]+from\s+)?|import\s*\(\s*)['"]([^'"]+)['"]/g;

export function extractImports(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    if (match[1]) out.push(match[1]);
  }
  return out;
}

export function tsSources(root: string): string[] {
  return walk(root).filter((p) => p.endsWith(".ts") && !p.endsWith(".d.ts") && !p.includes("/test/") && !p.includes(".test."));
}

export function countLines(files: string[]): number {
  return files.reduce((n, f) => n + readFileSync(f, "utf8").split(/\r?\n/).length, 0);
}

export function rel(path: string): string {
  return relative(REPO_ROOT, path);
}
