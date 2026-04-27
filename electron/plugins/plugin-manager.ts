import { Notification, BrowserWindow } from 'electron';
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
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
  PluginAPI,
  PluginPermission,
  PluginInferenceProvider,
} from './types.js';
import { createPluginAPI, cleanupPluginAPI } from './plugin-api.js';
import type { AppConfig } from '../config/schema.js';
import type { ToolDefinition } from '../tools/types.js';
import { broadcastToAllWindows } from '../utils/window-send.js';
import { convertJsonSchemaToZod } from '../tools/skill-loader.js';
import { readConversationStore, writeConversationStore, broadcastConversationChange } from '../ipc/conversations.js';
import { buildPluginRendererBundle } from './renderer-build.js';
import { MarketplaceService } from './marketplace-service.js';
import type { MarketplaceCatalogEntry } from './marketplace-service.js';
import { getBundledPluginIntegrity } from './plugin-bootstrap.js';
import { arePermissionSetsEqual, hashPluginDirectory, readPluginManifest } from './plugin-integrity.js';

function setNestedValue(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.').filter(Boolean);
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
  error?: string;
};

export class PluginManager {
  private plugins: Map<string, PluginInstance> = new Map();
  private pluginAPIs: Map<string, PluginAPI> = new Map();
  private toolChangeCallback: ((tools: ToolDefinition[]) => void) | null = null;
  private actionHandlers: Map<string, Map<string, (action: string, data?: unknown) => void | Promise<void>>> = new Map();
  private notificationTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private nativeNotifications: Map<string, Notification> = new Map();
  private marketplaceService: MarketplaceService | null = null;

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

