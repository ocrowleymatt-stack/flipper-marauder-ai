import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CapabilityDenied, execute } from "@atlas-vnext/broker";
import { resolve } from "@atlas-vnext/nexus";
import { issueSessionGrant } from "@atlas-vnext/edge";

describe("broker execute choke point", () => {
  it("accepts an intent that carries a provider:invoke capability", async () => {
    const grant = issueSessionGrant("user:1", "p1");
    const intent = resolve({
      target: "nexus/instant",
      projectId: "p1",
      correlationId: "corr-1",
      capabilities: [grant],
      text: "hi",
    });
    const events = await execute({ intent });
    assert.equal(events[0]?.type, "broker:accepted");
  });

  it("denies execution without the capability", async () => {
    const grant = issueSessionGrant("user:1", "p1");
    const intent = resolve({
      target: "nexus/instant",
      projectId: "p1",
      correlationId: "corr-2",
      capabilities: [{ ...grant, action: "storage:put" }],
      text: "hi",
    });
    await assert.rejects(() => execute({ intent }), CapabilityDenied);
  });
});
