import { Notification, BrowserWindow } from 'electron';
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync, mkdirSync, unlinkSync } from 'fs';
import { join, resolve, sep } from 'path';
import { pathToFileURL } from 'url';
import type {
  PluginManifest,
  PluginInstance,
  PluginModule,
  PluginUIState,
  PluginRendererScript,
  PluginRendererStyle,
  PluginBannerDescriptor,
  PluginModalDescriptor,
  PluginSettingsSectionDescriptor,
  PluginPanelDescriptor,
  PluginNavigationItemDescriptor,
  PluginCommandDescriptor,
  PluginConversationDecorationDescriptor,
  PluginThreadDecorationDescriptor,
  PluginNotificationDescriptor,
  PluginActionPayload,
  PluginNavigationTarget,
  PreSendHookArgs,
  PreSendHookResult,
  PostReceiveHookArgs,
  PostReceiveHookResult,
  PreUpdateHookArgs,
  PreUpdateHookResult,
  PostUpdateHookArgs,
  PluginAPI,
  PluginPermission,
  PluginConsentRequest,
  PluginInferenceProvider,
  PluginCliToolContribution,
} from './types.js';
import { createPluginAPI, cleanupPluginAPI } from './plugin-api.js';
import type { AppConfig } from '../config/schema.js';
import { toPluginSafeConfig, resolvePluginConfigView, type PluginSafeConfig } from './safe-config.js';
import type { ToolDefinition } from '../tools/types.js';
import { broadcastToAllWindows } from '../utils/window-send.js';
import { convertJsonSchemaToZod } from '../tools/skill-loader.js';
import { readConversationStore, writeConversationStore, broadcastConversationChange } from '../ipc/conversations.js';
import { buildPluginRendererBundle } from './renderer-build.js';
import { MarketplaceService, UnverifiedPluginError } from './marketplace-service.js';
import type { MarketplaceCatalogEntry, InstallResult } from './marketplace-service.js';
import { getBundledPluginIntegrity } from './plugin-bootstrap.js';
import { arePermissionSetsEqual, hashPluginDirectory, readPluginManifest } from './plugin-integrity.js';
import { checkPluginCompatibility } from './plugin-compat.js';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function setNestedValue(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.').filter(Boolean);
  if (keys.some((k) => DANGEROUS_KEYS.has(k))) return;
  if (keys.length === 0) return;

  let current = target;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index];
    if (!current[key] || typeof current[key] !== 'object' || Array.isArray(current[key])) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

function normalizePluginObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

type PluginListEntry = {
  name: string;
  displayName: string;
  version: string;
  description: string;
  state: string;
  brandRequired: boolean;
  icon?: { lucide: string } | { svg: string };
  error?: string;
};

/** Compare two semver strings — returns true if catalogVersion is newer than installedVersion. */
function isNewerVersion(catalogVersion: string, installedVersion: string): boolean {
  const toNum = (v: string) => v.split('.').map(Number);
  const [cMajor = 0, cMinor = 0, cPatch = 0] = toNum(catalogVersion);
  const [iMajor = 0, iMinor = 0, iPatch = 0] = toNum(installedVersion);
  if (cMajor !== iMajor) return cMajor > iMajor;
  if (cMinor !== iMinor) return cMinor > iMinor;
  return cPatch > iPatch;
}

export class PluginManager {
  private plugins: Map<string, PluginInstance> = new Map();
  private pluginAPIs: Map<string, PluginAPI> = new Map();
  private toolChangeCallback: ((tools: ToolDefinition[]) => void) | null = null;
  private cliToolChangeCallback: (() => void) | null = null;
  private actionHandlers: Map<string, Map<string, (action: string, data?: unknown) => void | Promise<void>>> =
    new Map();
  private notificationTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private nativeNotifications: Map<string, Notification> = new Map();
  private marketplaceService: MarketplaceService | null = null;
  private catalogRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastUpdateCount = 0;
  private pendingRestart: Set<string> = new Set();
  private rendererLoadedThisSession: Set<string> = new Set();
  private failedUpdates: Map<string, { attemptedVersion: string; runningVersion: string; error: string }> = new Map();
  private installLocks: Map<string, Promise<unknown>> = new Map();
  /** Plugins disabled for the current session only (not persisted to config). */
  private sessionDisabled: Set<string> = new Set();

  private brandRequiredPluginNamesSet: Set<string>;

  constructor(
    private pluginsDir: string,
    private appHome: string,
    private getConfig: () => AppConfig,
    private setConfig: (path: string, value: unknown) => void,
    private brandRequiredPluginNames: string[] = [],
  ) {
    this.brandRequiredPluginNamesSet = new Set(brandRequiredPluginNames);
  }

  /* ── Discovery ── */

  private discoverPlugins(): Array<{ manifest: PluginManifest; dir: string }> {
    if (!existsSync(this.pluginsDir)) return [];

    const results: Array<{ manifest: PluginManifest; dir: string }> = [];
    let entries: string[];

    try {
      entries = readdirSync(this.pluginsDir);
    } catch {
      return [];
    }

    for (const entry of entries) {
      if (entry.startsWith('.') || entry.endsWith('.prev')) continue;
      const pluginDir = join(this.pluginsDir, entry);
      try {
        if (!statSync(pluginDir).isDirectory()) continue;
      } catch {
        continue;
      }

      const manifestPath = join(pluginDir, 'plugin.json');
      if (!existsSync(manifestPath)) continue;

      try {
        const manifest = readPluginManifest(pluginDir, entry);
        results.push({ manifest, dir: pluginDir });
      } catch (err) {
        console.warn(`[PluginManager] Failed to read plugin manifest at ${manifestPath}:`, err);
      }
    }

    // Sort: requiredPlugins first (in their configured order), then the rest alphabetically
    results.sort((a, b) => {
      const aIdx = this.brandRequiredPluginNames.indexOf(a.manifest.name);
      const bIdx = this.brandRequiredPluginNames.indexOf(b.manifest.name);
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      if (aIdx !== -1) return -1;
      if (bIdx !== -1) return 1;
      return a.manifest.name.localeCompare(b.manifest.name);
    });
    return results;
  }

  /* ── Loading ── */

  private getPluginApprovals(): AppConfig['pluginApprovals'] {
    return this.getConfig().pluginApprovals ?? {};
  }

  private isPluginApproved(pluginName: string, fileHash: string, permissions: readonly string[]): boolean {
    const approval = this.getPluginApprovals()[pluginName];
    if (!approval || approval.hash !== fileHash) return false;
    return !approval.permissions || arePermissionSetsEqual(approval.permissions, permissions);
  }

  private persistPluginApproval(pluginName: string, fileHash: string, permissions: readonly string[]): void {
    this.setConfig('pluginApprovals', {
      ...this.getPluginApprovals(),
      [pluginName]: {
        hash: fileHash,
        permissions: [...permissions],
        approvedAt: new Date().toISOString(),
      },
    });
  }

  /** Permissions that require explicit user consent via modal. */
  private static readonly DANGEROUS_PERMISSIONS: Set<PluginPermission> = new Set([
    'exec:whitelisted',
    // Grants the plugin direct access to provider API keys, AWS secrets,
    // MCP env vars, web server password, TLS private key paths, and Azure
    // subscription keys via api.config.get() / onConfigChanged. Without
    // this permission, only the redacted PluginSafeConfig is returned.
    'config:read-secrets',
  ]);

  /** Plugins waiting for user consent. Maps pluginName → pending load info. */
  private pendingConsent: Map<string, { manifest: PluginManifest; fileHash: string }> = new Map();
  private pendingConsentRollback: Map<
    string,
    { attemptedVersion: string } & Pick<InstallResult, 'backupDir' | 'priorInstalledRecord' | 'priorApproval'>
  > = new Map();

  private hasDangerousPermissions(manifest: PluginManifest): boolean {
    return manifest.permissions.some((p) => PluginManager.DANGEROUS_PERMISSIONS.has(p));
  }

  private buildConsentRequest(manifest: PluginManifest, fileHash: string): PluginConsentRequest {
    const permissions = manifest.permissions ?? [];
    return {
      pluginName: manifest.name,
      displayName: manifest.displayName ?? manifest.name,
      permissions,
      dangerousPermissions: permissions.filter((p) => PluginManager.DANGEROUS_PERMISSIONS.has(p)),
      execScope: manifest.execScope,
      fileHash,
    };
  }

