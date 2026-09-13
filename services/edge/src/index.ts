import type { Capability } from "@atlas-vnext/contracts";

/** Edge issues capabilities. It does not execute providers. */
export function issueSessionGrant(subject: string, projectId: string): Capability {
  const now = new Date();
  const expires = new Date(now.getTime() + 60 * 60 * 1000);
  return {
    id: `cap:${subject}:${now.toISOString()}`,
    issuer: "edge",
    subject,
    action: "provider:invoke",
    resource: `project:${projectId}`,
    notBefore: now.toISOString(),
    expiresAt: expires.toISOString(),
    caveats: [{ type: "project", value: projectId }],
    proof: "stub",
  };
}
