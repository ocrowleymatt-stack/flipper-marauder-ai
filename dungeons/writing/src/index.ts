import { defineDungeon } from "@atlas-vnext/plugin-sdk";

/** Stub plugin. Product behaviour is later gates. */
export const plugin = defineDungeon({
  id: "writing",
  jobTypes: ["writing.commission"],
  tools: [],
});