  private ensurePluginApproved(manifest: PluginManifest, fileHash: string): boolean {
    if (this.brandRequiredPluginNamesSet.has(manifest.name)) {
      if (!this.isRequiredPluginIntegrityTrusted(manifest, fileHash)) {
        console.error(`[PluginManager] Required plugin "${manifest.name}" failed integrity verification`);
        return false;
      }
      if (!this.isPluginApproved(manifest.name, fileHash, manifest.permissions)) {
        this.persistPluginApproval(manifest.name, fileHash, manifest.permissions);
      }
      return true;
    }

    // All non-brand-required plugins require explicit user consent
    if (!this.isPluginApproved(manifest.name, fileHash, manifest.permissions)) {
      // Store pending consent and notify renderer
      this.pendingConsent.set(manifest.name, { manifest, fileHash });
      broadcastToAllWindows('plugin:consent-required', this.buildConsentRequest(manifest, fileHash));
      console.info(
        `[PluginManager] Plugin "${manifest.name}" requires user consent for: ${manifest.permissions.join(', ')}`,
      );
      return false; // Block loading until user consents
    }
    return true;
  }

  /** Called by IPC when user approves a dangerous plugin. */
  async approveAndReload(pluginName: string): Promise<boolean> {
    const pending = this.pendingConsent.get(pluginName);
    if (!pending) return false;

    // Serialize with disable/enable and marketplace ops for the same plugin so an
    // in-flight disable can't interleave with this approval reload and leave the
    // plugin active after the user disabled it.
    return this.withInstallLock(pluginName, async () => {
      // Re-check: a concurrent disable/deny may have cleared the pending consent
      // while we waited for the lock.
      const stillPending = this.pendingConsent.get(pluginName);
      if (!stillPending) return false;

      this.persistPluginApproval(pluginName, stillPending.fileHash, stillPending.manifest.permissions);
      this.pendingConsent.delete(pluginName);

      // Re-discover the plugin directory
      const discovered = this.discoverPlugins();
      const pluginInfo = discovered.find((p) => p.manifest.name === pluginName);
      if (!pluginInfo) {
        void this.resolvePendingConsentRollback(pluginName, false, 'Plugin not found after approval');
        return false;
      }

      // Load the plugin now that it's approved (loadPlugin honors the disabled
      // guard, so a plugin disabled meanwhile stays a disabled stub).
      await this.loadPlugin(pluginInfo.manifest, pluginInfo.dir);
      const instance = this.plugins.get(pluginName);
      await this.resolvePendingConsentRollback(pluginName, instance?.state === 'active', instance?.error);
      return true;
    });
  }

  /** Called by IPC when user denies a dangerous plugin. */
  denyPlugin(pluginName: string): void {
    this.pendingConsent.delete(pluginName);
    if (this.pendingConsentRollback.has(pluginName)) {
      void this.resolvePendingConsentRollback(pluginName, false, 'Permission denied by user');
      return;
    }
    const instance = this.plugins.get(pluginName);
    if (instance) {
      instance.state = 'error';
      instance.error = 'Permission denied by user';
      this.broadcastUIState();
    }
  }

  private async resolvePendingConsentRollback(pluginName: string, activated: boolean, error?: string): Promise<void> {
    const stash = this.pendingConsentRollback.get(pluginName);
    if (!stash) return;
    this.pendingConsentRollback.delete(pluginName);

    if (activated || !stash.backupDir) {
      if (stash.backupDir) this.marketplaceService?.discardBackup(stash.backupDir);
      this.setFailedUpdate(pluginName, null);
      return;
    }

    await this.unloadPlugin(pluginName);
    this.marketplaceService?.rollbackInstall(pluginName, stash.backupDir, stash);
    const restored = this.discoverPlugins().find((d) => d.manifest.name === pluginName);
    if (restored) await this.loadPlugin(restored.manifest, restored.dir);

    const runningVersion =
      this.plugins.get(pluginName)?.manifest.version ?? stash.priorInstalledRecord?.version ?? 'unknown';
    this.setFailedUpdate(pluginName, {
      attemptedVersion: stash.attemptedVersion,
      runningVersion,
      error: error ?? 'Update was not approved',
    });
    if (this.rendererLoadedThisSession.has(pluginName)) {
      this.markPendingRestart(pluginName);
    }
    this.broadcastUpdateCount();
  }

  /** Get list of plugins pending consent. */
  getPendingConsent(): PluginConsentRequest[] {
    return Array.from(this.pendingConsent.values()).map((info) =>
      this.buildConsentRequest(info.manifest, info.fileHash),
    );
  }

  private isRequiredPluginIntegrityTrusted(manifest: PluginManifest, fileHash: string): boolean {
    if (this.marketplaceService) {
      const installedInfo = this.getConfig().marketplace?.installedPlugins?.[manifest.name];
      if (!installedInfo?.fileHash || installedInfo.fileHash !== fileHash) return false;
      if (installedInfo.version !== manifest.version) return false;
      if (!installedInfo.permissions || !arePermissionSetsEqual(installedInfo.permissions, manifest.permissions))
        return false;

      const entry = this.marketplaceService.getCachedCatalog()?.find((plugin) => plugin.name === manifest.name);
      if (entry && entry.version !== manifest.version) return false;
      const expectedFileHash = entry ? this.getMarketplaceExpectedFileHash(entry) : undefined;
      if (expectedFileHash && expectedFileHash !== fileHash) return false;

      return true;
    }

    const bundledIntegrity = getBundledPluginIntegrity(manifest.name);
    return (
      bundledIntegrity?.fileHash === fileHash &&
      bundledIntegrity.version === manifest.version &&
      arePermissionSetsEqual(bundledIntegrity.permissions, manifest.permissions)
    );
  }

  private getMarketplaceExpectedFileHash(entry: MarketplaceCatalogEntry): string | undefined {
    return entry.fileHash ?? entry.hash;
  }

  private validatePluginConfig(manifest: PluginManifest, input: unknown): Record<string, unknown> {
    const normalized = normalizePluginObject(input);
    if (!manifest.configSchema) {
      return normalized;
    }

    try {
      const validator = convertJsonSchemaToZod(manifest.configSchema);
      const parsed = validator.safeParse(normalized);
      if (parsed.success) {
        return normalizePluginObject(parsed.data);
      }

      const defaults = validator.safeParse({});
      if (defaults.success) {
        console.warn(`[PluginManager] Resetting invalid config for plugin "${manifest.name}" to schema defaults`);
        return normalizePluginObject(defaults.data);
      }

      console.warn(`[PluginManager] Plugin "${manifest.name}" config schema validation failed; preserving raw config`);
      return normalized;
    } catch (err) {
      console.warn(`[PluginManager] Failed to validate config for plugin "${manifest.name}":`, err);
      return normalized;
    }
  }

  private ensurePluginConfigNormalized(pluginName: string): Record<string, unknown> {
    const instance = this.plugins.get(pluginName);
    if (!instance) return {};

    const config = this.getConfig();
    const plugins = (config as Record<string, unknown>).plugins as Record<string, unknown> | undefined;
    const raw = plugins?.[pluginName];
    const validated = this.validatePluginConfig(instance.manifest, raw);
    const current = normalizePluginObject(raw);
    if (JSON.stringify(current) !== JSON.stringify(validated)) {
      this.setConfig(`plugins.${pluginName}`, validated);
    }
    return validated;
  }

  async loadAll(): Promise<void> {
    const discovered = this.discoverPlugins();
    console.info(`[PluginManager] Discovered ${discovered.length} plugins`);

    // loadPlugin() itself skips persistently-disabled plugins (registering a
    // 'disabled' stub), so this loop stays simple and that guard is the single
    // source of truth across all load paths.
    for (const { manifest, dir } of discovered) {
      if (this.plugins.has(manifest.name)) continue;
      await this.loadPlugin(manifest, dir);
    }

    this.broadcastUIState();
  }

  private createPluginInstance(manifest: PluginManifest, dir: string, state: PluginInstance['state']): PluginInstance {
    return {
      manifest,
      dir,
      fileHash: '',
      state,
      module: null,
      registeredTools: [],
      preSendHooks: [],
      postReceiveHooks: [],
      preUpdateHooks: [],
      postUpdateHooks: [],
      uiBanners: [],
      uiModals: [],
      uiSettingsSections: [],
      uiPanels: [],
      uiNavigationItems: [],
      uiCommands: [],
      conversationDecorations: [],
      threadDecorations: [],
      publishedState: {},
      notifications: [],
      configChangeListeners: [],
      rendererBuild: null,
      inferenceProvider: null,
      contributedCliTools: [],
    };
  }

  /** Names of plugins the user has persistently disabled (config-backed). */
  private getPersistentlyDisabled(): Set<string> {
    return new Set(this.getConfig().pluginSystem?.disabledPlugins ?? []);
  }

  /** True while a plugin is loading or active — i.e. its API may legitimately fire. */
  private isPluginLive(pluginName: string): boolean {
    const state = this.plugins.get(pluginName)?.state;
    return state === 'active' || state === 'loading';
  }

