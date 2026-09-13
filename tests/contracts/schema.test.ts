import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Capability, ExecutionIntent, Job, Project, VNextEvent } from "@atlas-vnext/contracts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCHEMA_DIR = join(ROOT, "packages/contracts/schemas");

const REF_TO_ID: Record<string, string> = {
  "./storage-address.schema.json": "https://atlas-vnext.local/schemas/storage-address.json",
  "./provenance.schema.json": "https://atlas-vnext.local/schemas/provenance.json",
  "./capability.schema.json": "https://atlas-vnext.local/schemas/capability.json",
  "./execution-intent.schema.json": "https://atlas-vnext.local/schemas/execution-intent.json",
};

function rewrite(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewrite);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = k === "$ref" && typeof v === "string" && REF_TO_ID[v] ? REF_TO_ID[v] : rewrite(v);
    }
    return out;
  }
  return value;
}

function makeAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  for (const file of readdirSync(SCHEMA_DIR)) {
    if (!file.endsWith(".schema.json")) continue;
    const raw = JSON.parse(readFileSync(join(SCHEMA_DIR, file), "utf8"));
    ajv.addSchema(rewrite(raw));
  }
  return ajv;
}

const digest = "a".repeat(64);
const cas = `cas:sha256:${digest}`;
const now = "2026-09-13T18:00:00.000Z";

const capability: Capability = {
  id: "cap-1",
  issuer: "edge",
  subject: "user:matt",
  action: "provider:invoke",
  resource: "project:p1",
  notBefore: now,
  expiresAt: "2026-09-13T20:00:00.000Z",
  caveats: [],
  proof: "stub",
};

describe("JSON schemas", () => {
  const ajv = makeAjv();

  it("every schema file loads", () => {
    const files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".schema.json"));
    assert.ok(files.length >= 8);
    for (const file of files) {
      JSON.parse(readFileSync(join(SCHEMA_DIR, file), "utf8"));
    }
  });

  it("accepts a valid execution intent and job", () => {
    const intent: ExecutionIntent = {
      correlationId: "c1",
      projectId: "p1",
      capabilityId: "nexus/reason",
      chain: ["owned/reason"],
      policy: { localOnly: false },
      input: { kind: "inline", text: "hello" },
      capabilities: [capability],
    };
    const validateIntent = ajv.getSchema("https://atlas-vnext.local/schemas/execution-intent.json");
    assert.ok(validateIntent);
    assert.equal(validateIntent(intent), true, JSON.stringify(validateIntent.errors));

    const job: Job = {
      id: "j1",
      projectId: "p1",
      type: "writing.commission",
      status: "queued",
      idempotencyKey: "k1",
      createdAt: now,
      updatedAt: now,
      correlationId: "c1",
      checkpoint: cas,
    };
    const validateJob = ajv.getSchema("https://atlas-vnext.local/schemas/job.json");
    assert.ok(validateJob);
    assert.equal(validateJob(job), true, JSON.stringify(validateJob.errors));
  });

  it("rejects path locators as content addresses", () => {
    const validate = ajv.getSchema("https://atlas-vnext.local/schemas/storage-address.json");
    assert.ok(validate);
    assert.equal(validate("/tmp/file.bin"), false);
    assert.equal(validate(cas), true);
  });

  it("rejects role-shaped capabilities", () => {
    const validate = ajv.getSchema("https://atlas-vnext.local/schemas/capability.json");
    assert.ok(validate);
    const withRoles = { ...capability, roles: ["admin"] };
    assert.equal(validate(withRoles), false);
  });

  it("accepts project and event envelopes", () => {
    const project: Project = {
      id: "p1",
      tenantId: "t1",
      name: "Atlas",
      createdAt: now,
      settingsSchemaVersion: 1,
      settings: {},
    };
    const event: VNextEvent = {
      id: "e1",
      sequence: 1,
      occurredAt: now,
      correlationId: "c1",
      projectId: "p1",
      type: "job:progress",
      payload: { progress: 0.2 },
    };
    const vp = ajv.getSchema("https://atlas-vnext.local/schemas/project.json");
    const ve = ajv.getSchema("https://atlas-vnext.local/schemas/event.json");
    assert.equal(vp?.(project), true, JSON.stringify(vp?.errors));
    assert.equal(ve?.(event), true, JSON.stringify(ve?.errors));
  });
});
