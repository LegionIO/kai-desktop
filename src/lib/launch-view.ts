import type { SidebarTab } from '../../electron/config/schema';

export type LaunchViewDecision =
  | { kind: 'wait' }
  | { kind: 'skip' }
  | { kind: 'go'; section: SidebarTab; view: string };

const BUILTIN_VIEWS: Partial<Record<string, { section: SidebarTab; view: string }>> = {
  tasks: { section: 'tasks', view: 'tasks' },
  agents: { section: 'agents', view: 'agents' },
  alerts: { section: 'alerts', view: 'alerts' },
  plugins: { section: 'plugins', view: 'marketplace' },
};

/** Decide where ui.launchView sends the window right now. 'chats' / unknown → skip (the default
 *  chat view is already showing); a plugin target waits until it is active with a visible panel. */
export function resolveLaunchView(
  target: string,
  pluginStatuses: Record<string, string> | undefined,
  panels: ReadonlyArray<{ pluginName: string; id: string; visible: boolean }> | undefined,
): LaunchViewDecision {
  if (!target.startsWith('plugin:')) {
    const builtin = BUILTIN_VIEWS[target];
    return builtin ? { kind: 'go', ...builtin } : { kind: 'skip' };
  }
  const name = target.slice('plugin:'.length);
  const status = pluginStatuses?.[name];
  if (status === 'error') return { kind: 'skip' };
  const panel = panels?.find((p) => p.visible && p.pluginName === name);
  if (status !== 'active' || !panel) return { kind: 'wait' };
  return { kind: 'go', section: 'plugins', view: `plugin-panel:${name}:${panel.id}` };
}
