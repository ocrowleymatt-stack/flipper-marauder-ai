import type { Job, VNextEvent } from "@atlas-vnext/contracts";

export interface ToolSpec {
  id: string;
  requiredAction: `${string}:${string}`;
}

export interface DungeonPlugin {
  id: string;
  jobTypes: string[];
  tools: ToolSpec[];
  /** Domain handlers receive jobs from the broker only. */
  handleJob?(job: Job): Promise<VNextEvent[]>;
}

export function defineDungeon(plugin: DungeonPlugin): DungeonPlugin {
  return plugin;
}
