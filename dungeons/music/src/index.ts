import { defineDungeon } from "@atlas-vnext/plugin-sdk";

/** Stub plugin. Product behaviour is later gates. */
export const plugin = defineDungeon({
  id: "music",
  jobTypes: ["music.render"],
  tools: [],
});
