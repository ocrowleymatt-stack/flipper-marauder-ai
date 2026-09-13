import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CONTENT_ADDRESS_RE, isContentAddress } from "@atlas-vnext/contracts";
import { MemoryContentStore } from "@atlas-vnext/storage";
import { REPO_ROOT, loadJson } from "./helpers.ts";

describe("storage is content-addressed at the boundary", () => {
  const addressSchema = loadJson<{ pattern: string; type: string }>(
    join(REPO_ROOT, "packages/contracts/schemas/storage-address.schema.json"),
  );
  const putSchema = loadJson<Record<string, unknown>>(
    join(REPO_ROOT, "packages/contracts/schemas/storage-put.schema.json"),
  );

  it("schema only allows cas:sha256 hex locators", () => {
    assert.equal(addressSchema.type, "string");
    assert.equal(addressSchema.pattern, CONTENT_ADDRESS_RE.source);
    assert.equal(isContentAddress("cas:sha256:" + "a".repeat(64)), true);
    assert.equal(isContentAddress("/var/lib/atlas/attachments/foo.bin"), false);
    assert.equal(isContentAddress("file://tmp/out"), false);
  });

  it("storage put schema forbids path locators", () => {
    const not = putSchema.not as { anyOf: { required: string[] }[] };
    const forbidden = not.anyOf.flatMap((x) => x.required);
    for (const key of ["path", "filesystemPath", "filename"]) {
      assert.ok(forbidden.includes(key), `put schema must forbid ${key}`);
    }
  });

  it("memory store returns a content address and rejects non-CAS get via assert", async () => {
    const store = new MemoryContentStore();
    const bytes = new TextEncoder().encode("hello vnext");
    const addr = await store.put(bytes, {
      source: "test",
      retrievedAt: new Date().toISOString(),
      method: "cas",
      evidentialStatus: "primary",
    }, "text/plain");
    assert.match(addr, CONTENT_ADDRESS_RE);
    const roundTrip = await store.get(addr);
    assert.equal(Buffer.from(roundTrip).toString(), "hello vnext");
  });

  it("TypeScript ContentStore.put signature lives in storage package source", () => {
    const src = readFileSync(join(REPO_ROOT, "packages/storage/src/index.ts"), "utf8");
    assert.match(src, /put\(bytes: Uint8Array, provenance: Provenance/);
    assert.doesNotMatch(src, /put\(path:/);
  });
});
