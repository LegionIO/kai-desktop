import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Crash-recovery reconcile: after the window-health monitor force-reloads a wedged
 * renderer, plugin utility processes may already be dead. main calls
 * reconcileAfterRendererReload() on the post-reload did-finish-load edge to
 * re-broadcast UI state and best-effort re-load dead hosts. getDegradedPlugins()
 * reports what should be active but isn't — reconciled against on-disk discovery,
 * so it's correct whether a crash left an `error` row or dropped the instance.
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

type Discovered = { manifest: { name: string; version: string; permissions: string[] }; dir: string };

type ReconcileInternal = {
  plugins: Map<string, { manifest: { name: string; version: string }; state: string; error?: string }>;
  pluginProcesses: Map<string, unknown>;
  installLocks: Map<string, Promise<unknown>>;
  sessionDisabled: Set<string>;
  brandRequiredPluginNamesSet: Set<string>;
  updateFreezeActive: boolean;
  bootstrapComplete: boolean;
  crashedPlugins: Set<string>;
  crashRecoveryAttempts: Map<string, number>;
  lastDiscoveryIncomplete: boolean;
  assertNotFrozen: (name: string) => void;
  discoverPlugins: (opts?: { throwOnReadError?: boolean }) => Discovered[];
  getPersistentlyDisabled: () => Set<string>;
  loadPlugin: (manifest: unknown, dir: string, opts?: unknown) => Promise<void>;
  unloadPlugin: (name: string) => Promise<void>;
  broadcastUIState: () => void;
  forceUIStateReplay: () => void;
  broadcastDegraded: () => void;
  notifyToolsChanged: () => void;
  notifyCliToolsChanged: () => void;
  getDegradedPlugins: () => string[];
  reconcileAfterRendererReload: () => Promise<{ recovered: string[]; failed: string[]; stillDegraded: string[] }>;
};

function disc(name: string): Discovered {
  return { manifest: { name, version: '1.0.0', permissions: [] }, dir: `/tmp/plugins/${name}` };
}

function makeManager(): ReconcileInternal {
  const mgr = new PluginManager(
    '/tmp/plugins-test',
    '/tmp/app-home-test',
    () => ({}) as never,
    () => {},
    [],
    vi.fn(),
  );
  const internal = mgr as unknown as ReconcileInternal;
  // Default: nothing persistently disabled, nothing discovered, bootstrap already
  // finished (the crash-recovery scenario is always post-boot; getDegradedPlugins
  // returns [] until bootstrapComplete so tests must opt in).
  internal.getPersistentlyDisabled = () => new Set();
  internal.discoverPlugins = () => [];
  internal.bootstrapComplete = true;
  // Neutralize broadcast plumbing — these touch getUIState() (disk) + electron
  // window fan-out, which aren't what these logic tests exercise. Individual tests
  // spy on broadcastUIState where they assert it fired.
  internal.broadcastUIState = () => {};
  internal.forceUIStateReplay = () => {};
  internal.broadcastDegraded = () => {};
  return internal;
}

beforeEach(() => {
  broadcastToAllWindows.mockClear();
});

