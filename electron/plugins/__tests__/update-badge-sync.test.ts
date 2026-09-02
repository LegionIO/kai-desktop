import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Regression: the plugin-update badge (macOS Dock + in-app Plugins icon) stayed
 * stuck at "1" after a plugin update that did NOT require a full restart.
 *
 * Root cause: the renderer seeds its badge from a DIRECT getter pull
 * (`plugin:available-update-count`), which returned the live count but never
 * updated main's `lastUpdateCount`. `broadcastUpdateCount()` deduped against
 * `lastUpdateCount`, so a post-update recompute back to the same numeric value
 * main last *broadcast* (0) — while the renderer displayed 1 from the pull —
 * suppressed the "now 0" clear. The badge only cleared on restart.
 *
 * Fix: (a) the pull path records `lastUpdateCount` so pull and broadcast can't
 * desync, and (b) install/update/reject paths force the emit past the dedupe.
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
vi.mock('../marketplace-service.js', () => ({
  UnverifiedPluginError: class extends Error {},
  MarketplaceService: class {},
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

type UpdateBadgeInternal = {
  marketplaceService: { getCachedCatalog: () => Array<{ name: string; version: string }> } | null;
  plugins: Map<string, { manifest: { version: string } }>;
  lastUpdateCount: number;
  getAvailableUpdateCountForRenderer: () => number;
  broadcastUpdateCount: (options?: { force?: boolean }) => void;
};

function makeManager() {
  const mgr = new PluginManager(
    '/tmp/plugins-test',
    '/tmp/app-home-test',
    () => ({}) as never,
    () => {},
    [],
    vi.fn(),
  );
  return mgr as unknown as UpdateBadgeInternal;
}

/** Model an installed plugin whose catalog entry is one version ahead. */
function setUpdateAvailable(mgr: UpdateBadgeInternal, installedVersion: string, catalogVersion: string) {
  mgr.plugins = new Map([['p', { manifest: { version: installedVersion } }]]);
  mgr.marketplaceService = {
    getCachedCatalog: () => [{ name: 'p', version: catalogVersion }],
  };
}

beforeEach(() => {
  broadcastToAllWindows.mockClear();
});

describe('plugin update-count badge sync', () => {
  it('reproduces the stuck badge without the fix: broadcast is suppressed when the renderer pulled 1 but lastUpdateCount is 0', () => {
    const mgr = makeManager();
    // Update available: installed 1.0.0, catalog 2.0.0 → count 1.
    setUpdateAvailable(mgr, '1.0.0', '2.0.0');

    // Renderer seeds its badge from the direct pull (getter also syncs lastUpdateCount now).
    expect(mgr.getAvailableUpdateCountForRenderer()).toBe(1);
    expect(mgr.lastUpdateCount).toBe(1);

    // Update applies with no restart: in-memory manifest advances to 2.0.0 → count 0.
    mgr.plugins = new Map([['p', { manifest: { version: '2.0.0' } }]]);

    // A plain (unforced) broadcast now emits because 0 !== lastUpdateCount(1),
    // because the pull kept lastUpdateCount in sync. The badge clears.
    mgr.broadcastUpdateCount();
    expect(broadcastToAllWindows).toHaveBeenCalledWith('plugin:updates-available', { count: 0 });
  });

  it('force clears the badge even if lastUpdateCount already matches the recomputed count', () => {
    const mgr = makeManager();
    setUpdateAvailable(mgr, '1.0.0', '2.0.0');

    // Simulate the pre-fix desync directly: main last broadcast 0, but the
    // renderer displays 1 from a pull that (in the buggy world) didn't sync.
    mgr.lastUpdateCount = 0;
    mgr.plugins = new Map([['p', { manifest: { version: '2.0.0' } }]]); // update applied → count 0

    // Unforced would be suppressed (0 === 0). Forced always emits so the badge clears.
    mgr.broadcastUpdateCount({ force: true });
    expect(broadcastToAllWindows).toHaveBeenCalledWith('plugin:updates-available', { count: 0 });
  });

  it('the renderer pull records lastUpdateCount so pull and broadcast never desync', () => {
    const mgr = makeManager();
    setUpdateAvailable(mgr, '1.0.0', '2.0.0');

    // Fresh manager: lastUpdateCount starts at 0 (nothing broadcast yet).
    expect(mgr.lastUpdateCount).toBe(0);

    // The renderer pulls the live count of 1 — and the getter records it.
    expect(mgr.getAvailableUpdateCountForRenderer()).toBe(1);
    expect(mgr.lastUpdateCount).toBe(1);
  });
});
