import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { REPO_ROOT, extractImports, rel, rules, tsSources } from "./helpers.ts";

describe("execution broker is not bypassed", () => {
  it("only the broker may import provider-spi", () => {
    const violations: string[] = [];
    for (const file of tsSources(REPO_ROOT).filter((p) => !rel(p).startsWith("packages/provider-spi/"))) {
      const imports = extractImports(readFileSync(file, "utf8"));
      const fromBroker = rel(file).startsWith("services/broker/");
      for (const spec of imports) {
        if (rules.brokerOnlyPackages.includes(spec) && !fromBroker) {
          violations.push(`${rel(file)} imports broker-only ${spec}`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  it("Nexus does not call fetch or instantiate adapters", () => {
    const violations: string[] = [];
    for (const file of tsSources(join(REPO_ROOT, "services/nexus"))) {
      const text = readFileSync(file, "utf8");
      if (/\bfetch\s*\(/.test(text)) violations.push(`${rel(file)} calls fetch`);
      if (/\bnew\s+\w*Adapter\b/.test(text)) violations.push(`${rel(file)} constructs an adapter`);
      if (/\bcomplete\s*\(/.test(text)) violations.push(`${rel(file)} looks like a provider call`);
    }
    assert.deepEqual(violations, []);
  });

  it("dungeons do not invoke execute themselves by importing the broker", () => {
    const violations: string[] = [];
    for (const file of tsSources(join(REPO_ROOT, "dungeons"))) {
      for (const spec of extractImports(readFileSync(file, "utf8"))) {
        if (spec === "@atlas-vnext/broker") violations.push(`${rel(file)} imports broker`);
      }
    }
    assert.deepEqual(violations, []);
  });
});