describe('getDegradedPlugins', () => {
  it('returns [] until bootstrap loadAll completes (no cold-start false positives)', () => {
    const mgr = makeManager();
    mgr.bootstrapComplete = false;
    mgr.discoverPlugins = () => [disc('alpha')];
    mgr.plugins = new Map(); // not yet loaded during cold start
    expect(mgr.getDegradedPlugins()).toEqual([]);
  });

  it('flags a discovered plugin whose instance is entirely gone (post-bootstrap)', () => {
    const mgr = makeManager();
    mgr.discoverPlugins = () => [disc('alpha')];
    mgr.plugins = new Map(); // crashed → dropped
    expect(mgr.getDegradedPlugins()).toEqual(['alpha']);
  });

  it('flags a plugin whose host crashed (tracked in crashedPlugins)', () => {
    const mgr = makeManager();
    mgr.discoverPlugins = () => [disc('alpha')];
    mgr.plugins = new Map([['alpha', { manifest: { name: 'alpha', version: '1.0.0' }, state: 'error' }]]);
    mgr.pluginProcesses = new Map();
    mgr.crashedPlugins = new Set(['alpha']);
    expect(mgr.getDegradedPlugins()).toEqual(['alpha']);
  });

  it('does NOT flag a NON-crash error row (consent/incompat/activation failure)', () => {
    const mgr = makeManager();
    mgr.discoverPlugins = () => [disc('alpha')];
    mgr.plugins = new Map([['alpha', { manifest: { name: 'alpha', version: '1.0.0' }, state: 'error' }]]);
    mgr.pluginProcesses = new Map();
    mgr.crashedPlugins = new Set(); // no crash mark — a restart can't fix this
    expect(mgr.getDegradedPlugins()).toEqual([]);
  });

  it('does NOT flag a plugin mid-transition: loading state', () => {
    const mgr = makeManager();
    mgr.discoverPlugins = () => [disc('alpha')];
    // loadPlugin briefly holds a 'loading' instance before its host registers.
    mgr.plugins = new Map([['alpha', { manifest: { name: 'alpha', version: '1.0.0' }, state: 'loading' }]]);
    mgr.pluginProcesses = new Map();
    mgr.crashedPlugins = new Set();
    expect(mgr.getDegradedPlugins()).toEqual([]);
  });

  it('does NOT flag a plugin mid-transition: active install lock (install/enable/update/unload)', () => {
    const mgr = makeManager();
    mgr.discoverPlugins = () => [disc('alpha')];
    mgr.plugins = new Map(); // unload transiently removed the instance
    mgr.pluginProcesses = new Map();
    mgr.crashedPlugins = new Set();
    mgr.installLocks = new Map([['alpha', Promise.resolve()]]);
    expect(mgr.getDegradedPlugins()).toEqual([]);
  });

  it('STILL flags a crash-marked plugin even mid-transition (crash mark is authoritative)', () => {
    const mgr = makeManager();
    mgr.discoverPlugins = () => [disc('alpha')];
    mgr.plugins = new Map([['alpha', { manifest: { name: 'alpha', version: '1.0.0' }, state: 'loading' }]]);
    mgr.pluginProcesses = new Map();
    mgr.crashedPlugins = new Set(['alpha']);
    mgr.installLocks = new Map([['alpha', Promise.resolve()]]);
    expect(mgr.getDegradedPlugins()).toEqual(['alpha']);
  });

  it('flags an active instance whose backing process host vanished', () => {
    const mgr = makeManager();
    mgr.discoverPlugins = () => [disc('alpha')];
    mgr.plugins = new Map([['alpha', { manifest: { name: 'alpha', version: '1.0.0' }, state: 'active' }]]);
    mgr.pluginProcesses = new Map(); // host died
    expect(mgr.getDegradedPlugins()).toEqual(['alpha']);
  });

  it('does NOT flag a healthy active plugin with a live host', () => {
    const mgr = makeManager();
    mgr.discoverPlugins = () => [disc('alpha')];
    mgr.plugins = new Map([['alpha', { manifest: { name: 'alpha', version: '1.0.0' }, state: 'active' }]]);
    mgr.pluginProcesses = new Map([['alpha', {}]]);
    expect(mgr.getDegradedPlugins()).toEqual([]);
  });

  it('does NOT flag an intentionally disabled plugin', () => {
    const mgr = makeManager();
    mgr.discoverPlugins = () => [disc('alpha')];
    mgr.getPersistentlyDisabled = () => new Set(['alpha']);
    mgr.plugins = new Map();
    mgr.pluginProcesses = new Map();
    mgr.crashedPlugins = new Set(['alpha']); // even a crash mark is moot once disabled
    expect(mgr.getDegradedPlugins()).toEqual([]);
  });

  it('returns none when discovery throws AND nothing is crash-marked', () => {
    const mgr = makeManager();
    mgr.discoverPlugins = () => {
      throw new Error('EIO');
    };
    expect(mgr.getDegradedPlugins()).toEqual([]);
  });

  it('PRESERVES crash marks when discovery throws (transient EIO must not clear the banner)', () => {
    const mgr = makeManager();
    mgr.crashedPlugins = new Set(['msgraph']);
    mgr.discoverPlugins = () => {
      throw new Error('EMFILE');
    };
    expect(mgr.getDegradedPlugins()).toEqual(['msgraph']);
  });

  it('PRESERVES a crash mark omitted from a partial/lenient discovery list', () => {
    const mgr = makeManager();
    mgr.crashedPlugins = new Set(['gone']);
    // Lenient discovery returned a partial list that omits the crashed plugin.
    mgr.discoverPlugins = () => [disc('other')];
    mgr.plugins = new Map([['other', { manifest: { name: 'other', version: '1.0.0' }, state: 'active' }]]);
    mgr.pluginProcesses = new Map([['other', {}]]);
    expect(mgr.getDegradedPlugins()).toEqual(['gone']);
  });

  it('does NOT resurrect a crash mark for a plugin the user disabled (discovery throw)', () => {
    const mgr = makeManager();
    mgr.crashedPlugins = new Set(['off']);
    mgr.getPersistentlyDisabled = () => new Set(['off']);
    mgr.discoverPlugins = () => {
      throw new Error('EIO');
    };
    expect(mgr.getDegradedPlugins()).toEqual([]);
  });
});

