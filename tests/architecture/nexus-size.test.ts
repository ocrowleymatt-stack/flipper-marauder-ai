import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { REPO_ROOT, countLines, loadJson, rel, rules, tsSources } from "./helpers.ts";

const budget = loadJson<{ maxProdLines: number; maxFiles: number; forbiddenIdentifiers: string[] }>(
  join(REPO_ROOT, "architecture/nexus-budget.json"),
);

describe("Nexus stays small and boring", () => {
  const srcDir = join(REPO_ROOT, rules.nexus.src);
  const files = tsSources(srcDir);

  it("does not exceed the file budget", () => {
    assert.ok(
      files.length <= budget.maxFiles,
      `Nexus has ${files.length} production files; max ${budget.maxFiles}: ${files.map(rel).join(", ")}`,
    );
  });

  it("does not exceed the line budget", () => {
    const lines = countLines(files);
    assert.ok(lines <= budget.maxProdLines, `Nexus production lines ${lines} > ${budget.maxProdLines}`);
  });

  it("does not contain vendor or job-domain identifiers", () => {
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const id of budget.forbiddenIdentifiers) {
        const re = new RegExp(`\\b${id}\\b`);
        if (re.test(text)) hits.push(`${rel(file)}:${id}`);
      }
    }
    assert.deepEqual(hits, [], `Nexus gained domain/vendor logic: ${hits.join(", ")}`);
  });

  it("only depends on contracts", () => {
    const pkg = loadJson<{ dependencies?: Record<string, string> }>(join(REPO_ROOT, "services/nexus/package.json"));
    const deps = Object.keys(pkg.dependencies ?? {});
    assert.deepEqual(deps.sort(), [...rules.nexus.allowedDependencies].sort());
  });
});