  /**
   * True only when `instance` is still the current activation generation for its
   * plugin AND that generation is live. A stale callback captured by a previous
   * activation (before a disable/enable cycle replaced the instance) fails this
   * check even if a fresh instance is now live under the same name.
   */
  private isCurrentInstance(instance: PluginInstance): boolean {
    const current = this.plugins.get(instance.manifest.name);
    if (current !== instance) return false;
    // 'loading'/'active' are normal live states. Also allow privileged calls
    // while the instance is running its own teardown (deactivate/cleanup), even
    // if its state is 'error' from a partially-failed activation — otherwise
    // teardown can't release resources like an HTTP server.
    return current.state === 'active' || current.state === 'loading' || current.tearingDown === true;
  }

  /** Clear both persistent and session disabled flags for a plugin. */
  private clearDisabledState(pluginName: string): void {
    this.sessionDisabled.delete(pluginName);
    const persisted = this.getPersistentlyDisabled();
    if (persisted.delete(pluginName)) {
      this.setConfig('pluginSystem.disabledPlugins', [...persisted]);
    }
  }

  private async loadPlugin(manifest: PluginManifest, dir: string): Promise<void> {
    // Honor disabled plugins in every load path (startup, marketplace
    // update/reinstall swaps, etc.) so a disabled plugin can never be silently
    // reactivated. This covers both persistent disables (config-backed) and
    // session-only disables (in-memory). Required plugins ignore disables and
    // always load.
    const isDisabled = this.getPersistentlyDisabled().has(manifest.name) || this.sessionDisabled.has(manifest.name);
    if (isDisabled && !this.brandRequiredPluginNamesSet.has(manifest.name)) {
      this.plugins.set(manifest.name, this.createPluginInstance(manifest, dir, 'disabled'));
      this.broadcastUIState();
      this.notifyToolsChanged();
      console.info(`[PluginManager] Plugin "${manifest.name}" is disabled — skipping load`);
      return;
    }

    const instance: PluginInstance = this.createPluginInstance(manifest, dir, 'loading');

    this.plugins.set(manifest.name, instance);

    try {
      instance.fileHash = hashPluginDirectory(dir);
      if (!this.ensurePluginApproved(manifest, instance.fileHash)) {
        instance.state = 'error';
        instance.error = this.brandRequiredPluginNamesSet.has(manifest.name)
          ? 'Required plugin integrity verification failed. Reinstall or update the plugin from a trusted source.'
          : 'Plugin permission approval is required before it can be loaded.';
        this.broadcastUIState();
        this.notifyToolsChanged();
        return;
      }

      this.ensurePluginConfigNormalized(manifest.name);

      // Check plugin compatibility constraints (engines.kai + capabilities)
      const compat = checkPluginCompatibility(manifest);
      if (!compat.compatible) {
        const mode = this.getConfig().pluginSystem?.compatibilityMode ?? 'warn';
        if (mode === 'strict') {
          instance.state = 'error';
          instance.error = `Incompatible: ${compat.errors.join('; ')}`;
          console.warn(`[PluginManager] Plugin "${manifest.name}" blocked (strict mode): ${compat.errors.join('; ')}`);
          this.broadcastUIState();
          this.notifyToolsChanged();
          return;
        }
        // warn mode: store warning, continue loading
        instance.compatWarning = compat;
        console.warn(`[PluginManager] Plugin "${manifest.name}" compatibility warning: ${compat.errors.join('; ')}`);
      }

      // Load backend entry point from backend.js
      const backendPath = join(dir, 'backend.js');
      if (!existsSync(backendPath)) {
        console.warn(`[PluginManager] Plugin "${manifest.name}" missing backend.js - skipping`);
        instance.state = 'error';
        instance.error = `Plugin backend not found: ${backendPath}`;
        this.broadcastUIState();
        this.notifyToolsChanged();
        return;
      }

      const moduleUrl = `${pathToFileURL(backendPath).href}?v=${instance.fileHash}`;
      const mod = (await import(moduleUrl)) as PluginModule;
      instance.module = mod;

      const api = createPluginAPI(instance, {
        appHome: this.appHome,
        isLive: () => this.isCurrentInstance(instance),
        getConfig: () => this.getConfig(),
        setConfig: (path, value) => {
          // Block persistent config writes from a stale activation generation.
          if (!this.isCurrentInstance(instance)) return;
          this.setConfig(path, value);
        },
        getPluginConfig: () => this.getPluginConfig(manifest.name),
        setPluginConfig: (path, value) => {
          if (!this.isCurrentInstance(instance)) return;
          this.setPluginConfig(manifest.name, path, value);
        },
        getPluginState: () => ({ ...instance.publishedState }),
        replacePluginState: (next) => {
          if (!this.isCurrentInstance(instance)) return;
          instance.publishedState = normalizePluginObject(next);
          this.broadcastUIState();
        },
        setPluginState: (path, value) => {
          if (!this.isCurrentInstance(instance)) return;
          const next = { ...instance.publishedState };
          setNestedValue(next, path, value);
          instance.publishedState = next;
          this.broadcastUIState();
        },
        emitPluginEvent: (eventName, data) => {
          // Drop events from a stale activation generation (e.g. a timer that
          // survived a disable/enable cycle). 'loading' is allowed for
          // activate()-time calls on the current generation.
          if (!this.isCurrentInstance(instance)) return;
          broadcastToAllWindows('plugin:event', { pluginName: manifest.name, eventName, data });
        },
        onUIStateChanged: () => this.broadcastUIState(),
        onToolsChanged: () => this.notifyToolsChanged(),
        onCliToolsChanged: () => this.notifyCliToolsChanged(),
        registerActionHandler: (targetId, handler) => {
          // Ignore registrations from a stale activation generation so old async
          // code can't write into the current generation's action map.
          if (!this.isCurrentInstance(instance)) return;
          this.registerActionHandler(manifest.name, targetId, handler);
        },
        showNotification: (descriptor) => {
          if (!this.isCurrentInstance(instance)) return;
          this.showPluginNotification(manifest.name, descriptor);
        },
        dismissNotification: (id) => {
          if (!this.isCurrentInstance(instance)) return;
          this.dismissPluginNotification(manifest.name, id);
        },
        openNavigationTarget: (target) => {
          if (!this.isCurrentInstance(instance)) return;
          this.broadcastNavigationRequest(manifest.name, target);
        },
      });
      this.pluginAPIs.set(manifest.name, api);

      // Clear hook arrays before activate to prevent duplicates on reload (issue #36)
      instance.preSendHooks = [];
      instance.postReceiveHooks = [];
      instance.preUpdateHooks = [];
      instance.postUpdateHooks = [];
      instance.configChangeListeners = [];

      if (typeof mod.activate === 'function') {
        await mod.activate(api);
      }

      // Check for frontend entry point at frontend.js
      const frontendPath = join(dir, 'frontend.js');
      if (existsSync(frontendPath)) {
        instance.rendererBuild = buildPluginRendererBundle({
          pluginName: manifest.name,
          pluginDir: dir,
          rendererPath: 'frontend.js',
        });
        this.rendererLoadedThisSession.add(manifest.name);
      }

      instance.state = 'active';
      instance.error = undefined;

      // Show compatibility warning banner if loaded in warn mode
      if (instance.compatWarning) {
        instance.uiBanners.push({
          id: `compat-warning-${manifest.name}`,
          pluginName: manifest.name,
          text: `This plugin may be incompatible: ${instance.compatWarning.errors.join('; ')}`,
          variant: 'warning',
          dismissible: true,
          visible: true,
        });
      }

      this.broadcastUIState();
      this.notifyToolsChanged();
      console.info(`[PluginManager] Plugin "${manifest.name}" activated`);
    } catch (err) {
      instance.state = 'error';
      instance.error = err instanceof Error ? err.message : String(err);
      this.broadcastUIState();
      this.notifyToolsChanged();
      console.error(`[PluginManager] Failed to load plugin "${manifest.name}":`, err);
    }
  }

  /* ── Unloading ── */

  async unloadAll(): Promise<void> {
    // Stop periodic catalog refresh
    if (this.catalogRefreshTimer) {
      clearInterval(this.catalogRefreshTimer);
      this.catalogRefreshTimer = null;
    }

    // Unload in reverse of load order: non-required plugins first (reverse alpha), then required plugins in reverse order
    const sorted = [...this.plugins.entries()].sort(([, a], [, b]) => {
      const aIdx = this.brandRequiredPluginNames.indexOf(a.manifest.name);
      const bIdx = this.brandRequiredPluginNames.indexOf(b.manifest.name);
      if (aIdx !== -1 && bIdx !== -1) return bIdx - aIdx;
      if (aIdx !== -1) return 1;
      if (bIdx !== -1) return -1;
      return b.manifest.name.localeCompare(a.manifest.name);
    });

    for (const [name, instance] of sorted) {
      instance.tearingDown = true;
      try {
        if (instance.module?.deactivate) {
          await instance.module.deactivate();
        }
      } catch (err) {
        console.error(`[PluginManager] Error deactivating plugin "${name}":`, err);
      }
      try {
        const api = this.pluginAPIs.get(name);
        if (api) {
          await cleanupPluginAPI(api);
        }
      } catch (err) {
        console.error(`[PluginManager] Error cleaning up plugin API for "${name}":`, err);
      }
      instance.tearingDown = false;
    }

    for (const timer of this.notificationTimers.values()) {
      clearTimeout(timer);
    }

    this.plugins.clear();
    this.pluginAPIs.clear();
    this.actionHandlers.clear();
    this.notificationTimers.clear();
    this.notifyToolsChanged();
  }

