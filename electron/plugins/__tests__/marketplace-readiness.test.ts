import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PluginInferenceProvider } from '../types.js';

/**
 * Tests for the marketplace readiness state machine on PluginManager.
 *
 * Regression: opening the Plugins view during the async startup catalog fetch
 * showed "No marketplace configured" because getMarketplaceCatalog() returns []
 * while marketplaceService is still null. getMarketplaceStatus() distinguishes
 * "unconfigured" from "configured but not-yet-settled" so the renderer can show
 * a loading state instead, and initMarketplace() must always flip `ready` (even
 * on failure) and broadcast so a mid-init view can reload.
 */

const broadcastToAllWindows = vi.fn();

vi.mock('electron', () => ({
  Notification: class {
    show() {}
    close() {}
    on() {}
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

// A controllable MarketplaceService stand-in: fetchCatalog resolves or rejects
// on demand so we can exercise both success and failure init paths.
let fetchImpl: () => Promise<unknown[]> = async () => [];
let cachedCatalog: unknown[] = [];
let fetchCallCount = 0;
vi.mock('../marketplace-service.js', () => ({
  UnverifiedPluginError: class extends Error {},
  MarketplaceService: class {
    private reached: boolean | null = null;
    // Mirror the real service: reached=true on a successful fetch (even empty),
    // reached=false when the fetch throws (all URLs unreachable).
    fetchCatalog = async () => {
      fetchCallCount++;
      try {
        const r = await fetchImpl();
        this.reached = true;
        return r;
      } catch (err) {
        this.reached = false;
        throw err;
      }
    };
    getCachedCatalog = () => cachedCatalog;
    getInstalledPluginNames = () => [] as string[];
    wasLastFetchReachable = () => this.reached;
  },
}));
vi.mock('../plugin-api.js', () => ({ createPluginAPI: () => ({}), cleanupPluginAPI: () => {} }));
vi.mock('../plugin-bootstrap.js', () => ({ getBundledPluginIntegrity: () => null }));
vi.mock('../plugin-integrity.js', () => ({
  AUTHENTICATED_BROWSER_PERMISSION: 'browser:authenticated-session',
  arePermissionSetsEqual: () => true,
  hashPluginDirectory: () => '',
  readPluginManifest: () => null,
  snapshotPluginDirectory: () => ({ fileHash: 'trusted-hash', files: new Map() }),
}));
vi.mock('../plugin-compat.js', () => ({ checkPluginCompatibility: () => ({ ok: true }) }));
vi.mock('../renderer-build.js', () => ({ buildPluginRendererBundle: async () => null }));
vi.mock('../../utils/window-send.js', () => ({ broadcastToAllWindows }));
vi.mock('../../tools/skill-loader.js', () => ({ convertJsonSchemaToZod: () => null }));
vi.mock('../../ipc/conversations.js', () => ({ broadcastUpsert: () => {}, broadcastActive: () => {} }));
vi.mock('../../ipc/conversation-store.js', () => ({
  readConversation: () => null,
  readAllConversations: () => [],
  writeConversation: () => {},
  getActiveConversationId: () => null,
  setActiveConversationId: () => {},
}));

const { PluginManager } = await import('../plugin-manager.js');

// __BRAND_MARKETPLACE_URLS is a compile-time `define` baked from the committed
// branding config, so getMarketplaceUrls() can't be varied via a global. Stub
// the private method per instance to model "configured" vs "unconfigured".
function makeManager(urls: string[], requiredPlugins: string[] = [], revokeRenderer = vi.fn()) {
  const mgr = new PluginManager(
    '/tmp/plugins-test',
    '/tmp/app-home-test',
    () => ({}) as never,
    () => {},
    requiredPlugins,
    revokeRenderer,
  );
  (mgr as unknown as { getMarketplaceUrls: () => string[] }).getMarketplaceUrls = () => urls;
  return mgr;
}

beforeEach(() => {
  broadcastToAllWindows.mockClear();
  fetchImpl = async () => [];
  cachedCatalog = [];
  fetchCallCount = 0;
});

describe('required plugin Browser consent', () => {
  it('reports pending permission approval instead of an integrity failure', async () => {
    const manager = makeManager([], ['required-ui']);
    const manifest = {
      name: 'required-ui',
      displayName: 'Required UI',
      version: '1.0.0',
      permissions: ['browser:authenticated-session'],
      capabilities: [],
    };
    const internal = manager as unknown as {
      pendingConsent: Map<string, { manifest: typeof manifest; fileHash: string }>;
      ensurePluginApproved: () => boolean;
      loadPlugin: (plugin: typeof manifest, directory: string) => Promise<void>;
      plugins: Map<string, { error?: string }>;
    };
    internal.pendingConsent.set(manifest.name, { manifest, fileHash: 'trusted-hash' });
    internal.ensurePluginApproved = () => false;

    await internal.loadPlugin(manifest, '/tmp/plugins-test/required-ui');

    expect(internal.plugins.get(manifest.name)?.error).toBe(
      'Plugin permission approval is required before it can be loaded.',
    );
  });
});

describe('frontend update revocation', () => {
  it('revokes a captured previous provider after fail-closed removal from the instance', () => {
    const manager = makeManager([]);
    const revoke = vi.fn();
    manager.setBrowserAssistantRevocationHandler(revoke);
    const provider = {
      name: 'Previous AI',
      isAvailable: () => true,
      stream: vi.fn(),
    } as unknown as PluginInferenceProvider;
    const instance = {
      inferenceProvider: null,
      manifest: { permissions: ['browser:authenticated-session'] },
    };

    const revokeInstance = Reflect.get(manager, 'revokeBrowserAssistantAccessForInstance') as (
      targetInstance: typeof instance,
      provider: PluginInferenceProvider,
    ) => void;
    revokeInstance.call(manager, instance, provider);

    expect(revoke).toHaveBeenCalledOnce();
  });

  it('revokes active Browser inference authority while renderer replacement is pending', () => {
    const manager = makeManager([]);
    const revoke = vi.fn();
    const manifest = {
      name: 'frontend-plugin',
      displayName: 'Frontend Plugin',
      version: '1.0.0',
      permissions: ['agent:inference-provider', 'browser:authenticated-session'],
      capabilities: [],
    };
    const internal = manager as unknown as {
      createPluginInstance: (
        plugin: typeof manifest,
        directory: string,
        state: 'active',
      ) => {
        state: string;
        inferenceProvider: PluginInferenceProvider | null;
      };
      plugins: Map<string, { state: string; inferenceProvider: PluginInferenceProvider | null }>;
      rendererLoadedThisSession: Set<string>;
    };
    const instance = internal.createPluginInstance(manifest, '/tmp/plugins-test/frontend-plugin', 'active');
    const provider = {
      name: 'Frontend AI',
      isAvailable: () => true,
      stream: vi.fn(),
    } as unknown as PluginInferenceProvider;
    instance.inferenceProvider = provider;
    internal.plugins.set(manifest.name, instance);
    internal.rendererLoadedThisSession.add(manifest.name);
    manager.setBrowserAssistantRevocationHandler(revoke);

    expect(manager.getInferenceProvider()).toBe(provider);
    expect(manager.inferenceProviderHasPermission(provider, 'browser:authenticated-session')).toBe(true);

    expect(manager.beginRendererUnload(manifest.name)).toBe(true);
    expect(revoke).toHaveBeenCalledOnce();
    expect(manager.getInferenceProvider()).toBeNull();
    expect(manager.inferenceProviderHasPermission(provider, 'browser:authenticated-session')).toBe(false);

    expect(manager.cancelRendererUnload(manifest.name)).toBe(true);
    expect(manager.getInferenceProvider()).toBe(provider);
    expect(manager.inferenceProviderHasPermission(provider, 'browser:authenticated-session')).toBe(true);
  });

  it('revokes primary-renderer authority even when no replacement handler is available', async () => {
    const revokeRenderer = vi.fn();
    const manager = makeManager([], [], revokeRenderer);
    const manifest = {
      name: 'missing-replacement',
      displayName: 'Missing Replacement',
      version: '1.0.0',
      permissions: ['agent:inference-provider', 'browser:authenticated-session'],
      capabilities: [],
    };
    const internal = manager as unknown as {
      createPluginInstance: (
        plugin: typeof manifest,
        directory: string,
        state: 'active',
      ) => { state: string; inferenceProvider: PluginInferenceProvider | null };
      plugins: Map<string, { state: string; inferenceProvider: PluginInferenceProvider | null }>;
      rendererLoadedThisSession: Set<string>;
    };
    const instance = internal.createPluginInstance(manifest, '/tmp/plugins-test/missing-replacement', 'active');
    instance.inferenceProvider = {
      name: 'Missing Replacement AI',
      isAvailable: () => true,
      stream: vi.fn(),
    } as unknown as PluginInferenceProvider;
    internal.plugins.set(manifest.name, instance);
    internal.rendererLoadedThisSession.add(manifest.name);

    await expect(manager.disablePlugin(manifest.name, { persist: false })).rejects.toThrow(
      /before its renderer is replaced/,
    );

    expect(revokeRenderer).toHaveBeenCalledOnce();
    expect(manager.getInferenceProvider()).toBeNull();
  });

  it('does NOT reload the renderer when a lifecycle op is refused by an active update freeze (R28P9)', async () => {
    const revokeRenderer = vi.fn();
    const manager = makeManager([], [], revokeRenderer);
    const manifest = {
      name: 'frozen-target',
      displayName: 'Frozen Target',
      version: '1.0.0',
      permissions: [],
      capabilities: [],
    };
    const internal = manager as unknown as {
      createPluginInstance: (p: typeof manifest, d: string, s: 'active') => { state: string };
      plugins: Map<string, { state: string }>;
      rendererLoadedThisSession: Set<string>;
    };
    internal.plugins.set(
      manifest.name,
      internal.createPluginInstance(manifest, '/tmp/plugins-test/frozen-target', 'active'),
    );
    internal.rendererLoadedThisSession.add(manifest.name); // has a renderer that WOULD be reloaded

    await manager.beginUpdateFreeze();
    await expect(manager.disablePlugin(manifest.name, { persist: false })).rejects.toThrow(
      /finishing a previous update/i,
    );
    // The freeze check runs BEFORE withRendererReplacementForUpdate, so no needless
    // full renderer reload happened for the refused op (R28P9).
    expect(revokeRenderer).not.toHaveBeenCalled();
    manager.endUpdateFreeze();
  });

  it('continues renderer replacement when assistant revocation bookkeeping throws', async () => {
    const revokeRenderer = vi.fn();
    const manager = makeManager([], [], revokeRenderer);
    const replacement = vi.fn(async () => undefined);
    const operation = vi.fn(async () => 'updated');
    const manifest = {
      name: 'revocation-replacement',
      displayName: 'Revocation Replacement',
      version: '1.0.0',
      permissions: ['agent:inference-provider', 'browser:authenticated-session'],
      capabilities: [],
    };
    const internal = manager as unknown as {
      createPluginInstance: (
        plugin: typeof manifest,
        directory: string,
        state: 'active',
      ) => { inferenceProvider: PluginInferenceProvider | null };
      plugins: Map<string, { inferenceProvider: PluginInferenceProvider | null }>;
      rendererLoadedThisSession: Set<string>;
      withRendererReplacementForUpdate: <T>(pluginName: string, callback: () => Promise<T>) => Promise<T>;
    };
    const instance = internal.createPluginInstance(manifest, '/tmp/plugins-test/revocation-replacement', 'active');
    instance.inferenceProvider = {
      name: 'Revocation Replacement AI',
      isAvailable: () => true,
      stream: vi.fn(),
    } as unknown as PluginInferenceProvider;
    internal.plugins.set(manifest.name, instance);
    internal.rendererLoadedThisSession.add(manifest.name);
    manager.setBrowserAssistantRevocationHandler(() => {
      throw new Error('assistant bookkeeping failed');
    });
    manager.setRendererReplacementHandler(replacement);

    await expect(internal.withRendererReplacementForUpdate(manifest.name, operation)).resolves.toBe('updated');

    expect(revokeRenderer).toHaveBeenCalledOnce();
    expect(replacement).toHaveBeenCalledWith(manifest.name);
    expect(operation).toHaveBeenCalledOnce();
  });

  it('replaces a crashed plugin frontend before completing backend cleanup', async () => {
    const manager = makeManager([]);
    const replacement = vi.fn(async () => undefined);
    const manifest = {
      name: 'frontend-plugin',
      displayName: 'Frontend Plugin',
      version: '1.0.0',
      permissions: ['browser:authenticated-session'],
      capabilities: [],
    };
    const internal = manager as unknown as {
      createPluginInstance: (plugin: typeof manifest, directory: string, state: 'active') => object;
      plugins: Map<string, object>;
      rendererLoadedThisSession: Set<string>;
      rendererRevocations: Set<string>;
      broadcastUIState: () => void;
      notifyToolsChanged: () => void;
      notifyCliToolsChanged: () => void;
      handleUnexpectedPluginExit: (instance: object, details: { code: number; error?: string }) => Promise<void>;
    };
    const instance = internal.createPluginInstance(manifest, '/tmp/plugins-test/frontend-plugin', 'active');
    Reflect.set(instance, 'rendererBuild', {});
    internal.plugins.set(manifest.name, instance);
    internal.rendererLoadedThisSession.add(manifest.name);
    internal.broadcastUIState = vi.fn();
    internal.notifyToolsChanged = vi.fn();
    internal.notifyCliToolsChanged = vi.fn();
    manager.setRendererReplacementHandler(replacement);

    await internal.handleUnexpectedPluginExit(instance, { code: 1, error: 'backend crashed' });

    expect(replacement).toHaveBeenCalledWith(manifest.name);
    expect(Reflect.get(instance, 'state')).toBe('error');
    expect(Reflect.get(instance, 'rendererBuild')).toBeNull();
    expect(internal.rendererLoadedThisSession.has(manifest.name)).toBe(false);
    expect(internal.rendererRevocations.has(manifest.name)).toBe(false);
  });

  it('keeps a crashed plugin frontend revoked when renderer replacement fails', async () => {
    const manager = makeManager([]);
    const replacementError = new Error('renderer replacement failed');
    const replacement = vi.fn(async () => {
      throw replacementError;
    });
    const manifest = {
      name: 'frontend-plugin',
      displayName: 'Frontend Plugin',
      version: '1.0.0',
      permissions: ['browser:authenticated-session'],
      capabilities: [],
    };
    const internal = manager as unknown as {
      createPluginInstance: (plugin: typeof manifest, directory: string, state: 'active') => object;
      plugins: Map<string, object>;
      rendererLoadedThisSession: Set<string>;
      rendererRevocations: Set<string>;
      broadcastUIState: () => void;
      notifyToolsChanged: () => void;
      notifyCliToolsChanged: () => void;
      handleUnexpectedPluginExit: (instance: object, details: { code: number; error?: string }) => Promise<void>;
    };
    const instance = internal.createPluginInstance(manifest, '/tmp/plugins-test/frontend-plugin', 'active');
    Reflect.set(instance, 'rendererBuild', {});
    internal.plugins.set(manifest.name, instance);
    internal.rendererLoadedThisSession.add(manifest.name);
    internal.broadcastUIState = vi.fn();
    internal.notifyToolsChanged = vi.fn();
    internal.notifyCliToolsChanged = vi.fn();
    manager.setRendererReplacementHandler(replacement);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await internal.handleUnexpectedPluginExit(instance, { code: 1, error: 'backend crashed' });
    } finally {
      consoleError.mockRestore();
    }

    expect(internal.rendererLoadedThisSession.has(manifest.name)).toBe(true);
    expect(internal.rendererRevocations.has(manifest.name)).toBe(true);
  });

  it('replaces the privileged renderer before running an update and then releases the new generation', async () => {
    const manager = makeManager([]);
    const replacement = vi.fn(async () => undefined);
    const operation = vi.fn(async () => 'updated');
    const internal = manager as unknown as {
      plugins: Map<string, { state: string; rendererBuild?: object }>;
      rendererLoadedThisSession: Set<string>;
      rendererRevocations: Set<string>;
      broadcastUIState: () => void;
      withRendererReplacementForUpdate: <T>(pluginName: string, work: () => Promise<T>) => Promise<T>;
    };
    internal.broadcastUIState = vi.fn();
    internal.plugins.set('frontend-plugin', { state: 'active', rendererBuild: {} });
    internal.rendererLoadedThisSession.add('frontend-plugin');
    manager.setRendererReplacementHandler(replacement);

    await expect(internal.withRendererReplacementForUpdate('frontend-plugin', operation)).resolves.toBe('updated');

    expect(replacement).toHaveBeenCalledWith('frontend-plugin');
    expect(operation).toHaveBeenCalledOnce();
    expect(internal.rendererLoadedThisSession.has('frontend-plugin')).toBe(true);
    expect(internal.rendererRevocations.has('frontend-plugin')).toBe(false);
  });

  it('keeps an update frontend revoked when renderer replacement fails', async () => {
    const manager = makeManager([]);
    const replacementError = new Error('renderer replacement failed');
    const replacement = vi.fn(async () => {
      throw replacementError;
    });
    const operation = vi.fn(async () => 'updated');
    const internal = manager as unknown as {
      plugins: Map<string, { state: string; rendererBuild?: object }>;
      rendererLoadedThisSession: Set<string>;
      rendererRevocations: Set<string>;
      broadcastUIState: () => void;
      withRendererReplacementForUpdate: <T>(pluginName: string, work: () => Promise<T>) => Promise<T>;
    };
    internal.broadcastUIState = vi.fn();
    internal.plugins.set('frontend-plugin', { state: 'active', rendererBuild: {} });
    internal.rendererLoadedThisSession.add('frontend-plugin');
    manager.setRendererReplacementHandler(replacement);

    await expect(internal.withRendererReplacementForUpdate('frontend-plugin', operation)).rejects.toBe(
      replacementError,
    );

    expect(operation).not.toHaveBeenCalled();
    expect(internal.rendererLoadedThisSession.has('frontend-plugin')).toBe(true);
    expect(internal.rendererRevocations.has('frontend-plugin')).toBe(true);
  });

  it('restores a denied frontend update into the replacement renderer without a restart banner', async () => {
    const manager = makeManager([]);
    const replacement = vi.fn(async () => undefined);
    const pluginName = 'frontend-plugin';
    const restoredManifest = {
      name: pluginName,
      displayName: 'Frontend Plugin',
      version: '1.0.0',
      permissions: ['browser:authenticated-session'],
    };
    const internal = manager as unknown as {
      plugins: Map<string, { state: string; manifest?: typeof restoredManifest; rendererBuild?: object }>;
      rendererLoadedThisSession: Set<string>;
      pendingConsentRollback: Map<
        string,
        {
          attemptedVersion: string;
          backupDir?: string;
          priorInstalledRecord?: { version: string };
        }
      >;
      marketplaceService: { rollbackInstall: ReturnType<typeof vi.fn> } | null;
      broadcastUIState: () => void;
      broadcastUpdateCount: () => void;
      discoverPlugins: () => Array<{ manifest: typeof restoredManifest; dir: string }>;
      loadPlugin: (manifest: typeof restoredManifest, dir: string) => Promise<void>;
      unloadPlugin: (pluginName: string) => Promise<void>;
      resolvePendingConsentRollback: (pluginName: string, activated: boolean, error?: string) => Promise<void>;
      withRendererReplacementForUpdate: <T>(pluginName: string, work: () => Promise<T>) => Promise<T>;
    };
    internal.broadcastUIState = vi.fn();
    internal.broadcastUpdateCount = vi.fn();
    internal.plugins.set(pluginName, { state: 'active', manifest: restoredManifest, rendererBuild: {} });
    internal.rendererLoadedThisSession.add(pluginName);
    manager.setRendererReplacementHandler(replacement);

    await internal.withRendererReplacementForUpdate(pluginName, async () => {
      internal.plugins.set(pluginName, { state: 'error' });
      internal.pendingConsentRollback.set(pluginName, {
        attemptedVersion: '2.0.0',
        backupDir: '/tmp/plugins-test/frontend-plugin.prev',
        priorInstalledRecord: { version: '1.0.0' },
      });
    });

    expect(replacement).toHaveBeenCalledWith(pluginName);
    expect(manager.getPendingRestart()).toEqual([]);
    internal.marketplaceService = { rollbackInstall: vi.fn() };
    internal.unloadPlugin = vi.fn(async () => {
      internal.plugins.delete(pluginName);
    });
    internal.discoverPlugins = () => [{ manifest: restoredManifest, dir: '/tmp/plugins-test/frontend-plugin' }];
    internal.loadPlugin = vi.fn(async (manifest) => {
      internal.plugins.set(pluginName, { state: 'active', manifest, rendererBuild: {} });
      // loadPlugin records a restored frontend as available before the fresh
      // renderer consumes the following UI-state broadcast.
      internal.rendererLoadedThisSession.add(pluginName);
    });

    await internal.resolvePendingConsentRollback(pluginName, false, 'Permission denied by user');

    expect(internal.marketplaceService.rollbackInstall).toHaveBeenCalledOnce();
    expect(manager.getPendingRestart()).toEqual([]);
  });

  it('holds the per-plugin lock across disable revocation and renderer replacement', async () => {
    const manager = makeManager([]);
    let replacementStarted!: () => void;
    let releaseReplacement!: () => void;
    const started = new Promise<void>((resolve) => (replacementStarted = resolve));
    const replacementGate = new Promise<void>((resolve) => (releaseReplacement = resolve));
    const replacement = vi.fn(async () => {
      replacementStarted();
      await replacementGate;
    });
    const concurrentUpdate = vi.fn(async () => undefined);
    const manifest = {
      name: 'frontend-plugin',
      displayName: 'Frontend Plugin',
      version: '1.0.0',
      permissions: ['browser:authenticated-session'],
    };
    const internal = manager as unknown as {
      createPluginInstance: (plugin: typeof manifest, directory: string, state: 'active') => { state: string };
      plugins: Map<string, { state: string; rendererBuild?: object }>;
      rendererLoadedThisSession: Set<string>;
      rendererRevocations: Set<string>;
      unloadPlugin: (pluginName: string) => Promise<void>;
      withInstallLock: <T>(pluginName: string, work: () => Promise<T>) => Promise<T>;
      broadcastUIState: () => void;
      notifyToolsChanged: () => void;
      notifyCliToolsChanged: () => void;
    };
    const instance = internal.createPluginInstance(manifest, '/tmp/plugins-test/frontend-plugin', 'active');
    internal.plugins.set('frontend-plugin', { ...instance, rendererBuild: {} });
    internal.rendererLoadedThisSession.add('frontend-plugin');
    internal.unloadPlugin = vi.fn(async () => {
      internal.plugins.delete('frontend-plugin');
    });
    internal.broadcastUIState = vi.fn();
    internal.notifyToolsChanged = vi.fn();
    internal.notifyCliToolsChanged = vi.fn();
    manager.setRendererReplacementHandler(replacement);

    const disabling = manager.disablePlugin('frontend-plugin', { persist: false });
    await started;
    expect(internal.rendererRevocations.has('frontend-plugin')).toBe(true);

    const updating = internal.withInstallLock('frontend-plugin', concurrentUpdate);
    await Promise.resolve();
    expect(concurrentUpdate).not.toHaveBeenCalled();

    releaseReplacement();
    await disabling;
    await updating;

    expect(concurrentUpdate).toHaveBeenCalledOnce();
    expect(internal.rendererRevocations.has('frontend-plugin')).toBe(false);
    expect(internal.plugins.get('frontend-plugin')?.state).toBe('disabled');
  });

  it('coalesces enable requests that queued while the plugin was disabled', async () => {
    const manager = makeManager([]);
    const pluginName = 'queued-enable';
    const manifest = {
      name: pluginName,
      displayName: 'Queued Enable',
      version: '1.0.0',
      permissions: [],
      capabilities: [],
    };
    let releaseBlocker!: () => void;
    let blockerStarted!: () => void;
    const blockerGate = new Promise<void>((resolve) => (releaseBlocker = resolve));
    const blockerEntered = new Promise<void>((resolve) => (blockerStarted = resolve));
    let releaseLoad!: () => void;
    let loadStarted!: () => void;
    const loadGate = new Promise<void>((resolve) => (releaseLoad = resolve));
    const loadEntered = new Promise<void>((resolve) => (loadStarted = resolve));
    const internal = manager as unknown as {
      plugins: Map<string, { state: string; manifest?: typeof manifest }>;
      withInstallLock: <T>(pluginName: string, work: () => Promise<T>) => Promise<T>;
      unloadPlugin: (pluginName: string) => Promise<void>;
      discoverPlugins: () => Array<{ manifest: typeof manifest; dir: string }>;
      loadPlugin: (pluginManifest: typeof manifest, dir: string) => Promise<void>;
    };
    internal.plugins.set(pluginName, { state: 'disabled', manifest });
    internal.unloadPlugin = vi.fn(async () => {
      internal.plugins.delete(pluginName);
    });
    internal.discoverPlugins = () => [{ manifest, dir: `/tmp/plugins-test/${pluginName}` }];
    internal.loadPlugin = vi.fn(async () => {
      loadStarted();
      await loadGate;
      internal.plugins.set(pluginName, { state: 'active', manifest });
    });

    const blocker = internal.withInstallLock(pluginName, async () => {
      blockerStarted();
      await blockerGate;
    });
    await blockerEntered;
    const first = manager.enablePlugin(pluginName);
    const duplicate = manager.enablePlugin(pluginName);
    releaseBlocker();
    await blocker;
    await loadEntered;
    releaseLoad();
    await Promise.all([first, duplicate]);

    expect(internal.unloadPlugin).toHaveBeenCalledOnce();
    expect(internal.loadPlugin).toHaveBeenCalledOnce();
    expect(internal.plugins.get(pluginName)?.state).toBe('active');
  });

  it('revokes Browser-authorized inference turns before backend-only deactivation can block', async () => {
    const manager = makeManager([]);
    let releaseDeactivate!: () => void;
    const deactivateGate = new Promise<void>((resolve) => (releaseDeactivate = resolve));
    const deactivate = vi.fn(() => deactivateGate);
    const revoke = vi.fn();
    const manifest = {
      name: 'backend-inference',
      displayName: 'Backend Inference',
      version: '1.0.0',
      permissions: ['agent:inference-provider', 'browser:authenticated-session'],
    };
    const internal = manager as unknown as {
      createPluginInstance: (
        plugin: typeof manifest,
        directory: string,
        state: 'active',
      ) => {
        state: string;
        inferenceProvider: unknown;
      };
      plugins: Map<string, { state: string; inferenceProvider: unknown }>;
      pluginProcesses: Map<string, { deactivate: () => Promise<void> }>;
    };
    const instance = internal.createPluginInstance(manifest, '/tmp/plugins-test/backend-inference', 'active');
    const provider = {
      name: 'Backend AI',
      isAvailable: () => true,
      stream: vi.fn(),
    };
    instance.inferenceProvider = provider;
    internal.plugins.set(manifest.name, instance);
    internal.pluginProcesses.set(manifest.name, { deactivate });
    manager.setBrowserAssistantRevocationHandler(revoke);

    const disabling = manager.disablePlugin(manifest.name, { persist: false });
    await vi.waitFor(() => expect(deactivate).toHaveBeenCalledOnce());

    expect(revoke).toHaveBeenCalled();
    expect(revoke.mock.invocationCallOrder[0]).toBeLessThan(deactivate.mock.invocationCallOrder[0]);
    expect(manager.getInferenceProvider()).toBeNull();
    expect(manager.inferenceProviderHasPermission(provider, 'browser:authenticated-session')).toBe(false);

    releaseDeactivate();
    await disabling;
    expect(internal.plugins.get(manifest.name)?.state).toBe('disabled');
  });

  it('rejects disable and leaves the provider unavailable when Browser revocation fails', async () => {
    const manager = makeManager([]);
    const deactivate = vi.fn(async () => undefined);
    const manifest = {
      name: 'revocation-failure',
      displayName: 'Revocation Failure',
      version: '1.0.0',
      permissions: ['agent:inference-provider', 'browser:authenticated-session'],
    };
    const internal = manager as unknown as {
      createPluginInstance: (
        plugin: typeof manifest,
        directory: string,
        state: 'active',
      ) => { state: string; tearingDown: boolean; inferenceProvider: PluginInferenceProvider | null };
      plugins: Map<string, { state: string; tearingDown: boolean; inferenceProvider: PluginInferenceProvider | null }>;
      pluginProcesses: Map<string, { deactivate: () => Promise<void> }>;
    };
    const instance = internal.createPluginInstance(manifest, '/tmp/plugins-test/revocation-failure', 'active');
    const provider = {
      name: 'Backend AI',
      isAvailable: () => true,
      stream: vi.fn(),
    } as unknown as PluginInferenceProvider;
    instance.inferenceProvider = provider;
    internal.plugins.set(manifest.name, instance);
    internal.pluginProcesses.set(manifest.name, { deactivate });
    manager.setBrowserAssistantRevocationHandler(() => {
      throw new Error('authority bookkeeping failed');
    });

    await expect(manager.disablePlugin(manifest.name, { persist: false })).rejects.toThrow(
      /Browser assistant access could not be revoked/,
    );

    expect(deactivate).not.toHaveBeenCalled();
    expect(instance.tearingDown).toBe(true);
    expect(manager.getInferenceProvider()).toBeNull();
    expect(manager.inferenceProviderHasPermission(provider, 'browser:authenticated-session')).toBe(false);
    expect(internal.plugins.get(manifest.name)?.state).toBe('active');
  });

  it('rejects bulk unload without re-exposing a provider whose Browser revocation failed', async () => {
    const manager = makeManager([]);
    const manifest = {
      name: 'unload-revocation-failure',
      displayName: 'Unload Revocation Failure',
      version: '1.0.0',
      permissions: ['agent:inference-provider', 'browser:authenticated-session'],
    };
    const internal = manager as unknown as {
      createPluginInstance: (
        plugin: typeof manifest,
        directory: string,
        state: 'active',
      ) => { tearingDown: boolean; inferenceProvider: PluginInferenceProvider | null };
      plugins: Map<string, { tearingDown: boolean; inferenceProvider: PluginInferenceProvider | null }>;
    };
    const instance = internal.createPluginInstance(manifest, '/tmp/plugins-test/unload-revocation-failure', 'active');
    instance.inferenceProvider = {
      name: 'Backend AI',
      isAvailable: () => true,
      stream: vi.fn(),
    } as unknown as PluginInferenceProvider;
    internal.plugins.set(manifest.name, instance);
    manager.setBrowserAssistantRevocationHandler(() => {
      throw new Error('authority bookkeeping failed');
    });

    await expect(manager.unloadAll()).rejects.toThrow(/Browser assistant access could not be revoked/);
    expect(instance.tearingDown).toBe(true);
    expect(manager.getInferenceProvider()).toBeNull();
  });
});

describe('getMarketplaceStatus', () => {
  it('reports not-ready before initMarketplace runs', () => {
    const mgr = makeManager(['https://plugins.example.com/catalog.json']);
    expect(mgr.getMarketplaceStatus()).toEqual({
      configured: true,
      ready: false,
      reachable: false,
      catalogSize: 0,
    });
  });

  it('reports configured=false when the brand has no marketplace URLs', () => {
    const mgr = makeManager([]);
    expect(mgr.getMarketplaceStatus().configured).toBe(false);
  });

  it('flips ready=true, reachable=true and broadcasts once the catalog fetch succeeds', async () => {
    cachedCatalog = [{ name: 'a' }, { name: 'b' }];
    fetchImpl = async () => cachedCatalog;
    const mgr = makeManager(['https://plugins.example.com/catalog.json']);

    await mgr.initMarketplace(['https://plugins.example.com/catalog.json']);

    expect(mgr.getMarketplaceStatus()).toEqual({
      configured: true,
      ready: true,
      reachable: true,
      catalogSize: 2,
    });
    expect(broadcastToAllWindows).toHaveBeenCalledWith(
      'plugin:marketplace-ready',
      expect.objectContaining({ configured: true, ready: true, reachable: true }),
    );
  });

  it('reports reachable=true for a VALID empty catalog (endpoint returned zero plugins)', async () => {
    // The regression: a reachable endpoint returning `{ plugins: [] }` must NOT
    // be reported as unreachable just because the catalog is empty.
    cachedCatalog = [];
    fetchImpl = async () => [];
    const mgr = makeManager(['https://plugins.example.com/catalog.json']);

    await mgr.initMarketplace(['https://plugins.example.com/catalog.json']);

    expect(mgr.getMarketplaceStatus()).toEqual({
      configured: true,
      ready: true,
      reachable: true,
      catalogSize: 0,
    });
  });

  it('reports reachable=false when the fetch fails with no cache', async () => {
    cachedCatalog = [];
    fetchImpl = async () => {
      throw new Error('network down');
    };
    const mgr = makeManager(['https://plugins.example.com/catalog.json']);

    await mgr.initMarketplace(['https://plugins.example.com/catalog.json']);

    // configured + ready + NOT reachable + empty → renderer shows "couldn't
    // reach", distinct from a valid empty catalog and from "unconfigured".
    expect(mgr.getMarketplaceStatus()).toEqual({
      configured: true,
      ready: true,
      reachable: false,
      catalogSize: 0,
    });
    expect(broadcastToAllWindows).toHaveBeenCalledWith('plugin:marketplace-ready', expect.any(Object));
  });

  it('reports marketplaceBootstrapIncomplete when the catalog is unreachable and a REQUIRED plugin is absent (R52P1)', async () => {
    cachedCatalog = [];
    fetchImpl = async () => {
      throw new Error('network down');
    };
    // A brand-required plugin that is NOT installed on disk (fresh profile). With the
    // catalog unreachable, its auto-install can't run → its pre-update veto would be
    // missing at an app update, so init must report incomplete to block installs.
    const mgr = makeManager(['https://plugins.example.com/catalog.json'], ['required-ui']);

    const result = await mgr.initMarketplace(['https://plugins.example.com/catalog.json']);

    expect(result.marketplaceBootstrapIncomplete).toBe(true);
  });

  it('does NOT report incomplete when the catalog is unreachable but NO plugin is required (R52P1)', async () => {
    cachedCatalog = [];
    fetchImpl = async () => {
      throw new Error('network down');
    };
    const mgr = makeManager(['https://plugins.example.com/catalog.json']); // no required plugins

    const result = await mgr.initMarketplace(['https://plugins.example.com/catalog.json']);

    // No required plugin → an unreachable catalog strands nothing → not incomplete.
    expect(result.marketplaceBootstrapIncomplete).toBe(false);
  });

  it('does NOT report incomplete with zero configured marketplace URLs (R52P1)', async () => {
    const mgr = makeManager([], ['required-ui']);
    const result = await mgr.initMarketplace([]);
    expect(result.marketplaceBootstrapIncomplete).toBe(false);
  });

  it('flips ready=true and broadcasts even with zero configured URLs', async () => {
    const mgr = makeManager([]);

    await mgr.initMarketplace([]);

    expect(mgr.getMarketplaceStatus()).toEqual({
      configured: false,
      ready: true,
      reachable: false,
      catalogSize: 0,
    });
    expect(broadcastToAllWindows).toHaveBeenCalledWith('plugin:marketplace-ready', expect.any(Object));
  });

  it('single-flights concurrent catalog fetches (init + refresh share one fetch)', async () => {
    // A slow fetch so init and refresh overlap in flight.
    let resolveFetch: (v: unknown[]) => void = () => {};
    let fetchStarted: () => void = () => {};
    const started = new Promise<void>((r) => (fetchStarted = r));
    fetchImpl = () =>
      new Promise<unknown[]>((r) => {
        resolveFetch = r;
        fetchStarted();
      });
    const urls = ['https://plugins.example.com/catalog.json'];
    const mgr = makeManager(urls);

    const initP = mgr.initMarketplace(urls);
    const refreshP = mgr.refreshMarketplace(urls);
    // The fetch runs on a microtask (chained), so wait until fetchImpl has
    // actually been invoked before resolving it.
    await started;
    resolveFetch([]);
    await Promise.all([initP, refreshP]);

    // Both callers observed the same in-flight fetch — not two competing ones.
    expect(fetchCallCount).toBe(1);
  });

  it('does NOT share a single-flight across different URL sets (serializes them)', async () => {
    const mgr = makeManager(['https://a.example.com/catalog.json']);
    // Create the marketplaceService (refreshMarketplace no-ops without it) via a
    // fast initial init, then reset the fetch counter.
    fetchImpl = async () => [];
    await mgr.initMarketplace(['https://a.example.com/catalog.json']);
    fetchCallCount = 0;

    // Each fetch resolves on the next microtask tick — different url sets must
    // run SEQUENTIALLY (chained), so the second fetch starts only after the
    // first settles. A shared flight would collapse them to one fetch; a
    // concurrent (unserialized) design would race them.
    fetchImpl = async () => {
      await Promise.resolve();
      return [];
    };

    const p1 = mgr.refreshMarketplace(['https://a.example.com/catalog.json']);
    const p2 = mgr.refreshMarketplace(['https://b.example.com/catalog.json']);
    await Promise.all([p1, p2]);

    // Two distinct URL sets ⇒ two distinct fetches (not coalesced).
    expect(fetchCallCount).toBe(2);
  });
});
