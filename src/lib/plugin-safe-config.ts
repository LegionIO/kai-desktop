import { toPluginSafeConfig, type PluginSafeConfig } from '../../electron/plugins/safe-config';
import type { AppConfig } from '../../electron/config/schema';

/**
 * Plugin frontend components run third-party, less-trusted code and have no
 * renderer-side equivalent of the backend's `config:read-secrets` permission
 * gate — so unlike `api.config.get()` in backend.js (which returns the full
 * config only for plugins that declared that permission), every plugin UI
 * gets the same redacted view here regardless of its declared permissions.
 * `useConfig()` intentionally holds the FULL unredacted app config (so
 * Kai's own first-party Settings screens can show/edit real API keys) —
 * never pass that value to a plugin `<Component>` without going through
 * this first.
 */
export function toPluginFrontendConfig(config: Record<string, unknown> | null): PluginSafeConfig | undefined {
  if (!config) return undefined;
  return toPluginSafeConfig(config as unknown as AppConfig);
}
