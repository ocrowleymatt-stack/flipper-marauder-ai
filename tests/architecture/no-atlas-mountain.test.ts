import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { REPO_ROOT, rel, rules, walk, workspacePackageJsons } from "./helpers.ts";

describe("no Atlas Mountain internals in product code", () => {
  it("workspace package.json files do not depend on Mountain packages", () => {
    const hits: string[] = [];
    for (const { pkg } of workspacePackageJsons()) {
      const all = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      for (const name of Object.keys(all)) {
        if (rules.forbiddenDependencyNames.includes(name) || name.includes("atlas-mountain")) {
          hits.push(`${pkg.name}: ${name}`);
        }
      }
    }
    assert.deepEqual(hits, []);
  });

  it("source and config do not import Mountain paths", () => {
    const hits: string[] = [];
    const files = walk(REPO_ROOT).filter((p) => {
      const r = rel(p);
      if (r.startsWith("docs/")) return false;
      if (r.startsWith("tests/architecture/")) return false;
      return /\.(ts|js|mjs|json|yml|yaml)$/.test(r);
    });
    for (const file of files) {
      if (rel(file) === "architecture/dependency-rules.json") continue;
      const text = readFileSync(file, "utf8");
      for (const needle of rules.forbiddenImportSubstrings) {
        if (text.includes(needle)) hits.push(`${rel(file)} contains ${needle}`);
      }
    }
    assert.deepEqual(hits, []);
  });
});