describe('reconcileAfterRendererReload', () => {
  it('always re-broadcasts UI state (repopulates a renderer that just lost its snapshot)', async () => {
    const mgr = makeManager();
    const spy = vi.spyOn(mgr, 'forceUIStateReplay');
    await mgr.reconcileAfterRendererReload();
    expect(spy).toHaveBeenCalled();
  });

  it('re-loads a dead host and reports it recovered', async () => {
    const mgr = makeManager();
    mgr.discoverPlugins = () => [disc('alpha')];
    mgr.plugins = new Map(); // gone
    mgr.pluginProcesses = new Map();
    mgr.unloadPlugin = vi.fn(async () => {});
    mgr.loadPlugin = vi.fn(async (_m, _d) => {
      // Simulate a successful reload: live instance + host.
      mgr.plugins.set('alpha', { manifest: { name: 'alpha', version: '1.0.0' }, state: 'active' });
      mgr.pluginProcesses.set('alpha', {});
    });

    const result = await mgr.reconcileAfterRendererReload();
    expect(mgr.loadPlugin).toHaveBeenCalledTimes(1);
    expect(result.recovered).toEqual(['alpha']);
    expect(result.failed).toEqual([]);
    expect(result.stillDegraded).toEqual([]);
  });

  it('republishes tool + CLI-tool registries after a successful recovery (R11/P2)', async () => {
    const mgr = makeManager();
    mgr.discoverPlugins = () => [disc('alpha')];
    mgr.plugins = new Map();
    mgr.pluginProcesses = new Map();
    mgr.crashedPlugins = new Set(['alpha']);
    mgr.unloadPlugin = vi.fn(async () => {});
    mgr.loadPlugin = vi.fn(async () => {
      mgr.plugins.set('alpha', { manifest: { name: 'alpha', version: '1.0.0' }, state: 'active' });
      mgr.pluginProcesses.set('alpha', {});
      mgr.crashedPlugins.delete('alpha');
    });
    const toolsSpy = vi.spyOn(mgr, 'notifyToolsChanged');
    const cliSpy = vi.spyOn(mgr, 'notifyCliToolsChanged');

    const result = await mgr.reconcileAfterRendererReload();
    expect(result.recovered).toEqual(['alpha']);
    expect(toolsSpy).toHaveBeenCalled();
    expect(cliSpy).toHaveBeenCalled();
  });

  it('clears crash state when a crash-marked plugin is confirmed removed from disk (R11/P2)', async () => {
    const mgr = makeManager();
    // Discovery SUCCEEDS but the plugin is absent → genuinely uninstalled.
    mgr.discoverPlugins = () => [];
    mgr.crashedPlugins = new Set(['gone']);
    mgr.plugins = new Map();
    mgr.pluginProcesses = new Map();
    mgr.loadPlugin = vi.fn(async () => {});
    mgr.unloadPlugin = vi.fn(async () => {});

    // Degraded via the omitted-crash-mark path (R10) before reconcile.
    expect(mgr.getDegradedPlugins()).toEqual(['gone']);
    const result = await mgr.reconcileAfterRendererReload();
    expect(mgr.loadPlugin).not.toHaveBeenCalled();
    expect(result.stillDegraded).toEqual([]);
    // Crash state cleared → banner clears, no perpetual revisiting.
    expect(mgr.getDegradedPlugins()).toEqual([]);
    expect(mgr.crashedPlugins.has('gone')).toBe(false);
  });

  it('does NOT clear crash state when the in-lock discovery fails transiently (R12/P2)', async () => {
    const mgr = makeManager();
    mgr.crashedPlugins = new Set(['flaky']);
    mgr.plugins = new Map();
    mgr.pluginProcesses = new Map();
    mgr.loadPlugin = vi.fn(async () => {});
    mgr.unloadPlugin = vi.fn(async () => {});
    // Outer getDegradedPlugins() lenient discovery: partial list omits flaky → it's
    // still reported via the appended-crash-mark path. The in-lock recheck passes
    // throwOnReadError:true → throws (transient) → mark must be PRESERVED, not cleared.
    mgr.discoverPlugins = (opts?: { throwOnReadError?: boolean }) => {
      if (opts?.throwOnReadError) throw new Error('EIO');
      return [];
    };

    expect(mgr.getDegradedPlugins()).toEqual(['flaky']);
    const result = await mgr.reconcileAfterRendererReload();
    expect(mgr.loadPlugin).not.toHaveBeenCalled();
    expect(result.stillDegraded).toEqual([]); // skipped, not reloaded
    // Crash mark preserved so the banner survives until discovery recovers.
    expect(mgr.crashedPlugins.has('flaky')).toBe(true);
    expect(mgr.getDegradedPlugins()).toEqual(['flaky']);
  });

  it('PRESERVES the startup discovery-incomplete latch across a reconcile probe (R13/P1)', async () => {
    const mgr = makeManager();
    // Startup loadAll left the install-blocking safety latch set (plugin A transient).
    mgr.lastDiscoveryIncomplete = true;
    mgr.crashedPlugins = new Set(['b']);
    mgr.plugins = new Map();
    mgr.pluginProcesses = new Map();
    mgr.discoverPlugins = (opts?: { throwOnReadError?: boolean }) => {
      // The strict probe resets the latch internally; the test asserts it's restored.
      if (opts?.throwOnReadError) mgr.lastDiscoveryIncomplete = false;
      return [disc('b')];
    };
    mgr.unloadPlugin = vi.fn(async () => {});
    mgr.loadPlugin = vi.fn(async () => {
      mgr.plugins.set('b', { manifest: { name: 'b', version: '1.0.0' }, state: 'active' });
      mgr.pluginProcesses.set('b', {});
      mgr.crashedPlugins.delete('b');
    });

    await mgr.reconcileAfterRendererReload();
    // The reconcile rescan must NOT clobber the startup latch.
    expect(mgr.lastDiscoveryIncomplete).toBe(true);
  });

  it('skips (and does not burn a retry on) a plugin disabled while reconcile waits (R13/P2)', async () => {
    const mgr = makeManager();
    mgr.discoverPlugins = () => [disc('alpha')];
    mgr.crashedPlugins = new Set(['alpha']);
    mgr.plugins = new Map();
    mgr.pluginProcesses = new Map();
    // Not disabled at the OUTER snapshot (so alpha is degraded and enters the loop),
    // then the user disables it before the lock is acquired for the in-lock recheck.
    let disabled = false;
    mgr.getPersistentlyDisabled = () => (disabled ? new Set(['alpha']) : new Set());
    mgr.assertNotFrozen = () => {
      disabled = true; // simulate the concurrent disable committing during the wait
    };
    mgr.loadPlugin = vi.fn(async () => {});
    mgr.unloadPlugin = vi.fn(async () => {});

    expect(mgr.getDegradedPlugins()).toEqual(['alpha']); // degraded at outer snapshot
    const result = await mgr.reconcileAfterRendererReload();
    expect(mgr.loadPlugin).not.toHaveBeenCalled();
    expect(result.recovered).toEqual([]);
    expect(mgr.crashRecoveryAttempts.get('alpha') ?? 0).toBe(0); // retry not burned
    expect(mgr.crashedPlugins.has('alpha')).toBe(false); // recovery state reset
  });

  it('reports a plugin that fails to reload as failed, not recovered, and KEEPS it crash-marked', async () => {
    const mgr = makeManager();
    mgr.discoverPlugins = () => [disc('alpha')];
    mgr.plugins = new Map();
    mgr.pluginProcesses = new Map();
    mgr.crashedPlugins = new Set(['alpha']);
    mgr.unloadPlugin = vi.fn(async () => {
      mgr.crashedPlugins.delete('alpha'); // unloadPlugin clears the marker...
    });
    mgr.loadPlugin = vi.fn(async () => {
      throw new Error('activation failed');
    });

    const result = await mgr.reconcileAfterRendererReload();
    expect(result.failed).toEqual(['alpha']);
    expect(result.recovered).toEqual([]);
    // ...but a failed recovery must RE-MARK it so the banner persists + it retries.
    expect(mgr.getDegradedPlugins()).toEqual(['alpha']);
  });

  it('re-marks a plugin that reloads into an unmarked error row (loadPlugin swallowed the failure)', async () => {
    const mgr = makeManager();
    mgr.discoverPlugins = () => [disc('alpha')];
    mgr.plugins = new Map();
    mgr.pluginProcesses = new Map();
    mgr.crashedPlugins = new Set(['alpha']);
    mgr.unloadPlugin = vi.fn(async () => {
      mgr.crashedPlugins.delete('alpha');
    });
    // loadPlugin does NOT throw but leaves an unmarked error row (no live host).
    mgr.loadPlugin = vi.fn(async () => {
      mgr.plugins.set('alpha', { manifest: { name: 'alpha', version: '1.0.0' }, state: 'error' });
    });

    const result = await mgr.reconcileAfterRendererReload();
    expect(result.recovered).toEqual([]);
    expect(result.stillDegraded).toEqual(['alpha']);
    // Without re-marking, getDegradedPlugins would exclude this unmarked error row.
    expect(mgr.getDegradedPlugins()).toEqual(['alpha']);
  });

  it('does not force-reload a plugin mid app-update freeze — reports it stillDegraded', async () => {
    const mgr = makeManager();
    mgr.discoverPlugins = () => [disc('alpha')];
    mgr.plugins = new Map();
    mgr.pluginProcesses = new Map();
    mgr.updateFreezeActive = true;
    mgr.loadPlugin = vi.fn(async () => {});

    const result = await mgr.reconcileAfterRendererReload();
    expect(mgr.loadPlugin).not.toHaveBeenCalled();
    expect(result.stillDegraded).toEqual(['alpha']);
  });

  it('leaves healthy and disabled plugins untouched', async () => {
    const mgr = makeManager();
    mgr.discoverPlugins = () => [disc('healthy'), disc('off')];
    mgr.getPersistentlyDisabled = () => new Set(['off']);
    mgr.plugins = new Map([['healthy', { manifest: { name: 'healthy', version: '1.0.0' }, state: 'active' }]]);
    mgr.pluginProcesses = new Map([['healthy', {}]]);
    mgr.loadPlugin = vi.fn(async () => {});
    mgr.unloadPlugin = vi.fn(async () => {});

    const result = await mgr.reconcileAfterRendererReload();
    expect(mgr.loadPlugin).not.toHaveBeenCalled();
    expect(result.recovered).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.stillDegraded).toEqual([]);
  });

  it('is single-flight: a re-entrant call while one is in progress does not double-load', async () => {
    const mgr = makeManager();
    mgr.discoverPlugins = () => [disc('alpha')];
    mgr.plugins = new Map();
    mgr.pluginProcesses = new Map();
    mgr.unloadPlugin = vi.fn(async () => {});
    let resolveLoad: () => void = () => {};
    mgr.loadPlugin = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolveLoad = () => {
            mgr.plugins.set('alpha', { manifest: { name: 'alpha', version: '1.0.0' }, state: 'active' });
            mgr.pluginProcesses.set('alpha', {});
            res();
          };
        }),
    );

    const first = mgr.reconcileAfterRendererReload();
    const second = await mgr.reconcileAfterRendererReload(); // re-entrant, should short-circuit
    expect(second.recovered).toEqual([]); // did not run the load path
    resolveLoad();
    await first;
    expect(mgr.loadPlugin).toHaveBeenCalledTimes(1);
  });

  it('runs a follow-up pass for a plugin that becomes degraded mid-reconcile (R8/P2)', async () => {
    const mgr = makeManager();
    // 'alpha' degraded from the start. 'beta' becomes degraded only after the first
    // pass begins (simulating a crash arriving during an in-flight reconcile). A
    // re-entrant call coalesces and must trigger a follow-up pass that recovers beta.
    let betaCrashed = false;
    mgr.discoverPlugins = () => [disc('alpha'), disc('beta')];
    mgr.plugins = new Map();
    mgr.pluginProcesses = new Map();
    mgr.crashedPlugins = new Set(['alpha']);
    mgr.unloadPlugin = vi.fn(async () => {});
    mgr.loadPlugin = vi.fn(async (m: unknown) => {
      const name = (m as { name: string }).name;
      mgr.plugins.set(name, { manifest: { name, version: '1.0.0' }, state: 'active' });
      mgr.pluginProcesses.set(name, {});
      mgr.crashedPlugins.delete(name);
      if (name === 'alpha' && !betaCrashed) {
        // While recovering alpha (first pass), beta crashes and a reconcile arrives.
        betaCrashed = true;
        mgr.crashedPlugins.add('beta');
        await mgr.reconcileAfterRendererReload(); // coalesced → requests a rerun
      }
    });

    const result = await mgr.reconcileAfterRendererReload();
    // Both recovered: alpha in pass 1, beta in the coalesced follow-up pass.
    expect(result.recovered.sort()).toEqual(['alpha', 'beta']);
    expect(mgr.getDegradedPlugins()).toEqual([]);
  });

  it('reports a plugin by its LATEST pass outcome, not a stale earlier one (R16/P2)', async () => {
    const mgr = makeManager();
    mgr.discoverPlugins = () => [disc('alpha')];
    mgr.plugins = new Map();
    mgr.pluginProcesses = new Map();
    mgr.crashedPlugins = new Set(['alpha']);
    mgr.unloadPlugin = vi.fn(async () => {});
    let firstPass = true;
    mgr.loadPlugin = vi.fn(async () => {
      if (firstPass) {
        firstPass = false;
        // Pass 1: recovers cleanly, then immediately re-crashes and a reconcile arrives.
        mgr.plugins.set('alpha', { manifest: { name: 'alpha', version: '1.0.0' }, state: 'active' });
        mgr.pluginProcesses.set('alpha', {});
        // Re-crash: drop host + re-mark, and coalesce a follow-up pass.
        mgr.pluginProcesses.delete('alpha');
        mgr.crashedPlugins.add('alpha');
        await mgr.reconcileAfterRendererReload();
      } else {
        // Coalesced pass: fails to come back (throws).
        throw new Error('re-crash on reload');
      }
    });

    const result = await mgr.reconcileAfterRendererReload();
    // Even though alpha "recovered" in pass 1, its LATEST outcome is failed — it must
    // NOT be reported as recovered.
    expect(result.recovered).toEqual([]);
    expect(result.failed).toEqual(['alpha']);
    expect(result.stillDegraded).toEqual([]);
  });

  it('clears the crash mark when a crashed plugin is successfully reloaded', async () => {
    const mgr = makeManager();
    mgr.discoverPlugins = () => [disc('alpha')];
    mgr.plugins = new Map([['alpha', { manifest: { name: 'alpha', version: '1.0.0' }, state: 'error' }]]);
    mgr.pluginProcesses = new Map();
    mgr.crashedPlugins = new Set(['alpha']);
    mgr.unloadPlugin = vi.fn(async () => {
      mgr.crashedPlugins.delete('alpha'); // mirrors real unloadPlugin
    });
    mgr.loadPlugin = vi.fn(async () => {
      mgr.plugins.set('alpha', { manifest: { name: 'alpha', version: '1.0.0' }, state: 'active' });
      mgr.pluginProcesses.set('alpha', {});
      mgr.crashedPlugins.delete('alpha'); // mirrors real successful activation
    });

    expect(mgr.getDegradedPlugins()).toEqual(['alpha']);
    const result = await mgr.reconcileAfterRendererReload();
    expect(result.recovered).toEqual(['alpha']);
    expect(mgr.getDegradedPlugins()).toEqual([]);
  });

  it('does NOT reload a plugin that vanished from disk after the lock (uninstall race)', async () => {
    const mgr = makeManager();
    // Degraded at first check (host gone, crash-marked) but its directory is being
    // removed by a concurrent uninstall — discovery no longer lists it.
    let discoverCalls = 0;
    mgr.discoverPlugins = () => {
      discoverCalls += 1;
      // First call (outer getDegradedPlugins) still sees it; inside the lock it's gone.
      return discoverCalls === 1 ? [disc('alpha')] : [];
    };
    mgr.plugins = new Map();
    mgr.pluginProcesses = new Map();
    mgr.crashedPlugins = new Set(['alpha']);
    mgr.loadPlugin = vi.fn(async () => {});
    mgr.unloadPlugin = vi.fn(async () => {});

    const result = await mgr.reconcileAfterRendererReload();
    // Skipped inside the lock — never reloaded a stale manifest into a ghost row.
    expect(mgr.loadPlugin).not.toHaveBeenCalled();
    expect(result.recovered).toEqual([]);
    expect(result.stillDegraded).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it('does NOT reload a plugin already healthy again by the time the lock is held', async () => {
    const mgr = makeManager();
    let degradedCalls = 0;
    mgr.discoverPlugins = () => [disc('alpha')];
    // First getDegradedPlugins (outer) reports alpha; a concurrent op heals it, so
    // the in-lock re-check no longer lists it.
    const realGetDegraded = mgr.getDegradedPlugins.bind(mgr);
    mgr.getDegradedPlugins = () => {
      degradedCalls += 1;
      if (degradedCalls === 1) return ['alpha'];
      return realGetDegraded();
    };
    mgr.plugins = new Map([['alpha', { manifest: { name: 'alpha', version: '1.0.0' }, state: 'active' }]]);
    mgr.pluginProcesses = new Map([['alpha', {}]]); // healthy now
    mgr.loadPlugin = vi.fn(async () => {});
    mgr.unloadPlugin = vi.fn(async () => {});

    const result = await mgr.reconcileAfterRendererReload();
    expect(mgr.loadPlugin).not.toHaveBeenCalled();
    expect(result.recovered).toEqual([]);
  });

  it('caps automatic retries for a repeat-crashing plugin (stops the reload loop)', async () => {
    const mgr = makeManager();
    mgr.discoverPlugins = () => [disc('flaky')];
    mgr.crashedPlugins = new Set(['flaky']);
    mgr.plugins = new Map();
    mgr.pluginProcesses = new Map();
    mgr.unloadPlugin = vi.fn(async () => {});
    // Simulate activate-then-immediately-recrash: loadPlugin leaves an error row,
    // no live host, and the plugin stays crash-marked (reconcile re-marks it).
    mgr.loadPlugin = vi.fn(async () => {
      mgr.plugins.set('flaky', { manifest: { name: 'flaky', version: '1.0.0' }, state: 'error' });
    });

    // First MAX attempts each try a reload; subsequent reconciles must NOT.
    for (let i = 0; i < 3; i += 1) {
      const r = await mgr.reconcileAfterRendererReload();
      expect(r.stillDegraded).toEqual(['flaky']);
    }
    expect(mgr.loadPlugin).toHaveBeenCalledTimes(3);

    // 4th reconcile: budget exhausted — left degraded, no further reload attempt.
    const capped = await mgr.reconcileAfterRendererReload();
    expect(capped.stillDegraded).toEqual(['flaky']);
    expect(mgr.loadPlugin).toHaveBeenCalledTimes(3); // unchanged
    expect(mgr.getDegradedPlugins()).toEqual(['flaky']); // banner persists
  });

  it('does NOT consume the retry budget on a skipped (raced/healed) attempt', async () => {
    const mgr = makeManager();
    // Degraded at the outer check, but healed by the time the lock is held, so the
    // in-lock recheck returns skipped without a reload. The budget must be untouched.
    let degradedCalls = 0;
    mgr.discoverPlugins = () => [disc('alpha')];
    mgr.crashedPlugins = new Set(['alpha']);
    const realGetDegraded = mgr.getDegradedPlugins.bind(mgr);
    mgr.getDegradedPlugins = () => {
      degradedCalls += 1;
      if (degradedCalls === 1) return ['alpha']; // outer loop sees it degraded
      return realGetDegraded(); // in-lock recheck: healed below → not degraded
    };
    mgr.plugins = new Map([['alpha', { manifest: { name: 'alpha', version: '1.0.0' }, state: 'active' }]]);
    mgr.pluginProcesses = new Map([['alpha', {}]]);
    mgr.crashedPlugins = new Set(); // healed
    mgr.loadPlugin = vi.fn(async () => {});
    mgr.unloadPlugin = vi.fn(async () => {});

    await mgr.reconcileAfterRendererReload();
    expect(mgr.loadPlugin).not.toHaveBeenCalled();
    expect(mgr.crashRecoveryAttempts.get('alpha') ?? 0).toBe(0); // budget untouched
  });
});

