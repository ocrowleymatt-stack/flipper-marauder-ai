import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  REPO_ROOT,
  extractImports,
  rel,
  rules,
  tsSources,
  workspacePackageJsons,
} from "./helpers.ts";

function workspaceOf(file: string): string | undefined {
  const relPath = rel(file);
  if (relPath.startsWith("packages/contracts/")) return "@atlas-vnext/contracts";
  if (relPath.startsWith("packages/plugin-sdk/")) return "@atlas-vnext/plugin-sdk";
  if (relPath.startsWith("packages/provider-spi/")) return "@atlas-vnext/provider-spi";
  if (relPath.startsWith("packages/storage/")) return "@atlas-vnext/storage";
  if (relPath.startsWith("packages/eval/")) return "@atlas-vnext/eval";
  if (relPath.startsWith("services/nexus/")) return "@atlas-vnext/nexus";
  if (relPath.startsWith("services/broker/")) return "@atlas-vnext/broker";
  if (relPath.startsWith("services/edge/")) return "@atlas-vnext/edge";
  if (relPath.startsWith("apps/shell/")) return "@atlas-vnext/shell";
  const dungeon = /^dungeons\/([^/]+)\//.exec(relPath);
  if (dungeon?.[1]) return `@atlas-vnext/dungeon-${dungeon[1]}`;
  return undefined;
}

describe("dependency graph isolation", () => {
  it("every workspace package is declared in dependency-rules.json", () => {
    const pkgs = workspacePackageJsons().map((p) => String(p.pkg.name));
    for (const name of pkgs) {
      assert.ok(rules.packages[name], `undeclared workspace package ${name}`);
    }
  });

  it("package.json dependencies stay inside the allow list", () => {
    const violations: string[] = [];
    for (const { pkg } of workspacePackageJsons()) {
      const name = String(pkg.name);
      const allowed = new Set(rules.packages[name]?.mayDependOn ?? []);
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.peerDependencies as Record<string, string> | undefined),
      };
      for (const dep of Object.keys(deps)) {
        if (dep.startsWith("@atlas-vnext/") && !allowed.has(dep)) {
          violations.push(`${name} → ${dep}`);
        }
        if (rules.forbiddenDependencyNames.includes(dep)) {
          violations.push(`${name} forbidden dep ${dep}`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  it("dungeons do not import each other, Nexus, provider-spi, or storage", () => {
    const violations: string[] = [];
    for (const file of tsSources(join(REPO_ROOT, "dungeons"))) {
      const from = workspaceOf(file);
      for (const spec of extractImports(readFileSync(file, "utf8"))) {
        if (spec.startsWith("@atlas-vnext/dungeon-") && spec !== from) {
          violations.push(`${rel(file)} imports ${spec}`);
        }
        if (spec === "@atlas-vnext/nexus" || spec === "@atlas-vnext/provider-spi" || spec === "@atlas-vnext/storage") {
          violations.push(`${rel(file)} imports ${spec}`);
        }
        if (spec.includes("atlas-mountain")) violations.push(`${rel(file)} imports ${spec}`);
      }
    }
    assert.deepEqual(violations, []);
  });

  it("Nexus source only imports contracts", () => {
    const violations: string[] = [];
    for (const file of tsSources(join(REPO_ROOT, "services/nexus"))) {
      for (const spec of extractImports(readFileSync(file, "utf8"))) {
        if (spec.startsWith(".")) continue;
        if (spec !== "@atlas-vnext/contracts") {
          violations.push(`${rel(file)} imports ${spec}`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });
});
