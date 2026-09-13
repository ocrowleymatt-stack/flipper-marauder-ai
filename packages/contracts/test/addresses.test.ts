import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertContentAddress, isContentAddress } from "@atlas-vnext/contracts";

describe("content addresses", () => {
  it("accepts sha256 locators only", () => {
    const ok = `cas:sha256:${"ab".repeat(32)}`;
    assert.equal(isContentAddress(ok), true);
    assert.equal(assertContentAddress(ok), ok);
    assert.equal(isContentAddress("cas:sha1:deadbeef"), false);
    assert.throws(() => assertContentAddress("./attachments/x"));
  });
});