  private async unloadPlugin(pluginName: string): Promise<void> {
    const instance = this.plugins.get(pluginName);
    if (!instance) return;

    instance.tearingDown = true;
    try {
      if (instance.module?.deactivate) {
        await instance.module.deactivate();
      }
    } catch (err) {
      console.error(`[PluginManager] Error deactivating plugin "${pluginName}":`, err);
    }
    // Always run API cleanup (e.g. close HTTP servers) even if deactivate() threw,
    // so a partially-activated/errored plugin can't leak resources.
    try {
      const api = this.pluginAPIs.get(pluginName);
      if (api) {
        await cleanupPluginAPI(api);
      }
    } catch (err) {
      console.error(`[PluginManager] Error cleaning up plugin API for "${pluginName}":`, err);
    }
    instance.tearingDown = false;

    // Clear hook arrays to prevent dangling references from firing (issue #36)
    instance.preSendHooks = [];
    instance.postReceiveHooks = [];
    instance.preUpdateHooks = [];
    instance.postUpdateHooks = [];
    instance.configChangeListeners = [];

    this.actionHandlers.delete(pluginName);

    // Clean up inference provider
    if (instance.inferenceProvider) {
      console.info(`[PluginManager] Clearing inference provider from "${pluginName}"`);
      instance.inferenceProvider = null;
    }

    for (const [key, timer] of this.notificationTimers.entries()) {
      if (key.startsWith(`${pluginName}:`)) {
        clearTimeout(timer);
        this.notificationTimers.delete(key);
      }
    }

    // Close and drop any native OS notifications for this plugin. Their click
    // handler sends 'plugin:navigate-direct'; leaving them alive would let a
    // disabled/unloaded plugin still drive navigation from a stale notification.
    for (const [key, notification] of this.nativeNotifications.entries()) {
      if (key.startsWith(`${pluginName}:`)) {
        try {
          notification.close();
        } catch {
          /* best-effort */
        }
        this.nativeNotifications.delete(key);
      }
    }

    this.plugins.delete(pluginName);
    this.pluginAPIs.delete(pluginName);
  }

  /* ── Enable / Disable ── */

  /**
   * Disable a non-required plugin: tear down its backend (tools, hooks, IPC
   * action handlers, timers, inference provider) immediately, then leave a
   * `disabled` stub so it still appears in the UI.
   *
   * `persist: true` records the plugin in `pluginSystem.disabledPlugins` so it
   * stays disabled across restarts. `persist: false` disables it only for the
   * running session — the next app launch re-enables it.
   *
   * The renderer half of a plugin cannot be hot-unloaded (renderer modules are
   * URL-cached), so if a frontend bundle already shipped this session we flag a
   * pending restart to fully clear it.
   */
  async disablePlugin(pluginName: string, opts: { persist: boolean }): Promise<void> {
    if (this.brandRequiredPluginNamesSet.has(pluginName)) {
      throw new Error(`Plugin "${pluginName}" is required and cannot be disabled`);
    }

    // Serialize with marketplace install/update/uninstall for the same plugin so
    // two unload/load sequences can't interleave and leave duplicate side effects
    // or a transiently-missing instance.
    await this.withInstallLock(pluginName, async () => {
      const existing = this.plugins.get(pluginName);
      if (!existing) {
        throw new Error(`Unknown plugin "${pluginName}"`);
      }

      // A plugin in 'loading' state has an in-flight loadPlugin()/activate()
      // promise that unloadPlugin() cannot cancel — tearing it down now would race
      // the activation and could leave handlers/timers registered after the stub
      // is installed. Reject; the caller can retry once it settles.
      if (existing.state === 'loading') {
        throw new Error(`Plugin "${pluginName}" is still loading — try again once it finishes`);
      }

      // A plugin awaiting permission consent is driven by a blocking consent modal
      // (pendingConsent / pendingConsentRollback). Disabling it here would leave
      // that modal stranded and a later approve/deny could reload or roll back a
      // plugin the user disabled. Make the user resolve consent first.
      if (this.pendingConsent.has(pluginName) || this.pendingConsentRollback.has(pluginName)) {
        throw new Error(`Plugin "${pluginName}" is awaiting permission approval — approve or deny it first`);
      }

      const { manifest, dir } = existing;
      const hadRenderer = this.rendererLoadedThisSession.has(pluginName);

      await this.unloadPlugin(pluginName);

      // Keep a stub so the plugin remains visible (and re-enablable) in the UI.
      this.plugins.set(pluginName, this.createPluginInstance(manifest, dir, 'disabled'));

      if (opts.persist) {
        // A persistent disable supersedes any prior session-only disable.
        this.sessionDisabled.delete(pluginName);
        const next = this.getPersistentlyDisabled();
        next.add(pluginName);
        this.setConfig('pluginSystem.disabledPlugins', [...next]);
      } else {
        // Session-only: tracked in memory so mid-session reload paths (marketplace
        // update, consent approval) keep it disabled until the next app launch.
        this.sessionDisabled.add(pluginName);
      }

      if (hadRenderer) {
        this.markPendingRestart(pluginName);
      }

      this.broadcastUIState();
      this.notifyToolsChanged();
      this.notifyCliToolsChanged();
      console.info(`[PluginManager] Plugin "${pluginName}" disabled (persist=${opts.persist})`);
    });
  }

  /** Re-enable a previously disabled plugin and load it now. */
  async enablePlugin(pluginName: string): Promise<void> {
    // Required plugins are never disablable, so there's nothing to enable.
    if (this.brandRequiredPluginNamesSet.has(pluginName)) {
      throw new Error(`Plugin "${pluginName}" is required and is always enabled`);
    }
    // Only act on a plugin that is actually disabled — guard against stray
    // IPC/web-bridge calls for already-active or unknown plugins, which would
    // otherwise trigger an unintended hot-unload/reload.
    const current = this.plugins.get(pluginName);
    const isDisabled =
      current?.state === 'disabled' ||
      this.getPersistentlyDisabled().has(pluginName) ||
      this.sessionDisabled.has(pluginName);
    if (!isDisabled) {
      return;
    }

    // Serialize with marketplace lifecycle ops for the same plugin (see disablePlugin).
    await this.withInstallLock(pluginName, async () => {
      this.clearDisabledState(pluginName);

      // If this plugin's frontend bundle already shipped earlier this session, the
      // renderer has it URL-cached and can't be re-imported without a restart, so
      // the backend can hot-reload now but a restart is still needed for the
      // frontend. Otherwise it's safe to clear the restart flag entirely.
      const rendererStale = this.rendererLoadedThisSession.has(pluginName);
      if (!rendererStale) {
        this.clearPendingRestart(pluginName);
      }

      // Tear down any existing instance through the proper unload path. A disabled
      // stub has no live module/timers so this is a no-op for it, but if enable is
      // somehow called over a live instance (web bridge, duplicate request) this
      // ensures deactivate()/API cleanup run before we reload.
      if (this.plugins.has(pluginName)) {
        await this.unloadPlugin(pluginName);
      }

      const found = this.discoverPlugins().find((d) => d.manifest.name === pluginName);
      if (!found) {
        throw new Error(`Plugin "${pluginName}" not found on disk`);
      }

      await this.loadPlugin(found.manifest, found.dir);

      // If this plugin was updated while disabled, swapToInstalledPlugin deferred
      // the rollback decision to now: validate the freshly-loaded version and roll
      // back to the stashed previous version if it failed consent/activation.
      if (this.pendingConsentRollback.has(pluginName) && !this.pendingConsent.has(pluginName)) {
        const reloaded = this.plugins.get(pluginName);
        await this.resolvePendingConsentRollback(pluginName, reloaded?.state === 'active', reloaded?.error);
      }

      if (rendererStale) {
        this.markPendingRestart(pluginName);
      }

      this.broadcastUIState();
      this.notifyToolsChanged();
      this.notifyCliToolsChanged();
      console.info(`[PluginManager] Plugin "${pluginName}" enabled`);
    });
  }