    if (!this.isPluginApproved(manifest.name, fileHash, manifest.permissions)) {
      this.persistPluginApproval(manifest.name, fileHash, manifest.permissions);
    }
    return true;
  }

  private isRequiredPluginIntegrityTrusted(manifest: PluginManifest, fileHash: string): boolean {
    if (this.marketplaceService) {
      const installedInfo = this.getConfig().marketplace?.installedPlugins?.[manifest.name];
      if (!installedInfo?.fileHash || installedInfo.fileHash !== fileHash) return false;
      if (installedInfo.version !== manifest.version) return false;
      if (!installedInfo.permissions || !arePermissionSetsEqual(installedInfo.permissions, manifest.permissions)) return false;

      const entry = this.marketplaceService.getCachedCatalog()?.find((plugin) => plugin.name === manifest.name);
      if (entry && entry.version !== manifest.version) return false;
      const expectedFileHash = entry ? this.getMarketplaceExpectedFileHash(entry) : undefined;
      if (expectedFileHash && expectedFileHash !== fileHash) return false;

      return true;
    }

    const bundledIntegrity = getBundledPluginIntegrity(manifest.name);
    return bundledIntegrity?.fileHash === fileHash
      && bundledIntegrity.version === manifest.version
      && arePermissionSetsEqual(bundledIntegrity.permissions, manifest.permissions);
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

    for (const { manifest, dir } of discovered) {
      await this.loadPlugin(manifest, dir);
    }
  }

  private async loadPlugin(manifest: PluginManifest, dir: string): Promise<void> {
    const instance: PluginInstance = {
      manifest,
      dir,
      fileHash: '',
      state: 'loading',
      module: null,
      registeredTools: [],
      preSendHooks: [],
      postReceiveHooks: [],
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
    };

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
      const mod = await import(moduleUrl) as PluginModule;
      instance.module = mod;

      const api = createPluginAPI(instance, {
        appHome: this.appHome,
        getConfig: () => this.getConfig(),
        setConfig: (path, value) => this.setConfig(path, value),
        getPluginConfig: () => this.getPluginConfig(manifest.name),
        setPluginConfig: (path, value) => this.setPluginConfig(manifest.name, path, value),
        getPluginState: () => ({ ...instance.publishedState }),
        replacePluginState: (next) => {
          instance.publishedState = normalizePluginObject(next);
          this.broadcastUIState();
        },
        setPluginState: (path, value) => {
          const next = { ...instance.publishedState };
          setNestedValue(next, path, value);
          instance.publishedState = next;
          this.broadcastUIState();
        },
        emitPluginEvent: (eventName, data) => {
          broadcastToAllWindows('plugin:event', { pluginName: manifest.name, eventName, data });
        },
        onUIStateChanged: () => this.broadcastUIState(),
        onToolsChanged: () => this.notifyToolsChanged(),
        registerActionHandler: (targetId, handler) => {
          this.registerActionHandler(manifest.name, targetId, handler);
        },
        showNotification: (descriptor) => this.showPluginNotification(manifest.name, descriptor),
        dismissNotification: (id) => this.dismissPluginNotification(manifest.name, id),
        openNavigationTarget: (target) => this.broadcastNavigationRequest(manifest.name, target),
      });
      this.pluginAPIs.set(manifest.name, api);

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
      }

      instance.state = 'active';
      instance.error = undefined;
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
      try {
        if (instance.module?.deactivate) {
          await instance.module.deactivate();
        }
        const api = this.pluginAPIs.get(name);
        if (api) {
          await cleanupPluginAPI(api);
        }
      } catch (err) {
        console.error(`[PluginManager] Error deactivating plugin "${name}":`, err);
      }
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

    try {
      if (instance.module?.deactivate) {
        await instance.module.deactivate();
      }
      const api = this.pluginAPIs.get(pluginName);
      if (api) {
        await cleanupPluginAPI(api);
      }
    } catch (err) {
      console.error(`[PluginManager] Error deactivating plugin "${pluginName}":`, err);
    }

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

    this.plugins.delete(pluginName);
    this.pluginAPIs.delete(pluginName);
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
      error: instance.error,
    }));
  }

  getPluginInstance(pluginName: string): PluginInstance | null {
    return this.plugins.get(pluginName) ?? null;
  }

  getPluginConfig(pluginName: string): Record<string, unknown> {
    const instance = this.plugins.get(pluginName);
    if (!instance) return {};
    const settingsPath = join(instance.dir, 'settings.json');
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
    if (!existsSync(filePath)) return null;

    const ext = assetPath.split('.').pop()?.toLowerCase() ?? '';
    const mimeTypes: Record<string, string> = {
      js: 'text/javascript; charset=utf-8',
      css: 'text/css; charset=utf-8',
      json: 'application/json; charset=utf-8',
    };
    return { filePath, contentType: mimeTypes[ext] ?? 'application/octet-stream' };
  }

  setPluginConfig(pluginName: string, path: string, value: unknown): void {
    const instance = this.plugins.get(pluginName);
    if (!instance) {
      throw new Error(`Unknown plugin "${pluginName}"`);
    }

    const next = this.getPluginConfig(pluginName);
    setNestedValue(next, path, value);
    const validated = this.validatePluginConfig(instance.manifest, next);
    const settingsPath = join(instance.dir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify(validated, null, 2), 'utf-8');
    this.broadcastUIState();
  }

  /* ── Config Change Forwarding ── */

  onConfigChanged(config: AppConfig): void {
    for (const [name, instance] of this.plugins) {
      if (instance.state !== 'active') continue;

      try {
        instance.module?.onConfigChanged?.(config);
      } catch (err) {
        console.error(`[PluginManager] Error in plugin "${name}" onConfigChanged:`, err);
      }

      for (const listener of instance.configChangeListeners) {
        try {
          listener(config);
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

  /* ── Message Hooks ── */

  /* ── Inference Provider ── */

  getInferenceProvider(): PluginInferenceProvider | null {
    for (const instance of this.plugins.values()) {
      if (instance.state !== 'active') continue;
      if (instance.inferenceProvider && instance.inferenceProvider.isAvailable()) {
        return instance.inferenceProvider;
      }
    }
    return null;
  }

  async runPreSendHooks(args: PreSendHookArgs): Promise<PreSendHookResult> {
    let result: PreSendHookResult = { messages: args.messages };

    for (const instance of this.plugins.values()) {
      if (instance.state !== 'active') continue;
      for (const hook of instance.preSendHooks) {
        try {
          result = await hook({ ...args, messages: result.messages });
          if (result.abort) return result;
        } catch (err) {
          console.error(`[PluginManager] Pre-send hook error in "${instance.manifest.name}":`, err);
        }
      }
    }

    return result;
  }

  async runPostReceiveHooks(args: PostReceiveHookArgs): Promise<PostReceiveHookResult> {
    let result: PostReceiveHookResult = { response: args.response };

    for (const instance of this.plugins.values()) {
      if (instance.state !== 'active') continue;
      for (const hook of instance.postReceiveHooks) {
        try {
          result = await hook({ ...args, response: result.response });
        } catch (err) {
          console.error(`[PluginManager] Post-receive hook error in "${instance.manifest.name}":`, err);
        }
      }
    }

    return result;
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
    let pluginHandlers = this.actionHandlers.get(pluginName);
    if (!pluginHandlers) {
      pluginHandlers = new Map();
      this.actionHandlers.set(pluginName, pluginHandlers);
    }
    pluginHandlers.set(targetId, handler);
  }

  async handleAction(payload: PluginActionPayload): Promise<unknown> {
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
    broadcastToAllWindows('plugin:navigation-request', { pluginName, target });
  }

  showPluginNotification(
    pluginName: string,
    descriptor: Omit<PluginNotificationDescriptor, 'pluginName' | 'visible'>,
  ): void {
    const instance = this.plugins.get(pluginName);
    if (!instance) return;

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
      await this.marketplaceService.autoInstallRequired(this.brandRequiredPluginNamesSet, catalog);
    }
  }

  getMarketplaceCatalog(): MarketplaceCatalogEntry[] {
    if (!this.marketplaceService) return [];

    const catalog = this.marketplaceService.getCachedCatalog() ?? [];

    // Annotate with current load status from PluginManager
    return catalog.map((entry) => ({
      ...entry,
      installed: this.plugins.has(entry.name) || this.marketplaceService!.getInstalledPluginNames().includes(entry.name),
    }));
  }

  async installFromMarketplace(pluginName: string): Promise<void> {
    if (!this.marketplaceService) {
      throw new Error('Marketplace is not initialized');
    }

    const catalog = this.marketplaceService.getCachedCatalog();
    const entry = catalog?.find((p) => p.name === pluginName);
    if (!entry) {
      throw new Error(`Plugin "${pluginName}" not found in marketplace catalog`);
    }

    // Unload existing instance if present (handles broken or active plugins)
    await this.unloadPlugin(pluginName);

    await this.marketplaceService.installPlugin(entry);

    // Discover and load the newly installed plugin
    const discovered = this.discoverPlugins();
    const newPlugin = discovered.find((d) => d.manifest.name === pluginName);
    if (newPlugin) {
      await this.loadPlugin(newPlugin.manifest, newPlugin.dir);
    }
  }

  async uninstallFromMarketplace(pluginName: string): Promise<void> {
    if (!this.marketplaceService) {
      throw new Error('Marketplace is not initialized');
    }

    if (this.brandRequiredPluginNamesSet.has(pluginName)) {
      throw new Error(`Plugin "${pluginName}" is required and cannot be uninstalled`);
    }

    await this.unloadPlugin(pluginName);

    this.marketplaceService.uninstallPlugin(pluginName);

    this.broadcastUIState();
    this.notifyToolsChanged();
  }

  async refreshMarketplace(marketplaceUrls?: string[]): Promise<MarketplaceCatalogEntry[]> {
    if (!this.marketplaceService) return [];

    const urls = marketplaceUrls ?? this.getMarketplaceUrls();
    if (urls.length === 0) return [];

    const catalog = await this.marketplaceService.fetchCatalog(urls);
    if (this.brandRequiredPluginNames.length > 0) {
      await this.marketplaceService.autoInstallRequired(this.brandRequiredPluginNamesSet, catalog);
      return this.marketplaceService.getCachedCatalog() ?? catalog;
    }
    return catalog;
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

    store.conversations[conversationId] = conversation as typeof store.conversations[string];
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
    const normalizedContent = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : Array.isArray(message.content)
        ? message.content
        : [];
    const parentId = message.parentId
      ?? (Array.isArray(conversation.messages) && conversation.messages.length > 0
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
      userMessageCount: normalizedRole === 'user'
        ? (conversation.userMessageCount ?? 0) + 1
        : conversation.userMessageCount ?? 0,
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
