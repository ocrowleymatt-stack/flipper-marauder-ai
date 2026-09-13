export interface Project {
  id: string;
  tenantId: string;
  name: string;
  createdAt: string;
  settingsSchemaVersion: number;
  settings: Record<string, unknown>;
}
