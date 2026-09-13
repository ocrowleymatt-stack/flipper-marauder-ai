import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { REPO_ROOT, loadJson } from "./helpers.ts";

describe("permissions are capability-based at the boundary", () => {
  const cap = loadJson<Record<string, unknown>>(join(REPO_ROOT, "packages/contracts/schemas/capability.schema.json"));
  const execute = loadJson<Record<string, unknown>>(
    join(REPO_ROOT, "packages/contracts/schemas/execute-request.schema.json"),
  );
  const intent = loadJson<Record<string, unknown>>(
    join(REPO_ROOT, "packages/contracts/schemas/execution-intent.schema.json"),
  );

  it("capability schema forbids role and group fields", () => {
    const not = cap.not as { anyOf: { required: string[] }[] };
    const keys = not.anyOf.flatMap((x) => x.required);
    for (const key of ["roles", "groups", "role", "authentikGroups"]) {
      assert.ok(keys.includes(key), `capability schema must forbid ${key}`);
    }
    const required = cap.required as string[];
    assert.ok(required.includes("action"));
    assert.ok(required.includes("proof"));
    assert.ok(!required.includes("roles"));
  });

  it("execute request is only an intent, not a role bag", () => {
    const props = execute.properties as Record<string, unknown>;
    assert.deepEqual(Object.keys(props), ["intent"]);
    assert.equal(execute.additionalProperties, false);
  });

  it("execution intent requires capabilities and forbids roles", () => {
    const required = intent.required as string[];
    assert.ok(required.includes("capabilities"));
    const not = intent.not as { anyOf: { required: string[] }[] };
    const keys = not.anyOf.flatMap((x) => x.required);
    assert.ok(keys.includes("roles"));
    assert.ok(keys.includes("groups"));
  });

  it("broker execute implementation does not read roles", () => {
    const src = readFileSync(join(REPO_ROOT, "services/broker/src/execute.ts"), "utf8");
    assert.doesNotMatch(src, /\broles\b/);
    assert.doesNotMatch(src, /\bgroups\b/);
    assert.match(src, /intent\.capabilities/);
  });
});
