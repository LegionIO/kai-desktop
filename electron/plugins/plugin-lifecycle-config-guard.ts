/**
 * Guards that certain LIFECYCLE-control config paths are NOT writable through a
 * plugin's generic `config:write` permission. Enabling/disabling plugins decides
 * which plugin GENERATIONS load and MUST go through the freeze-aware, install-locked
 * lifecycle API (`disablePlugin`/`enablePlugin`) — never a config write. Otherwise a
 * plugin could add ITSELF to `pluginSystem.disabledPlugins` during a pre-update hook,
 * bypassing the app-update freeze, then reload next launch only as a disabled stub
 * whose post-update cleanup hook never registers — stranding privileged setup until
 * the ledger drops the debt (R28P54). Reserved for ALL plugins (no permission
 * suffices). Extracted as a pure function for direct unit testing.
 */
export function assertPluginLifecycleConfigWriteAllowed(path: string): void {
  // Normalize leading/duplicate separators so `..pluginSystem..disabledPlugins`
  // can't slip past a naive prefix check.
  const normalized = path.replace(/^\.+/, '').replace(/\.{2,}/g, '.');
  if (
    normalized === 'pluginSystem' ||
    normalized === 'pluginSystem.disabledPlugins' ||
    normalized.startsWith('pluginSystem.disabledPlugins.')
  ) {
    throw new Error(
      'Enabling/disabling plugins via config is not allowed; it must go through the plugin lifecycle API.',
    );
  }
}
