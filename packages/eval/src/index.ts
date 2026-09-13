import type { CapabilityId } from "@atlas-vnext/contracts";

/** Routing eval harness lands in a later gate. */
export interface EvalFixture {
  prompt: string;
  expectedCapability: CapabilityId;
}

export function listFixtures(): EvalFixture[] {
  return [];
}
