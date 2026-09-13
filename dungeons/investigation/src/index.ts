import { defineDungeon } from "@atlas-vnext/plugin-sdk";

/** Stub plugin. Product behaviour is later gates. */
export const plugin = defineDungeon({
  id: "investigation",
  jobTypes: ["investigation.run"],
  tools: [],
});
