import type { PluginPermission } from './types.js';

export function assertPluginBrowserConfigWriteAllowed(path: string, permissions: readonly PluginPermission[]): void {
  // Config setters normalize dotted paths by dropping empty segments. Apply the
  // same normalization at the permission boundary so aliases such as
  // `.browser.scriptPolicy` cannot bypass this guard and then resolve to the
  // protected Browser root in the authoritative setter.
  const root = path.split('.').find((segment) => segment.length > 0);
  if (root === 'browser' && !permissions.includes('browser:authenticated-session')) {
    throw new Error('Writing Browser settings ("browser.*") requires the "browser:authenticated-session" permission.');
  }
}
