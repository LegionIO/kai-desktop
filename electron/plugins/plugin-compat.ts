import { satisfies } from 'semver';
import type { PluginManifest } from './types.js';

// ---------------------------------------------------------------------------
// Plugin Compatibility Checking
//
// This module validates that a plugin's declared constraints (engines.kai
// semver range + required capabilities) are satisfied by the current host.
//
// The plugin API version is injected at build time from branding.config.ts.
// White-label forks inherit or override it independently of their app version.
// ---------------------------------------------------------------------------

/** The host's plugin API version — injected at build time from branding. */
const HOST_PLUGIN_API_VERSION: string = __BRAND_PLUGIN_API_VERSION;

/**
 * Canonical capabilities this host exposes.
 *
 * Each entry maps to a concrete feature of the PluginAPI surface.
 * Permission-gated capabilities mirror the PluginPermission union.
 * Host-level capabilities represent broader platform features.
 *
 * White-label forks can add entries for custom capabilities they expose,
 * or remove entries for features they've stripped.
 */
const HOST_CAPABILITIES: ReadonlySet<string> = new Set([
  // ── Permission-gated capabilities (mirrors PluginPermission) ──
  'config:read',
  'config:write',
  'tools:register',
  'tools:detect',
  'ui:banner',
  'ui:modal',
  'ui:settings',
  'ui:panel',
  'ui:navigation',
  'messages:hook',
  'network:fetch',
  'auth:window',
  'http:listen',
  'notifications:send',
  'conversations:read',
  'conversations:write',
  'navigation:open',
  'state:publish',
  'agent:generate',
  'agent:inference-provider',
  'safe-storage',
  'browser:window',
  'exec:whitelisted',
  'system:env',
  'audit:log',
  'lifecycle:hook',

  // ── Host-level capabilities (not permission-gated) ──
  'marketplace',            // marketplace service is available
  'renderer-build',         // host can build frontend.js bundles
  'plugin-config-schema',   // host validates configSchema via Zod
]);

/**
 * Result of checking a plugin's compatibility constraints against the host.
 */
export type CompatCheckResult = {
  /** Whether all constraints are satisfied. */
  compatible: boolean;
  /** Non-fatal informational issues. */
  warnings: string[];
  /** Fatal constraint violations (used in strict mode). */
  errors: string[];
  /** Capabilities required by the plugin but missing from this host. */
  missingCapabilities: string[];
  /** Present when the engines.kai semver constraint fails. */
  versionMismatch?: {
    required: string;   // e.g. "^2.0.0"
    actual: string;     // e.g. "1.0.0"
  };
};

/**
 * Check whether a plugin's declared constraints are satisfied by this host.
 *
 * Plugins that omit both `engines` and `capabilities` are always considered
 * compatible (backward compatible with existing plugins).
 */
export function checkPluginCompatibility(manifest: PluginManifest): CompatCheckResult {
  const result: CompatCheckResult = {
    compatible: true,
    warnings: [],
    errors: [],
    missingCapabilities: [],
  };

  // 1. Check engines.kai semver constraint
  const requiredRange = manifest.engines?.kai;
  if (requiredRange) {
    try {
      if (!satisfies(HOST_PLUGIN_API_VERSION, requiredRange)) {
        result.compatible = false;
        result.versionMismatch = { required: requiredRange, actual: HOST_PLUGIN_API_VERSION };
        result.errors.push(
          `Requires Kai plugin API ${requiredRange}, host provides ${HOST_PLUGIN_API_VERSION}`,
        );
      }
    } catch {
      // Invalid semver range in the manifest — treat as a warning, not a hard fail
      result.warnings.push(
        `Invalid engines.kai semver range "${requiredRange}" — skipping version check`,
      );
    }
  }

  // 2. Check required capabilities
  const requiredCaps = manifest.capabilities;
  if (requiredCaps && requiredCaps.length > 0) {
    for (const cap of requiredCaps) {
      if (!HOST_CAPABILITIES.has(cap)) {
        result.compatible = false;
        result.missingCapabilities.push(cap);
      }
    }
    if (result.missingCapabilities.length > 0) {
      result.errors.push(
        `Missing host capabilities: ${result.missingCapabilities.join(', ')}`,
      );
    }
  }

  return result;
}

/**
 * Returns the host's plugin API version (for runtime introspection by plugins).
 */
export function getHostPluginApiVersion(): string {
  return HOST_PLUGIN_API_VERSION;
}

/**
 * Returns the full list of capabilities this host exposes.
 */
export function getHostCapabilities(): string[] {
  return [...HOST_CAPABILITIES];
}
