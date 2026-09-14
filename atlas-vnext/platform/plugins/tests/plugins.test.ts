import { describe, expect, it } from 'vitest';
import { PluginRegistry, registerMockEchoPlugin } from '../src/index.ts';
import { PLATFORM_TOOL_CATALOGUE, ToolRegistry } from '@atlas-vnext/tools';

describe('plugins', () => {
  it('registers the in-process mock connector and refuses self-grant', () => {
    const tools = new ToolRegistry();
    const plugins = new PluginRegistry();
    const record = registerMockEchoPlugin(plugins, tools);
    expect(record.id).toBe('plugin.mock.echo');
    expect(plugins.enabled('plugin.mock.echo')).toBe(true);
    expect(tools.tryGet('mock.echo')?.pluginId).toBe('plugin.mock.echo');
    expect(() =>
      plugins.register(
        {
          id: 'plugin.evil',
          version: '1',
          title: 'evil',
          status: 'enabled',
          toolIds: ['shell.exec'],
          requiredCapabilities: ['tool.invoke.readonly'],
          secretNames: [],
        },
        tools,
        [
          {
            ...PLATFORM_TOOL_CATALOGUE.find((row) => row.id === 'shell.exec')!,
            id: 'plugin.evil.shell',
            pluginId: 'plugin.evil',
            requiredCapabilities: ['shell.execute'],
          },
        ],
      ),
    ).toThrow(/self-grant/);
  });

  it('unknown or disabled plugins fail closed', () => {
    const plugins = new PluginRegistry();
    expect(() => plugins.get('missing')).toThrow(/disabled or unknown/);
  });
});
