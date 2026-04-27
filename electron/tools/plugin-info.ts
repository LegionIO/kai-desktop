import { z } from 'zod';
import type { ToolDefinition } from './types.js';

/**
 * Creates a tool that allows the LLM to query information about installed plugins.
 * This provides on-demand plugin discovery and metadata lookup.
 */
export function createPluginInfoTool(getPluginManager: () => {
  listPlugins: () => Array<{
    name: string;
    displayName: string;
    version: string;
    description: string;
    state: string;
    brandRequired: boolean;
    error?: string;
  }>;
  getPluginInstance: (pluginName: string) => {
    manifest: {
      name: string;
      displayName: string;
      version: string;
      description: string;
      author?: string;
      permissions: string[];
    };
    registeredTools: ToolDefinition[];
    state: string;
  } | null;
}): ToolDefinition {
  return {
    name: 'get_plugin_info',
    description: 'Get information about installed plugins. Use this to learn what plugins are available, what they do, and what tools they provide. Can list all plugins or get detailed info about a specific plugin by name.',
    inputSchema: z.object({
      pluginName: z.string().optional().describe('The name of a specific plugin to get details about. Omit to list all installed plugins.'),
      includeTools: z.boolean().optional().describe('Include the list of tools provided by the plugin(s). Default: false.'),
      includePermissions: z.boolean().optional().describe('Include the permissions requested by the plugin(s). Default: false.'),
      activeOnly: z.boolean().optional().describe('Only return plugins that are currently active (exclude disabled/error/loading). Default: true.'),
    }),
    source: 'builtin',
    execute: async (input) => {
      const payload = input as {
        pluginName?: string;
        includeTools?: boolean;
        includePermissions?: boolean;
        activeOnly?: boolean;
      };

      const pluginManager = getPluginManager();
      const allPlugins = pluginManager.listPlugins();
      const activeOnly = payload.activeOnly !== false;

      // Filter plugins
      let plugins = activeOnly
        ? allPlugins.filter((p) => p.state === 'active')
        : allPlugins;

      // Specific plugin lookup
      if (payload.pluginName) {
        const needle = payload.pluginName.toLowerCase();
        const plugin = plugins.find(
          (p) => p.name.toLowerCase() === needle || p.displayName.toLowerCase() === needle
        );

        if (!plugin) {
          return {
            error: `Plugin "${payload.pluginName}" not found. Available plugins: ${plugins.map((p) => p.name).join(', ')}`,
          };
        }

        // Get detailed info from plugin instance
        const instance = pluginManager.getPluginInstance(plugin.name);
        const result: Record<string, unknown> = {
          name: plugin.name,
          displayName: plugin.displayName,
          version: plugin.version,
          description: plugin.description,
          state: plugin.state,
          author: instance?.manifest.author,
        };

        if (plugin.error) {
          result.error = plugin.error;
        }

        if (payload.includeTools && instance) {
          result.tools = instance.registeredTools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            source: tool.source,
          }));
          result.toolCount = instance.registeredTools.length;
        }

        if (payload.includePermissions && instance) {
          result.permissions = instance.manifest.permissions;
        }

        return result;
      }

      // List all plugins
      const pluginList = plugins.map((p) => {
        const instance = pluginManager.getPluginInstance(p.name);
        const summary: Record<string, unknown> = {
          name: p.name,
          displayName: p.displayName,
          version: p.version,
          description: p.description,
          state: p.state,
        };

        if (p.error) {
          summary.error = p.error;
        }

        if (payload.includeTools && instance) {
          const toolSummaries = instance.registeredTools.map((t) => ({
            name: t.name,
            description: t.description,
          }));
          summary.toolCount = toolSummaries.length;
          summary.tools = toolSummaries;
        }

        if (payload.includePermissions && instance) {
          summary.permissions = instance.manifest.permissions;
        }

        return summary;
      });

      return {
        count: pluginList.length,
        plugins: pluginList,
      };
    },
  };
}
