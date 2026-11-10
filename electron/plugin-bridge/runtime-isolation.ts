import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { hostHomes } from './discovery.js';
import { object, readBoundedFile } from './files.js';

/** Codex merges nested settings; an empty mcp_servers object does not erase
 * inherited entries. Explicitly disable each inherited entry and all plugins.
 * Reading project config here suppresses inheritance, never discovers imports. */
export function codexIsolationConfig(cwd?: string): Record<string, unknown> {
  const files = new Set([
    join(hostHomes().codex, 'config.toml'),
    '/etc/codex/config.toml',
    '/etc/codex/managed_config.toml',
  ]);
  if (cwd) {
    let current = resolve(cwd);
    for (let depth = 0; depth < 64; depth++) {
      files.add(join(current, '.codex', 'config.toml'));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  // Disable inherited servers, including kai-mcp when installed. A synthetic
  // disabled entry without command/url is still invalid in the Codex CLI.
  const names = new Set<string>();
  const plugins = new Set<string>();
  for (const file of files) {
    if (!existsSync(file)) continue;
    let config: Record<string, unknown>;
    try {
      config = parse(readBoundedFile(file));
    } catch {
      throw new Error(
        'Cannot isolate inherited Codex MCP configuration. Repair the host configuration before starting this runtime.',
      );
    }
    for (const settings of [config, ...Object.values(object(config.profiles)).map(object)]) {
      Object.keys(object(settings.mcp_servers)).forEach((name) => names.add(name));
      Object.keys(object(settings.plugins)).forEach((name) => plugins.add(name));
    }
  }
  return {
    // Older CLIs use the plugins feature switch; newer CLIs use the default
    // plugin policy below. Apply both so a host CLI fallback cannot load
    // installed plugins behind Kai's separate approval state.
    features: {
      plugins: false,
      remote_plugin: false,
      hooks: false,
      codex_hooks: false,
      tool_search_always_defer_mcp_tools: false,
    },
    mcp_servers: Object.fromEntries([...names].map((name) => [name, { enabled: false }])),
    plugins: {
      ...Object.fromEntries([...plugins].map((name) => [name, { enabled: false }])),
      _default: { enabled: false },
    },
  };
}
