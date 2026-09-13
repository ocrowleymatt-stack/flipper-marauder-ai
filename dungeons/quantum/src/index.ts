import { defineDungeon } from "@atlas-vnext/plugin-sdk";

/** Stub plugin. Product behaviour is later gates. */
export const plugin = defineDungeon({
  id: "quantum",
  jobTypes: ["quantum.compile"],
  tools: [],
});
