import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolve } from "@atlas-vnext/nexus";
import type { Capability } from "@atlas-vnext/contracts";

const cap: Capability = {
  id: "c",
  issuer: "edge",
  subject: "user:1",
  action: "provider:invoke",
  resource: "project:p",
  notBefore: "2020-01-01T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  caveats: [],
  proof: "stub",
};

describe("Nexus resolver stub", () => {
  it("normalizes auto to a canonical capability and returns an intent", () => {
    const intent = resolve({
      target: "auto",
      projectId: "p",
      correlationId: "corr",
      capabilities: [cap],
      text: "hello",
    });
    assert.equal(intent.capabilityId, "nexus/reason");
    assert.ok(intent.chain.length >= 1);
    assert.equal(intent.policy.localOnly, false);
  });

  it("marks private as localOnly", () => {
    const intent = resolve({
      target: "nexus/private",
      projectId: "p",
      correlationId: "corr",
      capabilities: [cap],
      text: "secret",
    });
    assert.equal(intent.policy.localOnly, true);
    assert.deepEqual(intent.chain, ["local/chat"]);
  });
});
