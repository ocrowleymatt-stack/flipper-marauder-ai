import type { EventEnvelope, Provenance } from '@atlas/contracts';

export interface ToolDefinition {
  id: string;
  version: string;
  inputSchema: object;
  outputSchema: object;
  requiredCapabilities: string[];
  sideEffect: 'none' | 'reversible' | 'irreversible';
}

export interface JobHandlerDefinition {
  jobType: string;
  version: string;
  inputSchema: object;
  requiredCapabilities: string[];
}

export interface PluginManifest {
  id: string;
  version: string;
  contractsVersion: string;
  tools: ToolDefinition[];
  jobs: JobHandlerDefinition[];
  subscribedEvents: EventEnvelope['eventType'][];
  uiPanels: Array<{ id: string; title: string; requiredCapabilities: string[] }>;
}

export interface ToolResult<T = unknown> {
  value: T;
  provenance: Provenance;
}