describe('loadAll bootstrap-complete gating', () => {
  it('marks bootstrap complete even when a plugin load throws (crash detection survives)', async () => {
    const mgr = makeManager() as ReconcileInternal & { loadAll: () => Promise<void> };
    mgr.bootstrapComplete = false;
    // discoverPlugins throws (e.g. throwOnReadError) — loadAll must still settle.
    mgr.discoverPlugins = () => {
      throw new Error('EIO reading plugins dir');
    };
    await expect(mgr.loadAll()).rejects.toThrow();
    expect(mgr.bootstrapComplete).toBe(true);
  });
});

describe('clearCrashMark (broadcast on degraded-state clear)', () => {
  type ClearInternal = ReconcileInternal & { clearCrashMark: (name: string) => void };

  it('broadcasts degraded when an actual crash mark is cleared', () => {
    const mgr = makeManager() as ClearInternal;
    mgr.crashedPlugins = new Set(['alpha']);
    const spy = vi.spyOn(mgr, 'broadcastDegraded');
    mgr.clearCrashMark('alpha');
    expect(mgr.crashedPlugins.has('alpha')).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('always routes through broadcastDegraded (which self-dedups) so INFERRED clears still notify', () => {
    // No crash mark, but the plugin could be inferred-degraded elsewhere; clearCrashMark
    // must still consult broadcastDegraded (dedup decides whether to emit) rather than
    // gating on the delete result (R16/P2).
    const mgr = makeManager() as ClearInternal;
    mgr.crashedPlugins = new Set();
    const spy = vi.spyOn(mgr, 'broadcastDegraded');
    mgr.clearCrashMark('alpha');
    expect(spy).toHaveBeenCalled();
  });

  it('resetCrashRecovery clears an INSTANCE-LESS crash mark + attempts and broadcasts (R14/P2)', () => {
    // The instance-less uninstall path relies on resetCrashRecovery (not unloadPlugin's
    // clearCrashMark, which early-returns with no instance) to drop the banner.
    const mgr = makeManager() as ReconcileInternal & { resetCrashRecovery: (name: string) => void };
    mgr.plugins = new Map(); // no instance
    mgr.crashedPlugins = new Set(['backendOnly']);
    mgr.crashRecoveryAttempts = new Map([['backendOnly', 2]]);
    const spy = vi.spyOn(mgr, 'broadcastDegraded');
    mgr.resetCrashRecovery('backendOnly');
    expect(mgr.crashedPlugins.has('backendOnly')).toBe(false);
    expect(mgr.crashRecoveryAttempts.has('backendOnly')).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('broadcastDegraded change-detection (R16/P2)', () => {
  beforeEach(() => broadcastToAllWindows.mockClear());

  it('emits only when the degraded set actually changes', () => {
    // Real broadcastDegraded (NOT the makeManager stub) + module-mocked fan-out.
    const mgr = new PluginManager(
      '/tmp/plugins-test',
      '/tmp/app-home-test',
      () => ({}) as never,
      () => {},
      [],
      vi.fn(),
    ) as unknown as ReconcileInternal;
    mgr.bootstrapComplete = true;
    mgr.getPersistentlyDisabled = () => new Set();
    mgr.discoverPlugins = () => [disc('alpha')];
    mgr.plugins = new Map();
    mgr.pluginProcesses = new Map();
    mgr.crashedPlugins = new Set(['alpha']);

    mgr.broadcastDegraded(); // [] → ['alpha']: emits
    mgr.broadcastDegraded(); // unchanged: deduped
    expect(broadcastToAllWindows).toHaveBeenCalledTimes(1);
    expect(broadcastToAllWindows).toHaveBeenCalledWith('plugin:degraded-changed', { plugins: ['alpha'] });

    // Now genuinely healthy: clear the crash mark AND give it a live instance+host
    // (clearing the mark alone would leave it inferred-degraded via the missing
    // instance, so the set wouldn't change).
    mgr.crashedPlugins = new Set();
    mgr.plugins = new Map([['alpha', { manifest: { name: 'alpha', version: '1.0.0' }, state: 'active' }]]);
    mgr.pluginProcesses = new Map([['alpha', {}]]);
    mgr.broadcastDegraded(); // ['alpha'] → []: emits again
    expect(broadcastToAllWindows).toHaveBeenCalledTimes(2);
    expect(broadcastToAllWindows).toHaveBeenLastCalledWith('plugin:degraded-changed', { plugins: [] });
  });
});
