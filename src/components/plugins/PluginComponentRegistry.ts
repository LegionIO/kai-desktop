import type { ComponentType } from 'react';

type PluginComponentProps = {
  pluginName: string;
  props?: Record<string, unknown>;
  onAction: (action: string, data?: unknown) => Promise<unknown>;
  onClose?: () => void;
  // Redacted view of the app config (secrets stripped) — see
  // src/lib/plugin-safe-config.ts. There is intentionally no `updateConfig`
  // here: that would let any plugin write arbitrary config paths with no
  // permission check at all; `setPluginConfig` below is the actual,
  // permission-gated mechanism for a plugin to persist its own settings.
  config?: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  pluginState?: Record<string, unknown>;
  setPluginConfig?: (path: string, value: unknown) => Promise<void>;
};

export type PluginComponent = ComponentType<PluginComponentProps>;

// Maps pluginName → { componentName → React Component }
const registry = new Map<string, Map<string, PluginComponent>>();

export function registerPluginComponents(pluginName: string, components: Record<string, PluginComponent>): void {
  let pluginMap = registry.get(pluginName);
  if (!pluginMap) {
    pluginMap = new Map();
    registry.set(pluginName, pluginMap);
  }
  for (const [name, component] of Object.entries(components)) {
    pluginMap.set(name, component);
  }
}

export function getPluginComponent(pluginName: string, componentName: string): PluginComponent | null {
  return registry.get(pluginName)?.get(componentName) ?? null;
}

export function getPluginComponentByHint(
  pluginName: string,
  preferred: string,
  hints: string[],
  fuzzyKeyword?: string,
): PluginComponent | null {
  const pluginMap = registry.get(pluginName);
  if (!pluginMap || pluginMap.size === 0) return null;
  // 1. Exact match on preferred name
  const exact = pluginMap.get(preferred);
  if (exact) return exact;
  // 2. Try hint names (case-insensitive)
  for (const hint of hints) {
    const lower = hint.toLowerCase();
    for (const [key, component] of pluginMap) {
      if (key.toLowerCase() === lower) return component;
    }
  }
  // 3. Fuzzy: find any component whose name contains the keyword (case-insensitive)
  const keyword = (fuzzyKeyword ?? preferred).toLowerCase();
  for (const [key, component] of pluginMap) {
    if (key.toLowerCase().includes(keyword)) return component;
  }
  return null;
}

export function hasPluginComponents(pluginName: string): boolean {
  return registry.has(pluginName) && (registry.get(pluginName)?.size ?? 0) > 0;
}
