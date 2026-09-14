import type { PluginRecord, ToolDefinition } from '@atlas-vnext/contracts';
import { PLATFORM_TOOL_CATALOGUE, ToolError, type ToolRegistry } from '@atlas-vnext/tools';

export class PluginRegistry {
  private readonly plugins = new Map<string, PluginRecord>();

  register(record: PluginRecord, tools: ToolRegistry, definitions: ToolDefinition[]): PluginRecord {
    if (record.status === 'unknown') {
      throw new ToolError('plugin_unknown', `Fail-closed: unknown plugin ${record.id}.`, false);
    }
    for (const definition of definitions) {
      if (definition.pluginId !== record.id) {
        throw new ToolError('plugin_boundary', 'Fail-closed: plugin cannot register tools for another identity.', false);
      }
      const extra = definition.requiredCapabilities.filter(
        (cap: ToolDefinition['requiredCapabilities'][number]) => !record.requiredCapabilities.includes(cap),
      );
      if (extra.length > 0) {
        throw new ToolError(
          'plugin_cannot_self_grant',
          'Fail-closed: plugin cannot self-grant Authority capabilities.',
          false,
        );
      }
      tools.register(definition);
    }
    this.plugins.set(record.id, record);
    return record;
  }

  get(id: string): PluginRecord {
    const found = this.plugins.get(id);
    if (!found || found.status === 'disabled' || found.status === 'unknown') {
      throw new ToolError('plugin_disabled', `Fail-closed: plugin ${id} is disabled or unknown.`, false);
    }
    return found;
  }

  enabled(id: string): boolean {
    const found = this.plugins.get(id);
    return found?.status === 'enabled';
  }

  list(): PluginRecord[] {
    return [...this.plugins.values()];
  }
}

export const MOCK_ECHO_PLUGIN: PluginRecord = {
  id: 'plugin.mock.echo',
  version: '1.0.0',
  title: 'Mock echo connector',
  status: 'enabled',
  toolIds: ['mock.echo'],
  requiredCapabilities: ['tool.invoke.readonly'],
  secretNames: [],
  rateLimitPerMinute: 60,
  externalBinding: 'in-process',
};

export function registerMockEchoPlugin(plugins: PluginRegistry, tools: ToolRegistry): PluginRecord {
  const definition = PLATFORM_TOOL_CATALOGUE.find((row) => row.id === 'mock.echo');
  if (!definition) throw new Error('mock.echo catalogue entry missing');
  return plugins.register(MOCK_ECHO_PLUGIN, tools, [definition]);
}