  /* ── Permissions / Queries ── */

  hasPermission(pluginName: string, permission: PluginPermission): boolean {
    return this.plugins.get(pluginName)?.manifest.permissions.includes(permission) ?? false;
  }

  getPluginCount(): number {
    return this.plugins.size;
  }

  listPlugins(): PluginListEntry[] {
    return [...this.plugins.values()].map((instance) => ({
      name: instance.manifest.name,
      displayName: instance.manifest.displayName,
      version: instance.manifest.version,
      description: instance.manifest.description,
      state: instance.state,
      brandRequired: this.brandRequiredPluginNamesSet.has(instance.manifest.name),
      icon: instance.manifest.icon,
      error: instance.error,
    }));
  }

  getPluginInstance(pluginName: string): PluginInstance | null {
    return this.plugins.get(pluginName) ?? null;
  }

  private pluginSettingsPath(pluginName: string): string {
    return join(this.appHome, 'plugin-settings', pluginName, 'settings.json');
  }

  getPluginConfig(pluginName: string): Record<string, unknown> {
    const instance = this.plugins.get(pluginName);
    if (!instance) return {};
    const settingsPath = this.pluginSettingsPath(pluginName);

    // Migrate from legacy in-plugin-dir settings.json if the new location doesn't exist yet
    if (!existsSync(settingsPath)) {
      const legacyPath = join(instance.dir, 'settings.json');
      if (existsSync(legacyPath)) {
        try {
          const legacyData = readFileSync(legacyPath, 'utf-8');
          const dir = join(this.appHome, 'plugin-settings', pluginName);
          mkdirSync(dir, { recursive: true });
          writeFileSync(settingsPath, legacyData, 'utf-8');
          try {
            unlinkSync(legacyPath);
          } catch {
            /* best-effort cleanup */
          }
          console.info(`[PluginManager] Migrated settings for "${pluginName}" from plugin dir to ${settingsPath}`);
        } catch (err) {
          console.warn(`[PluginManager] Failed to migrate legacy settings for "${pluginName}":`, err);
        }
      }
    }

    try {
      if (existsSync(settingsPath)) {
        const raw = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        return this.validatePluginConfig(instance.manifest, raw);
      }
    } catch {
      // ignore malformed settings
    }
    return this.validatePluginConfig(instance.manifest, {});
  }

  resolveRendererAssetRequest(pluginName: string, assetPath: string): { filePath: string; contentType: string } | null {
    const instance = this.plugins.get(pluginName);
    if (!instance || instance.state !== 'active' || !instance.rendererBuild) return null;

    const filePath = join(instance.dir, assetPath);
    const resolvedPath = resolve(filePath);
    const baseDir = resolve(instance.dir);
    if (resolvedPath !== baseDir && !resolvedPath.startsWith(baseDir + sep)) return null;
    if (!existsSync(resolvedPath)) return null;

    const ext = assetPath.split('.').pop()?.toLowerCase() ?? '';
    const mimeTypes: Record<string, string> = {
      js: 'text/javascript; charset=utf-8',
      css: 'text/css; charset=utf-8',
      json: 'application/json; charset=utf-8',
    };
    return { filePath: resolvedPath, contentType: mimeTypes[ext] ?? 'application/octet-stream' };
  }

  setPluginConfig(pluginName: string, path: string, value: unknown): void {
    const instance = this.plugins.get(pluginName);
    if (!instance) {
      throw new Error(`Unknown plugin "${pluginName}"`);
    }

    const next = this.getPluginConfig(pluginName);
    setNestedValue(next, path, value);
    const validated = this.validatePluginConfig(instance.manifest, next);
    const settingsPath = this.pluginSettingsPath(pluginName);
    const dir = join(this.appHome, 'plugin-settings', pluginName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(validated, null, 2), 'utf-8');
    this.broadcastUIState();

    // Fire the plugin's own config-change listeners so api.config.onChanged
    // callbacks are triggered when plugin settings change (not just app config).
    // Plugins receive the redacted PluginSafeConfig unless they declared
    // 'config:read-secrets'; this mirrors api.config.get()'s behaviour and
    // prevents on-change broadcasts from leaking credentials to plugins that
    // never asked for them.
    const payload = resolvePluginConfigView(this.getConfig(), instance.manifest.permissions);
    for (const listener of instance.configChangeListeners) {
      try {
        listener(payload);
      } catch (err) {
        console.error(`[PluginManager] Error in plugin "${pluginName}" config listener:`, err);
      }
    }
  }

  /* ── Config Change Forwarding ── */

  onConfigChanged(config: AppConfig): void {
    // Compute the redacted view lazily and cache it so we don't run the
    // redactor once per plugin. Plugins that declared 'config:read-secrets'
    // receive the raw AppConfig; everyone else receives the same shared
    // PluginSafeConfig instance. Hook bodies treat the argument as
    // read-only — they cannot mutate the redacted view back into the
    // source because toPluginSafeConfig deep-clones.
    let safeConfig: PluginSafeConfig | null = null;
    const viewFor = (instance: PluginInstance): AppConfig | PluginSafeConfig => {
      if (instance.manifest.permissions.includes('config:read-secrets')) {
        return config;
      }
      if (!safeConfig) safeConfig = toPluginSafeConfig(config);
      return safeConfig;
    };

    for (const [name, instance] of this.plugins) {
      if (instance.state !== 'active') continue;

      const payload = viewFor(instance);

      try {
        instance.module?.onConfigChanged?.(payload);
      } catch (err) {
        console.error(`[PluginManager] Error in plugin "${name}" onConfigChanged:`, err);
      }

      for (const listener of instance.configChangeListeners) {
        try {
          listener(payload);
        } catch (err) {
          console.error(`[PluginManager] Error in plugin "${name}" config listener:`, err);
        }
      }
    }

    this.broadcastUIState();
  }

  /* ── Tool Aggregation ── */

  getAllPluginTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const instance of this.plugins.values()) {
      if (instance.state !== 'active') continue;
      tools.push(...instance.registeredTools);
    }
    return tools;
  }

  onToolsChanged(callback: (tools: ToolDefinition[]) => void): void {
    this.toolChangeCallback = callback;
    callback(this.getAllPluginTools());
  }

  private notifyToolsChanged(): void {
    this.toolChangeCallback?.(this.getAllPluginTools());
  }

  onCliToolsChanged(callback: () => void): void {
    this.cliToolChangeCallback = callback;
  }

  private notifyCliToolsChanged(): void {
    this.cliToolChangeCallback?.();
  }

  /* ── Message Hooks ── */

  /* ── Inference Provider ── */

  /**
   * Get an inference provider, optionally filtered by context.
   *
   * When `context` is provided, only returns a provider from a plugin whose
   * contributed runtimes include the resolved runtimeId, OR whose runtime IDs
   * match the model's provider key prefix. This prevents a plugin inference
   * provider from hijacking requests meant for other configured providers.
   *
   * When `context` is omitted, returns the first available provider (legacy behavior).
   */
  getInferenceProvider(context?: { runtimeId?: string; modelProviderKey?: string }): PluginInferenceProvider | null {
    for (const instance of this.plugins.values()) {
      if (instance.state !== 'active') continue;
      if (!instance.inferenceProvider || !instance.inferenceProvider.isAvailable()) continue;

      // If no context provided, return first available (legacy behavior)
      if (!context) {
        return instance.inferenceProvider;
      }

      // Match by model provider key — the provider key conventionally includes
      // the plugin/provider name, so e.g. "legionio_sonnet" matches an inference
      // provider named "Legion" or "legionio". Only activate when no explicit
      // runtime has been chosen, to respect user overrides.
      const hasExplicitRuntime = context.runtimeId && context.runtimeId !== 'auto';
      if (!hasExplicitRuntime && context.modelProviderKey) {
        const providerName = instance.inferenceProvider.name.toLowerCase().replace(/\s+/g, '');
        if (context.modelProviderKey.startsWith(providerName)) {
          return instance.inferenceProvider;
        }
      }
    }
    return null;
  }

  /* ── Plugin CLI Tool Contributions ── */

  getPluginCliTools(): PluginCliToolContribution[] {
    const result: PluginCliToolContribution[] = [];
    for (const instance of this.plugins.values()) {
      if (instance.state !== 'active') continue;
      result.push(...instance.contributedCliTools);
    }
    return result;
  }

  async runPreSendHooks(args: Omit<PreSendHookArgs, 'config'> & { config: AppConfig }): Promise<PreSendHookResult> {
    let result: PreSendHookResult = {
      messages: args.messages,
      systemPrompt: args.systemPrompt,
    };

    // Build a redacted view of the config so credential-bearing fields
    // (provider API keys, AWS secrets, MCP env, web server password, TLS
    // key path, etc.) never reach plugin hook code. Compute once per call
    // and reuse across all active hooks.
    const safeConfig = toPluginSafeConfig(args.config);

    for (const instance of this.plugins.values()) {
      if (instance.state !== 'active') continue;
      for (const hook of instance.preSendHooks) {
        try {
          const hookResult = await hook({
            messages: result.messages,
            modelKey: args.modelKey,
            config: safeConfig,
            systemPrompt: result.systemPrompt,
          });
          result = {
            messages: hookResult.messages ?? result.messages,
            systemPrompt: hookResult.systemPrompt ?? result.systemPrompt,
            abort: hookResult.abort,
            abortReason: hookResult.abortReason,
          };
          if (result.abort) return result;
        } catch (err) {
          console.error(`[PluginManager] Pre-send hook error in "${instance.manifest.name}":`, err);
        }
      }
    }

    return result;
  }

  async runPostReceiveHooks(
    args: Omit<PostReceiveHookArgs, 'config'> & { config: AppConfig },
  ): Promise<PostReceiveHookResult> {
    let result: PostReceiveHookResult = { response: args.response };

    const safeConfig = toPluginSafeConfig(args.config);

    for (const instance of this.plugins.values()) {
      if (instance.state !== 'active') continue;
      for (const hook of instance.postReceiveHooks) {
        try {
          result = await hook({
            messages: args.messages,
            response: result.response,
            config: safeConfig,
          });
        } catch (err) {
          console.error(`[PluginManager] Post-receive hook error in "${instance.manifest.name}":`, err);
        }
      }
    }

    return result;
  }

  /* ── Lifecycle Hooks ── */

  async runPreUpdateHooks(args: PreUpdateHookArgs): Promise<PreUpdateHookResult> {
    for (const instance of this.plugins.values()) {
      if (instance.state !== 'active') continue;
      for (const hook of instance.preUpdateHooks) {
        try {
          const result = await hook(args);
          if (result?.abort) return result;
        } catch (err) {
          console.error(`[PluginManager] Pre-update hook error in "${instance.manifest.name}":`, err);
          return { abort: true, abortReason: `Hook "${instance.manifest.name}" threw: ${err}` };
        }
      }
    }
    return {};
  }

  async runPostUpdateHooks(args: PostUpdateHookArgs): Promise<void> {
    for (const instance of this.plugins.values()) {
      if (instance.state !== 'active') continue;
      for (const hook of instance.postUpdateHooks) {
        try {
          await hook(args);
        } catch (err) {
          console.error(`[PluginManager] Post-update hook error in "${instance.manifest.name}":`, err);
        }
      }
    }
  }

  /* ── UI State ── */

  getUIState(): PluginUIState {
    const banners: PluginBannerDescriptor[] = [];
    const modals: PluginModalDescriptor[] = [];
    const settingsSections: PluginSettingsSectionDescriptor[] = [];
    const panels: PluginPanelDescriptor[] = [];
    const navigationItems: PluginNavigationItemDescriptor[] = [];
    const commands: PluginCommandDescriptor[] = [];
    const conversationDecorations: PluginConversationDecorationDescriptor[] = [];
    const threadDecorations: PluginThreadDecorationDescriptor[] = [];
    const rendererScripts: PluginRendererScript[] = [];
    const rendererStyles: PluginRendererStyle[] = [];
    const pluginConfigs: Record<string, Record<string, unknown>> = {};
    const pluginStates: Record<string, Record<string, unknown>> = {};
    const pluginStatuses: Record<string, PluginInstance['state']> = {};
    const pluginErrors: Record<string, string | undefined> = {};
    const notifications: PluginNotificationDescriptor[] = [];
    let requiredPluginsReady = true;

    for (const instance of this.plugins.values()) {
      pluginConfigs[instance.manifest.name] = this.getPluginConfig(instance.manifest.name);
      pluginStates[instance.manifest.name] = { ...instance.publishedState };
      pluginStatuses[instance.manifest.name] = instance.state;
      pluginErrors[instance.manifest.name] = instance.error;
      const isActive = instance.state === 'active';
      const shouldExposeUi = instance.state === 'loading' || instance.state === 'active';

      if (!isActive && this.brandRequiredPluginNamesSet.has(instance.manifest.name)) {
        requiredPluginsReady = false;
      }

      if (!shouldExposeUi) {
        continue;
      }

      banners.push(...instance.uiBanners);
      modals.push(...instance.uiModals);
      settingsSections.push(...instance.uiSettingsSections);
      panels.push(...instance.uiPanels);
      navigationItems.push(...instance.uiNavigationItems);
      commands.push(...instance.uiCommands);
      conversationDecorations.push(...instance.conversationDecorations);
      threadDecorations.push(...instance.threadDecorations);
      notifications.push(...instance.notifications.filter((notification) => notification.visible));

      if (instance.rendererBuild) {
        rendererScripts.push(...instance.rendererBuild.scripts);
        rendererStyles.push(...instance.rendererBuild.styles);
      }

      if (this.brandRequiredPluginNamesSet.has(instance.manifest.name)) {
        const hasBlockingModal = instance.uiModals.some((modal) => modal.visible && !modal.closeable);
        if (hasBlockingModal) {
          requiredPluginsReady = false;
        }
      }
    }

    settingsSections.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    panels.sort((a, b) => a.title.localeCompare(b.title));
    navigationItems.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    commands.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

    for (const requiredName of this.brandRequiredPluginNames) {
      if (!this.plugins.has(requiredName)) {
        requiredPluginsReady = false;
        break;
      }
    }

    return {
      banners,
      modals,
      settingsSections,
      panels,
      navigationItems,
      commands,
      conversationDecorations,
      threadDecorations,
      rendererScripts,
      rendererStyles,
      pluginConfigs,
      pluginStates,
      pluginStatuses,
      pluginErrors,
      notifications,
      requiredPluginsReady,
      brandRequiredPluginNames: [...this.brandRequiredPluginNames],
      contributedCliTools: this.getPluginCliTools().map((tool) => {
        // Find which plugin contributed this tool
        for (const instance of this.plugins.values()) {
          if (instance.contributedCliTools.some((t) => t.name === tool.name)) {
            return { ...tool, pluginName: instance.manifest.name };
          }
        }
        return { ...tool, pluginName: 'unknown' };
      }),
    };
  }

  private broadcastUIState(): void {
    broadcastToAllWindows('plugin:ui-state-changed', this.getUIState());
  }

  /* ── Actions (renderer → main) ── */

  registerActionHandler(
    pluginName: string,
    targetId: string,
    handler: (action: string, data?: unknown) => void | Promise<void>,
  ): void {
    // Refuse late registrations from a disabled/unloaded plugin's stale async
    // code — otherwise it could repopulate actionHandlers after unloadPlugin()
    // cleared them and keep executing backend logic via the IPC action endpoints.
    if (!this.isPluginLive(pluginName)) return;
    let pluginHandlers = this.actionHandlers.get(pluginName);
    if (!pluginHandlers) {
      pluginHandlers = new Map();
      this.actionHandlers.set(pluginName, pluginHandlers);
    }
    pluginHandlers.set(targetId, handler);
  }

  async handleAction(payload: PluginActionPayload): Promise<unknown> {
    // Don't dispatch actions to a plugin that isn't live (disabled/unloaded). The
    // renderer can't be hot-unloaded, so its UI may still post actions.
    if (!this.isPluginLive(payload.pluginName)) {
      return { error: 'Plugin is not active' };
    }
    const handler = this.actionHandlers.get(payload.pluginName)?.get(payload.targetId);
    if (!handler) {
      console.warn(`[PluginManager] No action handler for ${payload.pluginName}:${payload.targetId}`);
      return { error: 'No handler registered' };
    }
    return handler(payload.action, payload.data);
  }

  sendModalCallback(pluginName: string, modalId: string, data: unknown): void {
    broadcastToAllWindows('plugin:modal-callback', { pluginName, modalId, data });
  }

  /* ── Notifications / Navigation ── */

  private notificationTimerKey(pluginName: string, id: string): string {
    return `${pluginName}:${id}`;
  }

  private clearNotificationTimer(pluginName: string, id: string): void {
    const key = this.notificationTimerKey(pluginName, id);
    const timer = this.notificationTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.notificationTimers.delete(key);
    }
  }

  private broadcastNavigationRequest(pluginName: string, target: PluginNavigationTarget): void {
    // A timer/promise captured inside the plugin before it was disabled/unloaded
    // could still call api.navigation.open() afterward. Drop it unless the plugin
    // is still live ('active', or 'loading' during activate()).
    if (!this.isPluginLive(pluginName)) return;
    broadcastToAllWindows('plugin:navigation-request', { pluginName, target });
  }

  showPluginNotification(
    pluginName: string,
    descriptor: Omit<PluginNotificationDescriptor, 'pluginName' | 'visible'>,
  ): void {
    const instance = this.plugins.get(pluginName);
    // Ignore late calls from a disabled/unloaded plugin's lingering timers — only
    // a live plugin ('active', or 'loading' during activate()) may raise notifications.
    if (!instance || !this.isPluginLive(pluginName)) return;

    const full: PluginNotificationDescriptor = {
      ...descriptor,
      pluginName,
      visible: true,
    };
    const existingIndex = instance.notifications.findIndex((notification) => notification.id === descriptor.id);
    if (existingIndex >= 0) {
      instance.notifications[existingIndex] = full;
    } else {
      instance.notifications.push(full);
    }

    this.clearNotificationTimer(pluginName, descriptor.id);
    if (typeof descriptor.autoDismissMs === 'number' && descriptor.autoDismissMs > 0) {
      const key = this.notificationTimerKey(pluginName, descriptor.id);
      const timer = setTimeout(() => {
        this.dismissPluginNotification(pluginName, descriptor.id);
      }, descriptor.autoDismissMs);
      this.notificationTimers.set(key, timer);
    }

    if (descriptor.native && Notification.isSupported()) {
      const notifKey = `${pluginName}:${descriptor.id}`;
      const nativeNotification = new Notification({
        title: descriptor.title,
        body: descriptor.body ?? '',
      });

      // Store reference to prevent garbage collection before user clicks
      this.nativeNotifications.set(notifKey, nativeNotification);

      const cleanup = () => {
        this.nativeNotifications.delete(notifKey);
      };

      if (descriptor.target) {
        nativeNotification.on('click', () => {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.show();
              win.focus();
              // Send directly to the renderer to trigger DOM custom event
              win.webContents.send('plugin:navigate-direct', { pluginName, target: descriptor.target });
            }
          }
          cleanup();
        });
      }

      nativeNotification.on('close', cleanup);

      nativeNotification.show();
    }

    this.broadcastUIState();
  }

  dismissPluginNotification(pluginName: string, id: string): void {
    const instance = this.plugins.get(pluginName);
    if (!instance) return;

    const existingIndex = instance.notifications.findIndex((notification) => notification.id === id);
    if (existingIndex < 0) return;

    instance.notifications[existingIndex] = {
      ...instance.notifications[existingIndex],
      visible: false,
    };
    this.clearNotificationTimer(pluginName, id);
    this.broadcastUIState();
  }

  /* ── Marketplace ── */

  async initMarketplace(marketplaceUrls: string[]): Promise<void> {
    if (marketplaceUrls.length === 0) return;

    this.marketplaceService = new MarketplaceService(
      this.pluginsDir,
      this.appHome,
      this.getConfig,
      this.setConfig,
      this.brandRequiredPluginNamesSet,
    );

    let catalog: MarketplaceCatalogEntry[] = [];
    try {
      catalog = await this.marketplaceService.fetchCatalog(marketplaceUrls);
      console.info(`[Marketplace] Fetched ${catalog.length} plugins from ${marketplaceUrls.length} marketplace(s)`);
    } catch (err) {
      console.warn('[Marketplace] Catalog fetch failed, using cache if available:', err);
      catalog = this.marketplaceService.getCachedCatalog() ?? [];
    }

    if (this.brandRequiredPluginNames.length > 0) {
      await this.marketplaceService.autoInstallRequired(this.brandRequiredPluginNamesSet, catalog, {
        serialize: (name, fn) => this.withInstallLock(name, fn),
        afterInstall: async (name, result) => {
          await this.swapToInstalledPlugin(name, result.version, result);
        },
      });
    }
  }

  private async withInstallLock<T>(pluginName: string, fn: () => Promise<T>): Promise<T> {
    while (this.installLocks.has(pluginName)) {
      try {
        await this.installLocks.get(pluginName);
      } catch {
        /* ignore */
      }
    }
    const p = fn();
    this.installLocks.set(pluginName, p);
    try {
      return await p;
    } finally {
      if (this.installLocks.get(pluginName) === p) this.installLocks.delete(pluginName);
    }
  }

  getMarketplaceCatalog(): MarketplaceCatalogEntry[] {
    if (!this.marketplaceService) return [];

    const catalog = this.marketplaceService.getCachedCatalog() ?? [];

    // Annotate with current load status from PluginManager
    return catalog.map((entry) => {
      const installed =
        this.plugins.has(entry.name) || this.marketplaceService!.getInstalledPluginNames().includes(entry.name);

      // installedVersion may be absent when a plugin was installed manually (not via
      // marketplace) or when the cache predates version tracking.  Fall back to the
      // live manifest version so the Updates tab can detect newer catalog versions.
      const installedVersion =
        entry.installedVersion ??
        (installed ? (this.plugins.get(entry.name)?.manifest.version ?? undefined) : undefined);

      return { ...entry, installed, installedVersion };
    });
  }

  /* ── Plugin Update Detection ── */

  /**
   * Count how many installed plugins have a newer version available in the marketplace catalog.
   */
  getAvailableUpdateCount(): number {
    const catalog = this.marketplaceService?.getCachedCatalog() ?? [];
    let count = 0;
    for (const entry of catalog) {
      const instance = this.plugins.get(entry.name);
      if (instance && isNewerVersion(entry.version, instance.manifest.version)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Start periodic catalog refresh (every 4 hours) and broadcast update count.
   * Call after loadAll() and initMarketplace() have completed.
   */
  startCatalogRefresh(): void {
    // Initial broadcast
    this.broadcastUpdateCount();

    // Periodic refresh every 4 hours (same cadence as app auto-updater)
    const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
    this.catalogRefreshTimer = setInterval(() => {
      this.refreshMarketplace()
        .then(() => this.broadcastUpdateCount())
        .catch((err) => {
          console.warn('[PluginManager] Periodic catalog refresh failed:', err);
        });
    }, REFRESH_INTERVAL_MS);
  }

  private broadcastUpdateCount(): void {
    const count = this.getAvailableUpdateCount();
    if (count !== this.lastUpdateCount) {
      this.lastUpdateCount = count;
      broadcastToAllWindows('plugin:updates-available', { count });
    }
  }

  getPendingRestart(): string[] {
    return [...this.pendingRestart];
  }

  private markPendingRestart(pluginName: string): void {
    if (this.pendingRestart.has(pluginName)) return;
    this.pendingRestart.add(pluginName);
    broadcastToAllWindows('plugin:pending-restart-changed', { plugins: this.getPendingRestart() });
  }

  private clearPendingRestart(pluginName: string): void {
    if (!this.pendingRestart.delete(pluginName)) return;
    broadcastToAllWindows('plugin:pending-restart-changed', { plugins: this.getPendingRestart() });
  }

  getFailedUpdates(): Array<{ name: string; attemptedVersion: string; runningVersion: string; error: string }> {
    return [...this.failedUpdates.entries()].map(([name, info]) => ({ name, ...info }));
  }

  private setFailedUpdate(
    pluginName: string,
    info: { attemptedVersion: string; runningVersion: string; error: string } | null,
  ): void {
    if (info) {
      this.failedUpdates.set(pluginName, info);
    } else if (!this.failedUpdates.delete(pluginName)) {
      return;
    }
    broadcastToAllWindows('plugin:failed-updates-changed', { failedUpdates: this.getFailedUpdates() });
  }

  /**
   * Hot-swap a freshly installed plugin into the running set. If the new
   * version fails to reach `active`, restore the on-disk backup and reload the
   * previous version so a broken release never disables a working plugin.
   */
  private async swapToInstalledPlugin(
    pluginName: string,
    attemptedVersion: string,
    install: Pick<InstallResult, 'backupDir' | 'priorInstalledRecord' | 'priorApproval'>,
  ): Promise<{ ok: boolean; error?: string }> {
    // Renderer-side plugin modules are cached by URL in the renderer process and
    // won't re-import after a backend hot-reload, so once a renderer bundle has
    // shipped for this plugin in this session, any subsequent successful swap
    // still needs a full app restart for the frontend to match.
    const hadPriorRenderer = this.rendererLoadedThisSession.has(pluginName);

    await this.unloadPlugin(pluginName);

    const loadFromDisk = async () => {
      const found = this.discoverPlugins().find((d) => d.manifest.name === pluginName);
      if (found) await this.loadPlugin(found.manifest, found.dir);
      return this.plugins.get(pluginName);
    };

    let instance = await loadFromDisk();

    if (instance?.state === 'active') {
      if (install.backupDir) this.marketplaceService?.discardBackup(install.backupDir);
      this.setFailedUpdate(pluginName, null);
      if (hadPriorRenderer) {
        this.markPendingRestart(pluginName);
      } else {
        this.clearPendingRestart(pluginName);
      }
      return { ok: true };
    }

    if (instance?.state === 'disabled') {
      // The plugin is disabled, so loadPlugin left a stub without validating the
      // new version (no consent/activation yet). Defer the success/rollback
      // decision to enablePlugin() by stashing this install's backup: if the new
      // version later fails consent or activation on enable, the previous version
      // is restored; on success the backup is discarded.
      //
      // There is a single on-disk backup slot (<dir>.prev) which each install
      // overwrites, so a fresh update-while-disabled supersedes any prior stash —
      // discard the now-stale backup reference and track the latest one.
      const prior = this.pendingConsentRollback.get(pluginName);
      if (prior?.backupDir && prior.backupDir !== install.backupDir) {
        this.marketplaceService?.discardBackup(prior.backupDir);
      }
      if (install.backupDir) {
        this.pendingConsentRollback.set(pluginName, { ...install, attemptedVersion });
      } else {
        this.pendingConsentRollback.delete(pluginName);
        this.setFailedUpdate(pluginName, null);
      }
      return { ok: true };
    }

    if (this.pendingConsent.has(pluginName)) {
      // Hold the backup until the user approves/denies so we can roll back if
      // the new version is rejected or fails to activate after approval.
      this.pendingConsentRollback.set(pluginName, { ...install, attemptedVersion });
      if (hadPriorRenderer) this.markPendingRestart(pluginName);
      return { ok: true };
    }

    const error = instance?.error ?? 'Plugin failed to activate';

    if (!install.backupDir) {
      // Fresh install (no prior version to fall back to) — leave the error state.
      this.setFailedUpdate(pluginName, null);
      return { ok: false, error };
    }

    console.warn(
      `[PluginManager] "${pluginName}" v${attemptedVersion} failed to activate (${error}); rolling back to previous version`,
    );

    await this.unloadPlugin(pluginName);
    this.marketplaceService?.rollbackInstall(pluginName, install.backupDir, install);
    instance = await loadFromDisk();

    const runningVersion = instance?.manifest.version ?? install.priorInstalledRecord?.version ?? 'unknown';
    this.setFailedUpdate(pluginName, { attemptedVersion, runningVersion, error });

    if (hadPriorRenderer) {
      this.markPendingRestart(pluginName);
    }
    return { ok: false, error };
  }

  async installFromMarketplace(pluginName: string, opts?: { skipHashCheck?: boolean }): Promise<void> {
    if (!this.marketplaceService) {
      throw new Error('Marketplace is not initialized');
    }

    const catalog = this.marketplaceService.getCachedCatalog();
    const entry = catalog?.find((p) => p.name === pluginName);
    if (!entry) {
      throw new Error(`Plugin "${pluginName}" not found in marketplace catalog`);
    }

    // Preflight: if the catalog entry has no integrity hash and the caller
    // has not opted in, throw BEFORE unloading the existing instance so a
    // user who declines the confirmation keeps their currently-loaded plugin.
    if (!opts?.skipHashCheck && !entry.archiveHash && !entry.fileHash && !entry.hash) {
      throw new UnverifiedPluginError(pluginName);
    }

    await this.withInstallLock(pluginName, async () => {
      const result = await this.marketplaceService!.installPlugin(entry, opts);
      await this.swapToInstalledPlugin(pluginName, entry.version, result);
    });

    // Update count changed since we just installed/updated a plugin
    this.broadcastUpdateCount();
  }

  async uninstallFromMarketplace(pluginName: string): Promise<void> {
    if (!this.marketplaceService) {
      throw new Error('Marketplace is not initialized');
    }

    if (
      !pluginName ||
      pluginName.includes('/') ||
      pluginName.includes('\\') ||
      pluginName === '.' ||
      pluginName === '..'
    ) {
      throw new Error('Invalid plugin name');
    }

    if (this.brandRequiredPluginNamesSet.has(pluginName)) {
      throw new Error(`Plugin "${pluginName}" is required and cannot be uninstalled`);
    }

    await this.withInstallLock(pluginName, async () => {
      await this.unloadPlugin(pluginName);
      this.marketplaceService!.uninstallPlugin(pluginName);
    });

    // Clear any disable flag so a future reinstall of the same plugin loads
    // active rather than inheriting a stale disabled state.
    this.clearDisabledState(pluginName);
    this.clearPendingRestart(pluginName);
    this.setFailedUpdate(pluginName, null);
    this.broadcastUIState();
    this.notifyToolsChanged();
  }

  async refreshMarketplace(marketplaceUrls?: string[]): Promise<MarketplaceCatalogEntry[]> {
    if (!this.marketplaceService) return [];

    const urls = marketplaceUrls ?? this.getMarketplaceUrls();
    if (urls.length === 0) return [];

    const catalog = await this.marketplaceService.fetchCatalog(urls);
    if (this.brandRequiredPluginNames.length > 0) {
      // Swap after install (not before) so a failed background download leaves the
      // currently-running required plugin intact, and a broken release rolls back.
      const updated = await this.marketplaceService.autoInstallRequired(this.brandRequiredPluginNamesSet, catalog, {
        serialize: (name, fn) => this.withInstallLock(name, fn),
        afterInstall: async (name, result) => {
          await this.swapToInstalledPlugin(name, result.version, result);
        },
      });
      if (updated.length > 0) {
        this.broadcastUpdateCount();
      }
    }
    return this.getMarketplaceCatalog();
  }

  private getMarketplaceUrls(): string[] {
    try {
      return [...__BRAND_MARKETPLACE_URLS];
    } catch {
      return [];
    }
  }

  /* ── Conversation Helpers ── */

  listConversations(): Array<Record<string, unknown>> {
    const store = readConversationStore(this.appHome);
    return Object.values(store.conversations);
  }

  getConversation(conversationId: string): Record<string, unknown> | null {
    return readConversationStore(this.appHome).conversations[conversationId] ?? null;
  }

  upsertConversation(conversation: Record<string, unknown>): void {
    const store = readConversationStore(this.appHome);
    const conversationId = typeof conversation.id === 'string' ? conversation.id : '';
    if (!conversationId) {
      throw new Error('Conversation id is required');
    }

    store.conversations[conversationId] = conversation as (typeof store.conversations)[string];
    writeConversationStore(this.appHome, store);
    broadcastConversationChange(store);
  }

  setActiveConversation(conversationId: string): void {
    const store = readConversationStore(this.appHome);
    store.activeConversationId = conversationId;
    writeConversationStore(this.appHome, store);
    broadcastConversationChange(store);
  }

  appendConversationMessage(
    conversationId: string,
    message: {
      role: string;
      content: unknown;
      metadata?: Record<string, unknown>;
      parentId?: string | null;
      createdAt?: string;
    },
  ): Record<string, unknown> | null {
    const store = readConversationStore(this.appHome);
    const conversation = store.conversations[conversationId];
    if (!conversation) return null;

    const messageId = `plugin-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = message.createdAt ?? new Date().toISOString();
    const normalizedRole = message.role === 'user' ? 'user' : 'assistant';
    const normalizedContent =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : Array.isArray(message.content)
          ? message.content
          : [];
    const parentId =
      message.parentId ??
      (Array.isArray(conversation.messages) && conversation.messages.length > 0
        ? ((conversation.messages[conversation.messages.length - 1] as { id?: string }).id ?? null)
        : null);

    const nextMessage: Record<string, unknown> = {
      id: messageId,
      role: normalizedRole,
      content: normalizedContent,
      parentId,
      createdAt,
      metadata: {
        ...(message.metadata ?? {}),
        originalRole: message.role,
      },
    };

    const nextMessages = Array.isArray(conversation.messages) ? [...conversation.messages, nextMessage] : [nextMessage];
    const nextConversation = {
      ...conversation,
      messages: nextMessages,
      updatedAt: createdAt,
      lastMessageAt: createdAt,
      lastAssistantUpdateAt: normalizedRole === 'assistant' ? createdAt : conversation.lastAssistantUpdateAt,
      messageCount: nextMessages.length,
      userMessageCount:
        normalizedRole === 'user' ? (conversation.userMessageCount ?? 0) + 1 : (conversation.userMessageCount ?? 0),
      hasUnread: normalizedRole === 'assistant' ? true : conversation.hasUnread,
    };

    store.conversations[conversationId] = nextConversation;
    writeConversationStore(this.appHome, store);
    broadcastConversationChange(store);
    return nextConversation;
  }

  markConversationUnread(conversationId: string, unread: boolean): void {
    const store = readConversationStore(this.appHome);
    const conversation = store.conversations[conversationId];
    if (!conversation) return;
    store.conversations[conversationId] = {
      ...conversation,
      hasUnread: unread,
      updatedAt: new Date().toISOString(),
    };
    writeConversationStore(this.appHome, store);
    broadcastConversationChange(store);
  }
}
