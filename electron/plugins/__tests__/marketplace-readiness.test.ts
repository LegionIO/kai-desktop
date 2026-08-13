import { describe, expect, it, vi, beforeEach } from 'vitest';

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
  arePermissionSetsEqual: () => true,
  hashPluginDirectory: () => '',
  readPluginManifest: () => null,
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
function makeManager(urls: string[]) {
  const mgr = new PluginManager(
    '/tmp/plugins-test',
    '/tmp/app-home-test',
    () => ({}) as never,
    () => {},
    [],
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
