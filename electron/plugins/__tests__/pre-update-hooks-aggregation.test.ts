/**
 * Aggregation semantics of PluginManager.runPreUpdateHooks (R3 P1 fix).
 *
 * The runner must run EVERY active plugin's hooks and collapse them with the
 * precedence: a deliberate block from ANY plugin (even a later one) outranks an
 * earlier plugin's failure; a failure outranks a clean pass. A failure must not
 * short-circuit the loop and skip a later plugin's veto.
 *
 * We construct a PluginManager with harmless deps and inject minimal fake plugin
 * instances into its private `plugins` map — runPreUpdateHooks only reads each
 * instance's `state` and `preUpdateHooks`.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PluginManager } from '../plugin-manager.js';
import type { AppConfig } from '../../config/schema.js';

const HOME = mkdtempSync(join(tmpdir(), 'kai-pm-hooks-'));

function makeManager(): PluginManager {
  return new PluginManager(
    join(HOME, 'plugins'),
    HOME,
    () => ({}) as AppConfig,
    () => {},
    [],
    () => {},
  );
}

type FakeHook = (args: unknown) => unknown;
type PostArgs = { version: string; success: boolean; signal: AbortSignal };

/** Inject a fake active plugin exposing the given pre-update (and optional post-update) hooks. */
function addPlugin(mgr: PluginManager, name: string, hooks: FakeHook[], postHooks: FakeHook[] = []): void {
  // The private `plugins` map is keyed by name; the runner reads `state`,
  // `preUpdateHooks`, `postUpdateHooks`, and `manifest.name` off each value.
  const map = (mgr as unknown as { plugins: Map<string, unknown> }).plugins;
  map.set(name, { state: 'active', manifest: { name }, preUpdateHooks: hooks, postUpdateHooks: postHooks });
}

function addPostPlugin(mgr: PluginManager, name: string, postHooks: FakeHook[]): void {
  const map = (mgr as unknown as { plugins: Map<string, unknown> }).plugins;
  map.set(name, { state: 'active', manifest: { name }, preUpdateHooks: [], postUpdateHooks: postHooks });
}

const args = { version: '2.0.0', artifactPath: '/tmp/x.zip' };

describe('PluginManager.runPreUpdateHooks — aggregation & precedence', () => {
  let mgr: PluginManager;
  beforeEach(() => {
    mgr = makeManager();
  });
  afterEach(() => {
    // Cancel any pending debounced UI-state broadcast (50ms) so it can't fire AFTER a
    // test completes and dereference a partial fixture — this was an uncaught async
    // exception that could fail CI (R45P1). Fixtures also carry a manifest now, but
    // cancelling the timer is the robust belt-and-suspenders.
    const timer = (mgr as unknown as { uiStateBroadcastTimer: ReturnType<typeof setTimeout> | null })
      .uiStateBroadcastTimer;
    if (timer) {
      clearTimeout(timer);
      (mgr as unknown as { uiStateBroadcastTimer: ReturnType<typeof setTimeout> | null }).uiStateBroadcastTimer = null;
    }
  });

  it('all clean → proceed', async () => {
    addPlugin(mgr, 'a', [() => ({})]);
    addPlugin(mgr, 'b', [() => ({})]);
    const out = await mgr.runPreUpdateHooks(args);
    expect(out.decision).toBe('proceed');
    expect(typeof out.rollback).toBe('function');
    expect(out.participantNames).toEqual(['a', 'b']); // both participated (R33P1)
  });

  it('runPostUpdateHooks(excludeNames) skips the excluded plugins (R33P1)', async () => {
    let aRan = false;
    let bRan = false;
    addPostPlugin(mgr, 'a', [
      () => {
        aRan = true;
      },
    ]);
    addPostPlugin(mgr, 'b', [
      () => {
        bRan = true;
      },
    ]);
    await mgr.runPostUpdateHooks({ version: '2.0.0', success: false }, { excludeNames: ['a'] });
    expect(aRan).toBe(false); // excluded
    expect(bRan).toBe(true); // notified
  });

  it('runPostUpdateHooks(onlyNames) runs ONLY the named plugins + reports which succeeded (R35P1)', async () => {
    let aRan = false;
    let bRan = false;
    addPostPlugin(mgr, 'a', [
      () => {
        aRan = true;
      },
    ]);
    addPostPlugin(mgr, 'b', [
      () => {
        bRan = true;
      },
    ]);
    const res = await mgr.runPostUpdateHooks({ version: '2.0.0', success: true }, { onlyNames: ['b'] });
    expect(aRan).toBe(false); // not in onlyNames
    expect(bRan).toBe(true); // run
    expect(res.allSucceeded).toBe(true);
    expect(res.succeededNames).toEqual(['b']);
  });

  it('getPostUpdatePluginNames lists every active plugin with a post-update hook (R35P1)', () => {
    addPlugin(mgr, 'participant', [() => ({})], [() => {}]); // pre + post hook
    addPostPlugin(mgr, 'postOnly', [() => {}]); // post-only
    addPlugin(mgr, 'preOnly', [() => ({})]); // pre-only, NO post hook
    const map = (mgr as unknown as { plugins: Map<string, unknown> }).plugins;
    map.set('inactive', {
      state: 'loading',
      manifest: { name: 'inactive' },
      preUpdateHooks: [],
      postUpdateHooks: [() => {}],
    });
    const names = mgr.getPostUpdatePluginNames().sort();
    expect(names).toEqual(['participant', 'postOnly']); // preOnly excluded (no post hook), inactive excluded (not active)
  });

  it('getSetupCapablePluginNames lists every active plugin with a PRE-update hook (R6P1)', () => {
    addPlugin(mgr, 'both', [() => ({})], [() => {}]); // pre + post → setup-capable
    addPostPlugin(mgr, 'postOnly', [() => {}]); // post-only, NO pre hook → NOT setup-capable
    addPlugin(mgr, 'preOnly', [() => ({})]); // pre-only → setup-capable (may register cleanup during the hook)
    const map = (mgr as unknown as { plugins: Map<string, unknown> }).plugins;
    map.set('inactive', {
      state: 'loading',
      manifest: { name: 'inactive' },
      preUpdateHooks: [() => ({})],
      postUpdateHooks: [],
    });
    expect(mgr.getSetupCapablePluginNames().sort()).toEqual(['both', 'preOnly']); // postOnly + inactive excluded
  });

  it('isUpdateDeferred honors named deferral and deferAll (R5P2)', () => {
    expect(mgr.isUpdateDeferred('x')).toBe(false);
    mgr.setDeferredUpdateNames(['x']);
    expect(mgr.isUpdateDeferred('x')).toBe(true);
    expect(mgr.isUpdateDeferred('y')).toBe(false);
    mgr.setDeferredUpdateNames([], { all: true });
    expect(mgr.isUpdateDeferred('y')).toBe(true); // all → any name deferred
    mgr.clearDeferredUpdateNames();
    expect(mgr.isUpdateDeferred('x')).toBe(false);
  });

  it('deferUpdates / addDeferredUpdateNames MERGE without disturbing existing deferral (R7)', () => {
    mgr.setDeferredUpdateNames(['a']);
    mgr.deferUpdates(['b', 'c']); // alias used by the auto-updater
    expect(mgr.isUpdateDeferred('a')).toBe(true);
    expect(mgr.isUpdateDeferred('b')).toBe(true);
    expect(mgr.isUpdateDeferred('c')).toBe(true);
    mgr.addDeferredUpdateNames(['d']);
    expect(mgr.isUpdateDeferred('d')).toBe(true);
    expect(mgr.isUpdateDeferred('a')).toBe(true); // original still deferred
    mgr.clearDeferredUpdateNames();
  });

  it('beginUpdateFreeze defers EVERY plugin; endUpdateFreeze RESTORES the prior state (R28P1)', async () => {
    // Start with a specific plugin deferred (e.g. a prior rollback's retained debt).
    mgr.setDeferredUpdateNames(['owed']);
    expect(mgr.isUpdateDeferred('owed')).toBe(true);
    expect(mgr.isUpdateDeferred('unrelated')).toBe(false);

    // Freeze → everything deferred (blocks any generation swap during the install).
    await mgr.beginUpdateFreeze();
    expect(mgr.isUpdateDeferred('owed')).toBe(true);
    expect(mgr.isUpdateDeferred('unrelated')).toBe(true);

    // End → back to exactly the pre-freeze deferral (only 'owed').
    mgr.endUpdateFreeze();
    expect(mgr.isUpdateDeferred('owed')).toBe(true);
    expect(mgr.isUpdateDeferred('unrelated')).toBe(false);
    mgr.clearDeferredUpdateNames();
  });

  it('freezePluginUpdates/unfreezePluginUpdates are the runner aliases and are idempotent (R28P1)', async () => {
    await mgr.freezePluginUpdates();
    // A second begin without an end keeps the ORIGINAL (empty) snapshot, so a later
    // single end fully restores — no leaked deferAll.
    await mgr.freezePluginUpdates();
    expect(mgr.isUpdateDeferred('anything')).toBe(true);
    mgr.unfreezePluginUpdates();
    expect(mgr.isUpdateDeferred('anything')).toBe(false);
    // A redundant end is a no-op.
    mgr.unfreezePluginUpdates();
    expect(mgr.isUpdateDeferred('anything')).toBe(false);
  });

  it('endUpdateFreeze then deferUpdates LAYERS retained debt on top of the restored snapshot (R28P1)', async () => {
    // Models the revert()/teardown ordering: unfreeze restores the pre-freeze
    // deferral, then retained debt is re-added on top (not clobbered).
    mgr.setDeferredUpdateNames(['pre']);
    await mgr.beginUpdateFreeze();
    expect(mgr.isUpdateDeferred('retained')).toBe(true); // frozen → all deferred
    mgr.endUpdateFreeze(); // restores {pre}
    mgr.deferUpdates(['retained']); // layered on top
    expect(mgr.isUpdateDeferred('pre')).toBe(true);
    expect(mgr.isUpdateDeferred('retained')).toBe(true);
    expect(mgr.isUpdateDeferred('other')).toBe(false); // not everything anymore
    mgr.clearDeferredUpdateNames();
  });

  it('a plugin lifecycle op is REFUSED while an update freeze is active (R28P1)', async () => {
    await mgr.beginUpdateFreeze();
    await expect(mgr.disablePlugin('anything', { persist: false })).rejects.toThrow(/finishing a previous update/i);
    await expect(mgr.uninstallFromMarketplace('anything')).rejects.toThrow(/finishing a previous update/i);
    await expect(mgr.killPlugin('anything')).rejects.toThrow(/finishing a previous update/i);
    mgr.endUpdateFreeze();
  });

  it('enablePlugin is REFUSED while an update freeze is active (R28P12)', async () => {
    // Make it look disabled so enable would otherwise proceed.
    (mgr as unknown as { sessionDisabled: Set<string> }).sessionDisabled.add('toggle');
    const map = (mgr as unknown as { plugins: Map<string, unknown> }).plugins;
    map.set('toggle', { state: 'disabled', manifest: { name: 'toggle' }, preUpdateHooks: [], postUpdateHooks: [] });
    await mgr.beginUpdateFreeze();
    await expect(mgr.enablePlugin('toggle')).rejects.toThrow(/finishing a previous update/i);
    mgr.endUpdateFreeze();
    (mgr as unknown as { sessionDisabled: Set<string> }).sessionDisabled.delete('toggle');
  });

  it('enablePlugin is NOT refused merely because the plugin is DEFERRED (owes cleanup) — no active freeze (R43P2)', async () => {
    // A plugin disabled while it still owed post-update cleanup returns as a disabled
    // stub; enabling is the ONLY in-app path to load it + run that owed hook, so a
    // DEFERRAL (not a freeze) must NOT block enable — else its cleanup is discarded at
    // the give-up cap (the same deadlock R28P46 fixed for consent).
    (mgr as unknown as { sessionDisabled: Set<string> }).sessionDisabled.add('deferred-toggle');
    const map = (mgr as unknown as { plugins: Map<string, unknown> }).plugins;
    map.set('deferred-toggle', {
      state: 'disabled',
      manifest: { name: 'deferred-toggle' },
      preUpdateHooks: [],
      postUpdateHooks: [],
    });
    // Deferred (owes cleanup) but NO active freeze.
    mgr.setDeferredUpdateNames(['deferred-toggle']);
    // The freeze gate must NOT reject it. (It will still reject later because the
    // plugin isn't on disk — assert specifically that it's NOT the freeze/deferral
    // refusal.)
    await expect(mgr.enablePlugin('deferred-toggle')).rejects.not.toThrow(/finishing a previous update/i);
    mgr.setDeferredUpdateNames([]);
    (mgr as unknown as { sessionDisabled: Set<string> }).sessionDisabled.delete('deferred-toggle');
    map.delete('deferred-toggle');
  });

  it('pausePlugin is REFUSED while an update freeze is active, but resume stays available (R28P37)', async () => {
    const map = (mgr as unknown as { plugins: Map<string, unknown> }).plugins;
    map.set('paused', { state: 'active', manifest: { name: 'paused' }, preUpdateHooks: [], postUpdateHooks: [] });
    await mgr.beginUpdateFreeze();
    // Pause is refused — it would reject a pending hook's callbacks unnoticed.
    await expect(mgr.pausePlugin('paused')).rejects.toThrow(/finishing a previous update/i);
    mgr.endUpdateFreeze();
  });

  it('beginUpdateFreeze DRAINS an already-running lifecycle op before resolving (R28P1)', async () => {
    // Occupy an install lock with an op that resolves only when we let it — models a
    // marketplace update/renderer-replacement already in flight when the freeze starts.
    const locks = (mgr as unknown as { installLocks: Map<string, Promise<unknown>> }).installLocks;
    let release!: () => void;
    const inFlight = new Promise<void>((r) => {
      release = r;
    });
    locks.set('busy', inFlight);

    let freezeResolved = false;
    const freezeP = mgr.beginUpdateFreeze().then(() => {
      freezeResolved = true;
    });
    // deferAllUpdates is set synchronously, but the freeze must NOT resolve while
    // the in-flight op still holds its lock.
    await new Promise((r) => setTimeout(r, 20));
    expect(freezeResolved).toBe(false);
    expect(mgr.isUpdateDeferred('whatever')).toBe(true); // frozen immediately

    // Let the in-flight op finish + remove its lock (as withInstallLock's finally would).
    release();
    await inFlight;
    locks.delete('busy');
    await freezeP;
    expect(freezeResolved).toBe(true);
    mgr.endUpdateFreeze();
  });

  it('beginUpdateFreeze THROWS (bounded) if an in-flight lifecycle op never drains (R28P11)', async () => {
    const locks = (mgr as unknown as { installLocks: Map<string, Promise<unknown>> }).installLocks;
    // A hung op that never resolves — the drain must not wait forever.
    locks.set('hung', new Promise<void>(() => {}));
    try {
      await expect(mgr.beginUpdateFreeze(80)).rejects.toThrow(/drain/i);
      // The snapshot is left in place so the caller can lift the partial freeze.
      expect(mgr.isUpdateDeferred('anything')).toBe(true); // deferAllUpdates was set
    } finally {
      locks.delete('hung');
      mgr.endUpdateFreeze();
    }
  });

  it('disable / uninstall / kill are REFUSED while a plugin owes un-reconciled cleanup (R6P1)', async () => {
    mgr.setDeferredUpdateNames(['deferred']);
    await expect(mgr.disablePlugin('deferred', { persist: false })).rejects.toThrow(/finishing a previous update/i);
    await expect(mgr.uninstallFromMarketplace('deferred')).rejects.toThrow(/finishing a previous update/i);
    await expect(mgr.killPlugin('deferred')).rejects.toThrow(/finishing a previous update/i);
    mgr.clearDeferredUpdateNames();
  });

  it('beginUpdateFreeze REFUSES to engage while a consent-pending update has in-memory rollback (R28P16b/R36P2)', async () => {
    const internal = mgr as unknown as {
      pendingConsent: Map<string, unknown>;
      pendingConsentRollback: Map<string, unknown>;
    };
    // A marketplace UPDATE released its lock and is awaiting a LIVE consent prompt;
    // its rollback (prior generation) lives only in memory — the freeze must not let
    // the app quit and lose it. Refusal requires BOTH the live prompt AND the
    // rollback stash for the same plugin (R36P2).
    internal.pendingConsent.set('p', { manifest: { name: 'p' }, fileHash: 'h' });
    internal.pendingConsentRollback.set('p', { backupDir: '/tmp/backup', attemptedVersion: '2.0.0' });
    await expect(mgr.beginUpdateFreeze()).rejects.toThrow(/awaiting consent/i);
    mgr.endUpdateFreeze(); // lift the partial freeze the caller would apply
    internal.pendingConsent.delete('p');
    internal.pendingConsentRollback.delete('p');
  });

  it('beginUpdateFreeze SUCCEEDS for a consent prompt with NO rollback (startup discovery / first install) (R36P2)', async () => {
    const internal = mgr as unknown as { pendingConsent: Map<string, unknown> };
    // A FIRST-TIME install or startup-discovered required plugin awaits consent but
    // has NO prior generation to preserve (no rollback stash). Blocking the app update
    // for it would force the user to resolve an unrelated prompt before updating Kai,
    // for no safety benefit — the prompt is re-derived from disk after relaunch.
    internal.pendingConsent.set('first-install', { manifest: { name: 'first-install' }, fileHash: 'h' });
    await expect(mgr.beginUpdateFreeze()).resolves.toBeUndefined();
    mgr.endUpdateFreeze();
    internal.pendingConsent.delete('first-install');
  });

  it('beginUpdateFreeze SUCCEEDS despite a disabled-update rollback stash with NO live prompt (R28P27)', async () => {
    const internal = mgr as unknown as { pendingConsentRollback: Map<string, unknown> };
    // A plugin updated WHILE DISABLED has a rollback stash but no consent prompt —
    // it must NOT wedge app updates (there's nothing for the user to resolve).
    internal.pendingConsentRollback.set('disabled-upd', { backupDir: '/tmp/b', attemptedVersion: '2.0.0' });
    await expect(mgr.beginUpdateFreeze()).resolves.toBeUndefined();
    mgr.endUpdateFreeze();
    internal.pendingConsentRollback.delete('disabled-upd');
  });

  it('beginUpdateFreeze SUCCEEDS for a first-time-install consent whose rollback has NO real backup (R49P2)', async () => {
    const internal = mgr as unknown as {
      pendingConsent: Map<string, unknown>;
      pendingConsentRollback: Map<string, unknown>;
    };
    // A FIRST-TIME marketplace install requiring consent creates a rollback entry with
    // backupDir undefined (no prior generation). Both maps have the plugin, but there's
    // nothing recoverable to strand → the freeze must NOT block (R49P2): requiring a
    // real backup avoids forcing the user to resolve an unrelated first-install prompt.
    internal.pendingConsent.set('first-mkt', { manifest: { name: 'first-mkt' }, fileHash: 'h' });
    internal.pendingConsentRollback.set('first-mkt', { attemptedVersion: '1.0.0' }); // no backupDir/prior*
    await expect(mgr.beginUpdateFreeze()).resolves.toBeUndefined();
    mgr.endUpdateFreeze();
    internal.pendingConsent.delete('first-mkt');
    internal.pendingConsentRollback.delete('first-mkt');
  });

  it('denyPlugin (async) with no rollback marks the plugin errored under the lock (R28P17)', async () => {
    const map = (
      mgr as unknown as { plugins: Map<string, { state: string; error?: string; manifest?: { name: string } }> }
    ).plugins;
    const internal = mgr as unknown as { pendingConsent: Map<string, unknown> };
    map.set('p', { state: 'active', manifest: { name: 'p' } });
    internal.pendingConsent.set('p', { manifest: { name: 'p' }, fileHash: 'h' });
    await mgr.denyPlugin('p'); // async, serialized, no rollback stash
    expect(internal.pendingConsent.has('p')).toBe(false);
    expect(map.get('p')?.state).toBe('error');
  });

  it('denyPlugin with a MISMATCHED expectedFileHash is a NO-OP (stale cross-request guard, R28P55)', async () => {
    const internal = mgr as unknown as {
      pendingConsent: Map<string, { manifest: { name: string }; fileHash: string }>;
    };
    const map = (
      mgr as unknown as { plugins: Map<string, { state: string; error?: string; manifest?: { name: string } }> }
    ).plugins;
    map.set('p', { state: 'active', manifest: { name: 'p' } });
    // The LIVE pending request is for hash 'NEW' (a different generation, R2).
    internal.pendingConsent.set('p', { manifest: { name: 'p' }, fileHash: 'NEW' });
    // A client still holding the OLD request 'OLD' denies — must NOT consume R2.
    await mgr.denyPlugin('p', 'OLD');
    expect(internal.pendingConsent.has('p')).toBe(true); // R2 untouched
    expect(map.get('p')?.state).toBe('active'); // not errored
    internal.pendingConsent.delete('p');
  });

  it('approveAndReload with a MISMATCHED expectedFileHash is a NO-OP (stale cross-request guard, R28P55)', async () => {
    const internal = mgr as unknown as {
      pendingConsent: Map<string, { manifest: { name: string; permissions: string[] }; fileHash: string }>;
    };
    internal.pendingConsent.set('p', { manifest: { name: 'p', permissions: [] }, fileHash: 'NEW' });
    await expect(mgr.approveAndReload('p', 'OLD')).resolves.toBe(false);
    expect(internal.pendingConsent.has('p')).toBe(true); // R2 still pending, not approved
    internal.pendingConsent.delete('p');
  });

  it('denyPlugin IGNORES a STALE/duplicate request whose consent was already resolved (R28P53)', async () => {
    const internal = mgr as unknown as { pendingConsent: Map<string, unknown> };
    const map = (
      mgr as unknown as { plugins: Map<string, { state: string; error?: string; manifest?: { name: string } }> }
    ).plugins;
    // The plugin is currently ACTIVE (restored/approved by a prior queued call) and
    // has NO pending consent. A stale duplicate deny must be a NO-OP — it must NOT
    // mark the now-valid plugin as errored (R28P53).
    map.set('valid', { state: 'active', manifest: { name: 'valid' } });
    // pendingConsent does NOT contain 'valid'.
    await expect(mgr.denyPlugin('valid')).resolves.toBeUndefined();
    expect(map.get('valid')?.state).toBe('active'); // untouched — not errored
    expect(internal.pendingConsent.has('valid')).toBe(false);
  });

  it('denyPlugin re-reads the rollback stash INSIDE the lock and takes the rollback branch (R28P20)', async () => {
    const internal = mgr as unknown as {
      pendingConsent: Map<string, unknown>;
      pendingConsentRollback: Map<string, unknown>;
    };
    internal.pendingConsent.set('p', { manifest: { name: 'p' }, fileHash: 'h' });
    // A rollback stash present (backupDir null → clean early-return in resolve, no
    // marketplace deps). The in-lock decision must consume it (rollback branch),
    // NOT leave it stranded via a stale pre-lock snapshot.
    internal.pendingConsentRollback.set('p', { backupDir: null, attemptedVersion: '2.0.0' });
    await mgr.denyPlugin('p');
    expect(internal.pendingConsent.has('p')).toBe(false);
    expect(internal.pendingConsentRollback.has('p')).toBe(false); // stash consumed under the lock
  });

  it('approveAndReload AWAITS its rollback under the lock when the plugin is undiscoverable (R28P43)', async () => {
    const internal = mgr as unknown as {
      pendingConsent: Map<string, unknown>;
      pendingConsentRollback: Map<string, unknown>;
    };
    internal.pendingConsent.set('gone', { manifest: { name: 'gone', permissions: [] }, fileHash: 'h' });
    // backupDir null → resolvePendingConsentRollback early-returns (clears the stash)
    // without marketplace deps. Nothing named 'gone' is discoverable, so approve
    // takes the failure path. If the rollback were DETACHED (void), the stash would
    // still be present when approve returns; awaiting it means it's consumed.
    internal.pendingConsentRollback.set('gone', { backupDir: null, attemptedVersion: '2.0.0' });
    const ok = await mgr.approveAndReload('gone');
    expect(ok).toBe(false);
    expect(internal.pendingConsentRollback.has('gone')).toBe(false); // rollback ran (awaited) before return
  });

  it('a DEFERRED (owes-cleanup, NOT frozen) plugin can still resolve consent — no deadlock (R28P46)', async () => {
    const internal = mgr as unknown as {
      pendingConsent: Map<string, unknown>;
      pendingConsentRollback: Map<string, unknown>;
    };
    const map = (
      mgr as unknown as { plugins: Map<string, { state: string; error?: string; manifest?: { name: string } }> }
    ).plugins;
    // The plugin OWES cleanup (deferred) but there is NO active app-update freeze.
    mgr.setDeferredUpdateNames(['owes']);
    map.set('owes', { state: 'active', manifest: { name: 'owes' } });
    internal.pendingConsent.set('owes', { manifest: { name: 'owes' }, fileHash: 'h' });
    // deny must NOT be rejected by the deferral (would deadlock: can't load → can't
    // run cleanup → deferral never clears → consent unresolvable).
    await expect(mgr.denyPlugin('owes')).resolves.toBeUndefined();
    expect(internal.pendingConsent.has('owes')).toBe(false); // resolved
    mgr.clearDeferredUpdateNames();
  });

  it('denyPlugin RESOLVES (does not throw) when the rollback fails AFTER consent is consumed (R28P50)', async () => {
    const internal = mgr as unknown as {
      pendingConsent: Map<string, unknown>;
      pendingConsentRollback: Map<string, unknown>;
      resolvePendingConsentRollback: (n: string, a: boolean, e?: string) => Promise<void>;
    };
    internal.pendingConsent.set('p', { manifest: { name: 'p' }, fileHash: 'h' });
    internal.pendingConsentRollback.set('p', { backupDir: '/tmp/b', attemptedVersion: '2.0.0' });
    // Force the rollback to THROW after consent is consumed.
    const spy = vi.spyOn(internal, 'resolvePendingConsentRollback').mockRejectedValue(new Error('rollback blew up'));
    // Must NOT throw — a post-consumption failure is swallowed so the IPC returns
    // success:true and the (now-stale) modal prompt drops (R28P50).
    await expect(mgr.denyPlugin('p')).resolves.toBeUndefined();
    expect(internal.pendingConsent.has('p')).toBe(false); // consent WAS consumed
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    internal.pendingConsentRollback.delete('p');
  });

  it('runPostUpdateHooks does NOT mark an owed plugin done when it has NO post-update hook, and reports incomplete (R35P1/R28P8)', async () => {
    // A plugin owed cleanup that is active but has NOT (re)registered its
    // post-update hook this launch must stay owed — clearing it would drop the
    // debt without any cleanup running, stranding privileged setup.
    addPlugin(mgr, 'hookless', [() => ({})]); // active, but zero post-update hooks
    const res = await mgr.runPostUpdateHooks({ version: '2.0.0', success: true }, { onlyNames: ['hookless'] });
    expect(res.succeededNames).not.toContain('hookless');
    expect(res.attemptedNames).not.toContain('hookless'); // never even attempted
    // R28P8: an OWED plugin we couldn't attempt must count as incomplete, so the
    // reconciler spends a retry (else the give-up cap is never reached and installs
    // stay blocked forever).
    expect(res.allSucceeded).toBe(false);
  });

  it('runPostUpdateHooks reports incomplete when an owed plugin is entirely ABSENT (R28P8)', async () => {
    // Nothing named 'gone' is loaded — it's owed but missing this launch.
    const res = await mgr.runPostUpdateHooks({ version: '2.0.0', success: true }, { onlyNames: ['gone'] });
    expect(res.attemptedNames).toEqual([]);
    expect(res.allSucceeded).toBe(false); // must not silently succeed → would wedge installs
  });

  it('rollback runs cleanup a pre-hook registered BEFORE it THREW (R35P1)', async () => {
    let cleaned = false;
    const map = (mgr as unknown as { plugins: Map<string, unknown> }).plugins;
    const inst: { state: string; manifest: { name: string }; preUpdateHooks: FakeHook[]; postUpdateHooks: FakeHook[] } =
      {
        state: 'active',
        manifest: { name: 'a' },
        preUpdateHooks: [
          () => {
            // Register cleanup, THEN throw — the failure branch must still have
            // captured the registration for rollback.
            inst.postUpdateHooks.push(() => {
              cleaned = true;
            });
            throw new Error('elevation failed after registering cleanup');
          },
        ],
        postUpdateHooks: [], // empty baseline
      };
    map.set('a', inst);
    const out = await mgr.runPreUpdateHooks(args);
    expect(out.decision).toBe('overridable'); // the throw is an overridable failure
    const { failed } = await out.rollback();
    expect(cleaned).toBe(true); // cleanup registered before the throw still ran
    // R28P18: a pre-hook that FAILED is RETAINED as owed even though its captured
    // cleanup ran — the throw happened mid-setup, so state beyond what the cleanup
    // undoes may persist; the debt must survive for a next-launch reconcile.
    expect(failed).toEqual(['a']);
    // It's also surfaced as a failed participant so the updater owes it at commit.
    expect(out.failedParticipantNames).toContain('a');
  });

  it('stillFresh() reflects later changes to the active plugin set (R12P1)', async () => {
    addPlugin(mgr, 'a', [() => ({})]);
    const out = await mgr.runPreUpdateHooks(args);
    expect(out.stillFresh()).toBe(true);
    // A plugin activating after the run makes the captured decision stale.
    const map = (mgr as unknown as { plugins: Map<string, unknown> }).plugins;
    map.set('z', { state: 'active', manifest: { name: 'z' }, preUpdateHooks: [], postUpdateHooks: [] });
    expect(out.stillFresh()).toBe(false);
  });

  it('stillFresh() is false while a plugin is mid-activation (loading) (R17P1)', async () => {
    addPlugin(mgr, 'a', [() => ({})]);
    const out = await mgr.runPreUpdateHooks(args);
    expect(out.stillFresh()).toBe(true);
    // A plugin being enabled sits in 'loading' before it registers its hook.
    const map = (mgr as unknown as { plugins: Map<string, unknown> }).plugins;
    map.set('z', { state: 'loading', manifest: { name: 'z' }, preUpdateHooks: [], postUpdateHooks: [] });
    expect(out.stillFresh()).toBe(false); // must not proceed past an un-evaluated loading plugin
  });

  it('rollback() aborts the signals of hooks that completed cleanly (R12P1)', async () => {
    let seen: AbortSignal | undefined;
    addPlugin(mgr, 'a', [
      (a: unknown) => {
        seen = (a as { signal: AbortSignal }).signal;
        return {}; // completes cleanly — signal not yet aborted
      },
    ]);
    const out = await mgr.runPreUpdateHooks(args);
    expect(seen!.aborted).toBe(false); // still live after a clean completion
    await out.rollback();
    expect(seen!.aborted).toBe(true); // rollback (cancel) aborts it
  });

  it('rollback() reports the FAILED plugin when a cleanup (post-update) hook fails (R29P2/R35P1)', async () => {
    addPlugin(
      mgr,
      'a',
      [() => ({})], // pre-hook participates
      [
        () => {
          throw new Error('cleanup failed'); // post-update hook fails
        },
      ],
    );
    const out = await mgr.runPreUpdateHooks(args);
    // rollback must surface the cleanup failure per-plugin (so the caller re-owes
    // exactly it) rather than silently resolving OR throwing all-or-nothing.
    const { failed } = await out.rollback();
    expect(failed).toEqual(['a']);
  });

  it('rollback() reports no failures when all cleanup hooks succeed', async () => {
    let cleaned = false;
    addPlugin(
      mgr,
      'a',
      [() => ({})],
      [
        () => {
          cleaned = true;
        },
      ],
    );
    const out = await mgr.runPreUpdateHooks(args);
    const { failed } = await out.rollback();
    expect(failed).toEqual([]);
    expect(cleaned).toBe(true);
  });

  it('rollback() fires onPluginDone per participant as its cleanup succeeds (R35P1)', async () => {
    const doneOrder: string[] = [];
    addPlugin(mgr, 'a', [() => ({})], [() => {}]);
    addPlugin(mgr, 'b', [() => ({})], [() => {}]);
    addPlugin(
      mgr,
      'c',
      [() => ({})],
      [
        () => {
          throw new Error('c cleanup failed');
        },
      ],
    );
    const out = await mgr.runPreUpdateHooks(args);
    const { failed } = await out.rollback({ onPluginDone: (n) => void doneOrder.push(n) });
    expect(failed).toEqual(['c']); // c's cleanup failed
    expect(doneOrder).toEqual(['a', 'b']); // a and b fired incrementally, c did NOT
  });

  it('rollback runs the BASELINE cleanup even if a concurrent unload cleared the live hooks (R30P2)', async () => {
    let cleaned = false;
    const map = (mgr as unknown as { plugins: Map<string, unknown> }).plugins;
    const inst: { state: string; manifest: { name: string }; preUpdateHooks: FakeHook[]; postUpdateHooks: FakeHook[] } =
      {
        state: 'active',
        manifest: { name: 'a' },
        preUpdateHooks: [
          () => {
            // Simulate a concurrent unload clearing the live post-hooks right after
            // this pre-hook runs (before the participant snapshot).
            inst.postUpdateHooks = [];
            return {};
          },
        ],
        postUpdateHooks: [
          () => {
            cleaned = true;
          },
        ],
      };
    map.set('a', inst);
    const out = await mgr.runPreUpdateHooks(args);
    await out.rollback();
    expect(cleaned).toBe(true); // baseline cleanup preserved despite the clear
  });

  it('rollback runs a post-hook REGISTERED DURING a pre-hook even if a later await clears the live array (R35P1)', async () => {
    let cleaned = false;
    const map = (mgr as unknown as { plugins: Map<string, unknown> }).plugins;
    const registeredHook: FakeHook = () => {
      cleaned = true;
    };
    const inst: { state: string; manifest: { name: string }; preUpdateHooks: FakeHook[]; postUpdateHooks: FakeHook[] } =
      {
        state: 'active',
        manifest: { name: 'a' },
        preUpdateHooks: [
          // Hook 0 REGISTERS a post-hook (not present at plan time / in the baseline).
          () => {
            inst.postUpdateHooks.push(registeredHook);
            return {};
          },
          // Hook 1 awaits, and during that await a concurrent unload clears the live
          // post-hook array — the registered hook is now in NEITHER baseline NOR live.
          async () => {
            inst.postUpdateHooks = [];
            return {};
          },
        ],
        postUpdateHooks: [], // empty baseline at plan time
      };
    map.set('a', inst);
    const out = await mgr.runPreUpdateHooks(args);
    const { failed } = await out.rollback();
    expect(cleaned).toBe(true); // the mid-run registration was captured synchronously
    expect(failed).toEqual([]);
  });

  it('rollback runs a cleanup registered by a hook that then AWAITS while a concurrent unload reassigns the array (R35P1)', async () => {
    let cleaned = false;
    const map = (mgr as unknown as { plugins: Map<string, unknown> }).plugins;
    const registeredHook: FakeHook = () => {
      cleaned = true;
    };
    const inst: { state: string; manifest: { name: string }; preUpdateHooks: FakeHook[]; postUpdateHooks: FakeHook[] } =
      {
        state: 'active',
        manifest: { name: 'a' },
        preUpdateHooks: [
          // A SINGLE hook: registers cleanup, then awaits; DURING the await a
          // concurrent unload REASSIGNS the live array (postUpdateHooks = []) before
          // the hook resolves. Reading instance.postUpdateHooks after would miss the
          // registration — the runner holds the pre-hook array reference to survive it.
          async () => {
            inst.postUpdateHooks.push(registeredHook);
            await Promise.resolve();
            inst.postUpdateHooks = []; // simulate unload reassigning the array
            return {};
          },
        ],
        postUpdateHooks: [],
      };
    map.set('a', inst);
    const out = await mgr.runPreUpdateHooks(args);
    const { failed } = await out.rollback();
    expect(cleaned).toBe(true); // captured via the held array reference
    expect(failed).toEqual([]);
  });

  it('rollback runs cleanup a THROWING hook registered from its abort listener (R35P1)', async () => {
    let cleaned = false;
    const map = (mgr as unknown as { plugins: Map<string, unknown> }).plugins;
    const inst: { state: string; manifest: { name: string }; preUpdateHooks: FakeHook[]; postUpdateHooks: FakeHook[] } =
      {
        state: 'active',
        manifest: { name: 'a' },
        preUpdateHooks: [
          (a: unknown) => {
            // Register cleanup ONLY when the runner aborts this hook (the runner
            // calls controller.abort() on the throw). The abort listener fires
            // synchronously during .abort(), so the re-merge after abort must
            // capture it — otherwise the thrown hook's cleanup is lost.
            const signal = (a as { signal: AbortSignal }).signal;
            signal.addEventListener('abort', () => {
              inst.postUpdateHooks.push(() => {
                cleaned = true;
              });
            });
            throw new Error('elevation failed');
          },
        ],
        postUpdateHooks: [],
      };
    map.set('a', inst);
    const out = await mgr.runPreUpdateHooks(args);
    expect(out.decision).toBe('overridable'); // a throw is overridable
    const { failed } = await out.rollback();
    expect(cleaned).toBe(true); // abort-listener registration captured by the post-abort re-merge
    expect(failed).toEqual(['a']); // R28P18: a failed pre-hook stays owed even though cleanup ran
  });

  it('a single failure → overridable', async () => {
    addPlugin(mgr, 'a', [
      () => {
        throw new Error('elevation failed');
      },
    ]);
    const out = await mgr.runPreUpdateHooks(args);
    expect(out.decision).toBe('overridable');
  });

  it('rollback re-merges a post-hook registered on the SAME generation AFTER its snapshot (R28P30)', async () => {
    // Plugin 'a' passes its pre-hook cleanly (a participant), then LATER — while a
    // second plugin awaits — registers a post-update hook on its live instance. The
    // participant snapshot taken for 'a' missed it; rollback must re-merge the live
    // hooks (same generation) so the late cleanup still runs.
    let lateCleanupRan = false;
    const map = (mgr as unknown as { plugins: Map<string, unknown> }).plugins;
    const instA = {
      state: 'active',
      manifest: { name: 'a' },
      preUpdateHooks: [() => ({})],
      postUpdateHooks: [] as FakeHook[],
    };
    map.set('a', instA);
    // 'b' fails (overridable) — a non-proceed path that runs rollback. During its
    // pre-hook, 'a' registers a late post-hook on its (still-current) instance.
    addPlugin(mgr, 'b', [
      () => {
        instA.postUpdateHooks.push(() => {
          lateCleanupRan = true;
        });
        throw new Error('b failed');
      },
    ]);
    const out = await mgr.runPreUpdateHooks(args);
    expect(out.decision).toBe('overridable');
    await out.rollback();
    expect(lateCleanupRan).toBe(true); // late same-generation post-hook was re-merged + run
  });

  it('rollback RETAINS a participant whose instance crashed (errored + hooks cleared) as failed (R28P33)', async () => {
    // 'a' participates with a captured post-hook, then its instance CRASHES: same
    // object identity, but state flips to 'error' and postUpdateHooks is cleared.
    // Rollback must NOT trust the now-empty live list as "cleaned" — it retains 'a'
    // as failed so its debt survives.
    const map = (mgr as unknown as { plugins: Map<string, unknown> }).plugins;
    const instA = {
      state: 'active',
      manifest: { name: 'a' },
      preUpdateHooks: [() => ({})],
      postUpdateHooks: [() => {}] as FakeHook[],
    };
    map.set('a', instA);
    addPlugin(mgr, 'b', [
      () => {
        throw new Error('b failed'); // overridable → rollback path
      },
    ]);
    const out = await mgr.runPreUpdateHooks(args);
    expect(out.decision).toBe('overridable');
    // Simulate a crash of 'a' AFTER the snapshot: same instance, but errored + hooks gone.
    instA.state = 'error';
    instA.postUpdateHooks = [];
    const { failed } = await out.rollback();
    expect(failed).toContain('a'); // retained, not falsely cleared (R28P33)
  });

  it('a deliberate {abort:true} → blocked (not overridable)', async () => {
    addPlugin(mgr, 'a', [() => ({ abort: true, abortReason: 'unsaved work' })]);
    const out = await mgr.runPreUpdateHooks(args);
    expect(out).toMatchObject({ decision: 'blocked', reason: 'unsaved work' });
  });

  it('EARLIER failure + LATER deliberate block → blocked (block wins, later hook still ran)', async () => {
    let laterRan = false;
    addPlugin(mgr, 'a', [
      () => {
        throw new Error('boom');
      },
    ]);
    addPlugin(mgr, 'b', [
      () => {
        laterRan = true;
        return { abort: true, abortReason: 'policy veto' };
      },
    ]);
    const out = await mgr.runPreUpdateHooks(args);
    expect(laterRan).toBe(true); // failure did NOT short-circuit the loop
    expect(out).toMatchObject({ decision: 'blocked', reason: 'policy veto' });
  });

  it('EARLIER deliberate block STOPS the scan (later hooks do not run — block is terminal)', async () => {
    let laterRan = false;
    let bRolledBack = false;
    addPlugin(mgr, 'a', [() => ({ abort: true, abortReason: 'veto first' })]);
    addPlugin(
      mgr,
      'b',
      [
        () => {
          laterRan = true;
          throw new Error('later boom');
        },
      ],
      [
        () => {
          bRolledBack = true;
        },
      ],
    );
    const out = await mgr.runPreUpdateHooks(args);
    expect(out).toMatchObject({ decision: 'blocked', reason: 'veto first' });
    expect(laterRan).toBe(false); // stop-on-first-block: no needless later setup/timeouts
    // b never participated → its rollback must NOT fire.
    await out.rollback();
    expect(bRolledBack).toBe(false);
  });

  it('returned {failed:true} (opted-in operational failure, lone hook) → overridable', async () => {
    addPlugin(mgr, 'a', [() => ({ failed: true, abortReason: 'transient' })]);
    const out = await mgr.runPreUpdateHooks(args);
    expect(out).toMatchObject({ decision: 'overridable', reason: 'transient' });
  });

  it('the Privileges shape {abort:true, failed:true, abortReason} is OVERRIDABLE (R35P1)', async () => {
    // The Privileges plugin returns this on an elevation FAILURE so the user can
    // Proceed anyway; a bare {abort:true} (policy veto) would hard-block instead.
    addPlugin(mgr, 'privileges', [() => ({ abort: true, failed: true, abortReason: 'Elevation failed: sudo denied' })]);
    const out = await mgr.runPreUpdateHooks(args);
    expect(out).toMatchObject({ decision: 'overridable', reason: 'Elevation failed: sudo denied' });
  });

  it('returned {failed:true} stops later same-plugin hooks and fails closed if any skipped (R12P2)', async () => {
    let secondRan = false;
    addPlugin(mgr, 'a', [
      () => ({ failed: true, abortReason: 'transient' }),
      () => {
        secondRan = true; // must NOT run
        return {};
      },
    ]);
    const out = await mgr.runPreUpdateHooks(args);
    expect(secondRan).toBe(false);
    expect(out.decision).toBe('blocked'); // a skipped hook could hold a veto → fail closed
  });

  it('rollback() runs ONLY participating plugins’ post-update hooks (success:false)', async () => {
    let aRolled: PostArgs | undefined;
    let cRolled = false;
    addPlugin(
      mgr,
      'a',
      [() => ({})],
      [
        (x: unknown) => {
          aRolled = x as PostArgs;
        },
      ],
    );
    // 'c' has a post-hook but NO pre-hook → never participates → must not roll back.
    addPlugin(
      mgr,
      'c',
      [],
      [
        () => {
          cRolled = true;
        },
      ],
    );
    const out = await mgr.runPreUpdateHooks(args);
    await out.rollback();
    expect(aRolled).toMatchObject({ success: false });
    expect(cRolled).toBe(false);
  });

  it('rollback still fires captured hooks after the plugin is unloaded (hooks cleared)', async () => {
    // R8P2: capture is a SNAPSHOT of the hook functions, so clearing the live
    // instance's postUpdateHooks (what unload/disable does) must not empty the
    // pending rollback.
    let rolled = false;
    addPlugin(
      mgr,
      'a',
      [() => ({})],
      [
        () => {
          rolled = true;
        },
      ],
    );
    const out = await mgr.runPreUpdateHooks(args);
    // Simulate an unload clearing the live instance's hooks mid-flight.
    const inst = (mgr as unknown as { plugins: Map<string, { postUpdateHooks: unknown[] }> }).plugins.get('a')!;
    inst.postUpdateHooks = [];
    await out.rollback();
    expect(rolled).toBe(true); // snapshot preserved the cleanup callback
  });

  it('a self-registering pre-hook does not loop forever AND fails closed (plan snapshot + late-hook guard)', async () => {
    // R8P2: a hook that appends another pre-hook mid-run must NOT extend the loop
    // (the plan is snapshotted). R28P24: and because that late hook was never
    // evaluated (it could hold a veto), the run fails CLOSED at the generation
    // check rather than proceeding past an un-run pre-hook.
    let calls = 0;
    const map = (mgr as unknown as { plugins: Map<string, unknown> }).plugins;
    const preHooks: FakeHook[] = [];
    preHooks.push(() => {
      calls++;
      preHooks.push(() => {
        calls++;
        return {};
      }); // self-register — ignored THIS run, but makes the run non-fresh
      return {};
    });
    map.set('a', { state: 'active', manifest: { name: 'a' }, preUpdateHooks: preHooks, postUpdateHooks: [] });
    const out = await mgr.runPreUpdateHooks(args);
    expect(out.decision).toBe('blocked'); // fail closed — a late pre-hook wasn't evaluated (R28P24)
    expect(calls).toBe(1); // loop still bounded to the originally-present hook
    expect(out.stillFresh()).toBe(false); // the late registration makes it non-fresh
  });

  it('skips a removed plugin AND fails closed when the active set changed mid-run (R10P1/R11P1)', async () => {
    const map = (mgr as unknown as { plugins: Map<string, unknown> }).plugins;
    let bRan = false;
    // 'a' runs first and, mid-hook, removes 'b' from the live map (concurrent
    // unload). 'b' (stale plan entry) must be skipped, AND because the active set
    // changed, the outcome fails closed to 'blocked' (an un-evaluated generation
    // must not be installed past).
    map.set('a', {
      state: 'active',
      manifest: { name: 'a' },
      preUpdateHooks: [
        () => {
          map.delete('b');
          return {};
        },
      ],
      postUpdateHooks: [],
    });
    map.set('b', {
      state: 'active',
      manifest: { name: 'b' },
      preUpdateHooks: [
        () => {
          bRan = true;
          return {};
        },
      ],
      postUpdateHooks: [],
    });
    const out = await mgr.runPreUpdateHooks(args);
    expect(out.decision).toBe('blocked'); // fail-closed on generation change
    expect(bRan).toBe(false); // stale plan entry skipped after revalidation
  });

  it('proceeds when the active plugin set is unchanged through the run', async () => {
    addPlugin(mgr, 'a', [() => ({})]);
    addPlugin(mgr, 'b', [() => ({})]);
    const out = await mgr.runPreUpdateHooks(args);
    expect(out.decision).toBe('proceed');
  });

  it('fails closed when a NEW plugin becomes active during the hook window (R11P1)', async () => {
    const map = (mgr as unknown as { plugins: Map<string, unknown> }).plugins;
    // 'a' registers a brand-new active plugin 'z' mid-hook; z's veto/setup hook
    // was never in the plan, so we must not install past it → blocked.
    map.set('a', {
      state: 'active',
      manifest: { name: 'a' },
      preUpdateHooks: [
        () => {
          map.set('z', { state: 'active', manifest: { name: 'z' }, preUpdateHooks: [], postUpdateHooks: [] });
          return {};
        },
      ],
      postUpdateHooks: [],
    });
    const out = await mgr.runPreUpdateHooks(args);
    expect(out.decision).toBe('blocked');
  });

  it('stops a plugin’s remaining hooks after one fails, but still runs other plugins (R11P1/R12P1)', async () => {
    let aSecondRan = false;
    let bRan = false;
    addPlugin(mgr, 'a', [
      () => {
        throw new Error('first hook failed');
      },
      () => {
        aSecondRan = true; // must NOT run — same plugin, after a failed hook
        return {};
      },
    ]);
    addPlugin(mgr, 'b', [
      () => {
        bRan = true; // MUST run — different plugin (veto aggregation)
        return {};
      },
    ]);
    const out = await mgr.runPreUpdateHooks(args);
    expect(aSecondRan).toBe(false); // a's later hook skipped
    expect(bRan).toBe(true); // b still evaluated for its potential veto
    // Because a SKIPPED hook could have held a veto, the failure is NOT
    // overridable — it fails closed to 'blocked' (R12P1).
    expect(out.decision).toBe('blocked');
  });

  it('a single-hook plugin failure (nothing skipped) stays overridable', async () => {
    addPlugin(mgr, 'a', [
      () => {
        throw new Error('lone hook failed');
      },
    ]);
    const out = await mgr.runPreUpdateHooks(args);
    // No later hook was skipped, so this is the plugin's own overridable error.
    expect(out.decision).toBe('overridable');
  });

  it('generation change OUTRANKS a hook failure → blocked, not overridable (R11P2)', async () => {
    const map = (mgr as unknown as { plugins: Map<string, unknown> }).plugins;
    // 'a' both fails AND registers a new active plugin mid-hook. The failure alone
    // would be overridable, but the generation change must force a non-overridable
    // block so the user can't Proceed past the un-evaluated new generation.
    map.set('a', {
      state: 'active',
      manifest: { name: 'a' },
      preUpdateHooks: [
        () => {
          map.set('z', { state: 'active', manifest: { name: 'z' }, preUpdateHooks: [], postUpdateHooks: [] });
          throw new Error('failed AND changed the generation');
        },
      ],
      postUpdateHooks: [],
    });
    const out = await mgr.runPreUpdateHooks(args);
    expect(out.decision).toBe('blocked');
  });

  it('captures post-hooks registered DURING a pre-hook for rollback (R8P2)', async () => {
    let rolled = false;
    const map = (mgr as unknown as { plugins: Map<string, unknown> }).plugins;
    const postHooks: FakeHook[] = [];
    map.set('a', {
      state: 'active',
      manifest: { name: 'a' },
      preUpdateHooks: [
        () => {
          // Register a post-hook during the pre-hook (a supported scenario).
          postHooks.push(() => {
            rolled = true;
          });
          return {};
        },
      ],
      postUpdateHooks: postHooks,
    });
    const out = await mgr.runPreUpdateHooks(args);
    await out.rollback();
    expect(rolled).toBe(true); // post-hook snapshot taken AFTER the pre-hook ran
  });

  it('inactive plugins are skipped', async () => {
    const map = (mgr as unknown as { plugins: Map<string, unknown> }).plugins;
    map.set('disabled', {
      state: 'disabled',
      manifest: { name: 'disabled' },
      preUpdateHooks: [
        () => {
          throw new Error('should not run');
        },
      ],
    });
    expect((await mgr.runPreUpdateHooks(args)).decision).toBe('proceed');
  });
});

describe('PluginManager.runPreUpdateHooks — per-hook timeout (R4)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const T = PluginManager.PRE_UPDATE_HOOK_TIMEOUT_MS;

  it('a lone hung hook → overridable (bounded, not a permanent hang)', async () => {
    const mgr = makeManager();
    addPlugin(mgr, 'a', [() => new Promise(() => {})]); // never settles
    const p = mgr.runPreUpdateHooks(args);
    await vi.advanceTimersByTimeAsync(T + 1000);
    expect(await p).toEqual(expect.objectContaining({ decision: 'overridable' }));
  });

  it('a TIMED-OUT setup-capable hook stays owed (reported failed) even on clean rollback, but its cleanup STILL RUNS (R6P1/R28P7)', async () => {
    const mgr = makeManager();
    // 'a' has a post-update cleanup hook AND a pre-update hook that hangs → times
    // out. Its cleanup itself succeeds when run, but because the pre-hook is still
    // running (could still apply setup), rollback must report 'a' as failed so its
    // debt is retained — AND it must still ATTEMPT the cleanup (R28P7): skipping it
    // would leave any elevation the timed-out hook already granted active.
    let cleanupRan = false;
    addPlugin(
      mgr,
      'a',
      [() => new Promise(() => {})],
      [
        () => {
          cleanupRan = true;
        },
      ],
    );
    const p = mgr.runPreUpdateHooks(args);
    await vi.advanceTimersByTimeAsync(T + 1000);
    const out = await p;
    expect(out.decision).toBe('overridable');
    const onDone = vi.fn();
    const { failed } = await out.rollback({ onPluginDone: onDone });
    expect(failed).toContain('a'); // retained despite clean post-hook
    expect(cleanupRan).toBe(true); // R28P7: cleanup was attempted, not skipped
    expect(onDone).not.toHaveBeenCalledWith('a'); // never checkpointed done (stays owed)
  });

  it('HUNG earlier hook + LATER deliberate veto → blocked (hang does not discard the veto)', async () => {
    const mgr = makeManager();
    addPlugin(mgr, 'a', [() => new Promise(() => {})]); // hangs → per-hook timeout → failure
    addPlugin(mgr, 'b', [() => ({ abort: true, abortReason: 'veto survives the hang' })]);
    const p = mgr.runPreUpdateHooks(args);
    await vi.advanceTimersByTimeAsync(T + 1000);
    expect(await p).toMatchObject({ decision: 'blocked', reason: 'veto survives the hang' });
  });

  it('passes an AbortSignal to hooks and fires it when a hook times out', async () => {
    const mgr = makeManager();
    let seenSignal: AbortSignal | undefined;
    addPlugin(mgr, 'a', [
      (a: unknown) => {
        seenSignal = (a as { signal: AbortSignal }).signal;
        return new Promise(() => {}); // hang so the per-hook timeout fires
      },
    ]);
    const p = mgr.runPreUpdateHooks(args);
    await vi.advanceTimersByTimeAsync(T + 1000);
    await p;
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal!.aborted).toBe(true);
  });

  it('a hook that OBSERVES the signal and returns is treated normally (no wasted timeout)', async () => {
    const mgr = makeManager();
    addPlugin(mgr, 'a', [(a: unknown) => ({ abort: false, signalSeen: !!(a as { signal?: AbortSignal }).signal })]);
    // A clean, prompt return — no fake-timer advance needed.
    expect((await mgr.runPreUpdateHooks(args)).decision).toBe('proceed');
  });

  it('runPostUpdateHooks (all-active) runs cleanup for every active plugin', async () => {
    vi.useRealTimers();
    const mgr = makeManager();
    let aRan = false;
    let bRan = false;
    addPostPlugin(mgr, 'a', [
      () => {
        aRan = true;
      },
    ]);
    addPostPlugin(mgr, 'b', [
      () => {
        bRan = true;
      },
    ]);
    await mgr.runPostUpdateHooks({ version: '2.0.0', success: true });
    expect(aRan).toBe(true);
    expect(bRan).toBe(true);
  });

  it('runPostUpdateHooks passes an AbortSignal and fires it on timeout', async () => {
    const mgr = makeManager();
    let seen: AbortSignal | undefined;
    addPostPlugin(mgr, 'a', [
      (a: unknown) => {
        seen = (a as { signal: AbortSignal }).signal;
        return new Promise(() => {}); // hang → timeout → abort
      },
    ]);
    const p = mgr.runPostUpdateHooks({ version: '2.0.0', success: false });
    await vi.advanceTimersByTimeAsync(T + 1000);
    await p;
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen!.aborted).toBe(true);
  });

  it('runPostUpdateHooks bounds a hung rollback hook and still runs later ones', async () => {
    const mgr = makeManager();
    let laterRan = false;
    addPostPlugin(mgr, 'a', [() => new Promise(() => {})]); // hangs → bounded, skipped
    addPostPlugin(mgr, 'b', [
      () => {
        laterRan = true;
      },
    ]);
    const p = mgr.runPostUpdateHooks({ version: '2.0.0', success: false });
    await vi.advanceTimersByTimeAsync(T + 1000);
    // Resolves (never rejects); allSucceeded=false because the hung hook didn't
    // succeed, and 'a' is NOT in succeededNames while the later 'b' is.
    const res = await p;
    expect(res.allSucceeded).toBe(false);
    expect(res.succeededNames).toEqual(['b']);
    expect(laterRan).toBe(true); // a hung rollback hook does not starve later cleanup
  });

  it('a dead-process rejection is a clear warning, not an opaque error, and does not reject', async () => {
    vi.useRealTimers();
    const mgr = makeManager();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    addPostPlugin(mgr, 'a', [
      () => {
        throw new Error('Plugin process is not running');
      },
    ]);
    // Resolves (never rejects); allSucceeded=false because the process-gone hook
    // didn't actually run cleanup, and it is NOT in succeededNames.
    const res = await mgr.runPostUpdateHooks({ version: '2.0.0', success: false });
    expect(res.allSucceeded).toBe(false);
    expect(res.succeededNames).not.toContain('a');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('process is gone'));
    expect(err).not.toHaveBeenCalled(); // classified as the known teardown case, not an error
    warn.mockRestore();
    err.mockRestore();
  });

  it('runPostUpdateHooks snapshots the plan (self-registering post-hook does not loop forever)', async () => {
    vi.useRealTimers();
    const mgr = makeManager();
    let calls = 0;
    const map = (mgr as unknown as { plugins: Map<string, unknown> }).plugins;
    const postHooks: FakeHook[] = [];
    postHooks.push(() => {
      calls++;
      postHooks.push(() => {
        calls++;
      }); // self-register — must be ignored this run
    });
    map.set('a', { state: 'active', manifest: { name: 'a' }, preUpdateHooks: [], postUpdateHooks: postHooks });
    await mgr.runPostUpdateHooks({ version: '2.0.0', success: true });
    expect(calls).toBe(1); // only the originally-present post-hook ran
  });
});

describe('isRequiredPluginIntegrityTrusted — deferred (owed) generation (R28P6)', () => {
  type IntegrityMgr = {
    isRequiredPluginIntegrityTrusted: (
      m: { name: string; version: string; permissions: string[] },
      h: string,
    ) => boolean;
    getConfig: () => AppConfig;
    marketplaceService: unknown;
    setDeferredUpdateNames: (n: string[], o?: { all?: boolean }) => void;
    beginUpdateFreeze: () => Promise<void>;
    endUpdateFreeze: () => void;
  };

  function makeIntegrityManager(
    installed: Record<string, unknown>,
    cachedCatalog: unknown[],
    approvals?: Record<string, unknown>,
  ): IntegrityMgr {
    const cfg = {
      marketplace: { installedPlugins: installed },
      ...(approvals ? { pluginApprovals: approvals } : {}),
    } as unknown as AppConfig;
    const mgr = new PluginManager(
      join(HOME, 'plugins'),
      HOME,
      () => cfg,
      () => {},
      ['req'],
      () => {},
    ) as unknown as IntegrityMgr;
    // Stub a marketplace service exposing the NEWER catalog.
    mgr.marketplaceService = { getCachedCatalog: () => cachedCatalog };
    return mgr;
  }

  const AUTHENTICATED_BROWSER = 'browser:authenticated-session';

  const OLD = { version: '1.0.0', fileHash: 'hashOLD', permissions: ['read'] };

  it('REJECTS the old generation vs a newer catalog when NOT deferred', () => {
    const mgr = makeIntegrityManager(
      { req: OLD }, // persisted record still reflects the OLD (installed) generation
      [{ name: 'req', version: '2.0.0', fileHash: 'hashNEW' }], // catalog moved on
    );
    // Not deferred → the newer-catalog comparison rejects the stale generation.
    expect(
      mgr.isRequiredPluginIntegrityTrusted({ name: 'req', version: '1.0.0', permissions: ['read'] }, 'hashOLD'),
    ).toBe(false);
  });

  it('TRUSTS the old generation against its persisted record while DEFERRED, ignoring the newer catalog (R28P6)', () => {
    const mgr = makeIntegrityManager({ req: OLD }, [{ name: 'req', version: '2.0.0', fileHash: 'hashNEW' }]);
    mgr.setDeferredUpdateNames(['req']); // owes post-update cleanup → bootstrap kept OLD gen
    // Deferred → trust the persisted approval for the OLD gen, skip the newer-source check.
    expect(
      mgr.isRequiredPluginIntegrityTrusted({ name: 'req', version: '1.0.0', permissions: ['read'] }, 'hashOLD'),
    ).toBe(true);
    mgr.setDeferredUpdateNames([]);
  });

  it('still REJECTS a deferred plugin whose on-disk hash does NOT match its persisted record', () => {
    const mgr = makeIntegrityManager({ req: OLD }, []);
    mgr.setDeferredUpdateNames(['req']);
    // Tampered/mismatched hash must fail even when deferred — we only skip the
    // newer-source comparison, never the persisted-record integrity check.
    expect(
      mgr.isRequiredPluginIntegrityTrusted({ name: 'req', version: '1.0.0', permissions: ['read'] }, 'TAMPERED'),
    ).toBe(false);
    mgr.setDeferredUpdateNames([]);
  });

  // No-marketplace (bundled) brand: approval lives in `pluginApprovals`
  // (hash + permissions), NOT `marketplace.installedPlugins` (R28P6#structured).
  function makeBundledManager(approvals: Record<string, unknown>): IntegrityMgr {
    const cfg = { pluginApprovals: approvals } as unknown as AppConfig;
    const mgr = new PluginManager(
      join(HOME, 'plugins'),
      HOME,
      () => cfg,
      () => {},
      ['req'],
      () => {},
    ) as unknown as IntegrityMgr;
    mgr.marketplaceService = undefined; // no marketplace
    return mgr;
  }

  it('TRUSTS a deferred BUNDLED plugin against its pluginApprovals record (R28P6)', () => {
    const mgr = makeBundledManager({ req: { hash: 'hashOLD', permissions: ['read'] } });
    mgr.setDeferredUpdateNames(['req']);
    expect(
      mgr.isRequiredPluginIntegrityTrusted({ name: 'req', version: '1.0.0', permissions: ['read'] }, 'hashOLD'),
    ).toBe(true);
    // Wrong hash still rejected.
    expect(mgr.isRequiredPluginIntegrityTrusted({ name: 'req', version: '1.0.0', permissions: ['read'] }, 'NOPE')).toBe(
      false,
    );
    mgr.setDeferredUpdateNames([]);
  });

  // R33P2: a release can INTRODUCE marketplace URLs AFTER a bundled required plugin
  // already owed cleanup, so `marketplaceService` is truthy but there is NO
  // `marketplace.installedPlugins` record — the approval lives only in
  // `pluginApprovals`. The deferred path must fall back to that record, not reject.
  it('TRUSTS a deferred plugin via pluginApprovals when marketplace exists but has no install record (R33P2)', () => {
    const mgr = makeIntegrityManager(
      {}, // no marketplace install record for req
      [{ name: 'req', version: '2.0.0', fileHash: 'hashNEW' }], // catalog moved on
      { req: { hash: 'hashOLD', permissions: ['read'] } }, // approval carries the trusted hash
    );
    mgr.setDeferredUpdateNames(['req']);
    expect(
      mgr.isRequiredPluginIntegrityTrusted({ name: 'req', version: '1.0.0', permissions: ['read'] }, 'hashOLD'),
    ).toBe(true);
    // A hash that matches neither the install record (absent) nor the approval is rejected.
    expect(
      mgr.isRequiredPluginIntegrityTrusted({ name: 'req', version: '1.0.0', permissions: ['read'] }, 'WRONG'),
    ).toBe(false);
    mgr.setDeferredUpdateNames([]);
  });

  it('does NOT fall back to pluginApprovals when marketplace has no install record and NOT deferred (R33P2)', () => {
    const mgr = makeIntegrityManager({}, [{ name: 'req', version: '2.0.0', fileHash: 'hashNEW' }], {
      req: { hash: 'hashOLD', permissions: ['read'] },
    });
    // Not deferred → no fallback; the absent install record fails integrity.
    expect(
      mgr.isRequiredPluginIntegrityTrusted({ name: 'req', version: '1.0.0', permissions: ['read'] }, 'hashOLD'),
    ).toBe(false);
  });

  // R33P3: a legacy bundled approval predating permission snapshots has a hash but no
  // `permissions`. When the manifest carries the host-inferred Browser permission,
  // exact/legacy-delta matching both fail — but a hash match proves it's the approved
  // code, so integrity trusts it and CONSENT (checked after integrity) gates activation.
  it('TRUSTS a deferred bundled plugin with a hash-ONLY legacy approval (no permission snapshot) (R33P3)', () => {
    const mgr = makeBundledManager({ req: { hash: 'hashOLD' } }); // no permissions field
    mgr.setDeferredUpdateNames(['req']);
    expect(
      mgr.isRequiredPluginIntegrityTrusted(
        { name: 'req', version: '1.0.0', permissions: ['read', AUTHENTICATED_BROWSER] },
        'hashOLD',
      ),
    ).toBe(true);
    // Hash mismatch still rejected even for a hash-only approval.
    expect(
      mgr.isRequiredPluginIntegrityTrusted(
        { name: 'req', version: '1.0.0', permissions: ['read', AUTHENTICATED_BROWSER] },
        'NOPE',
      ),
    ).toBe(false);
    mgr.setDeferredUpdateNames([]);
  });

  it('accepts the narrow legacy inferred-Browser delta for a deferred bundled plugin WITH a snapshot (R31P2)', () => {
    // Approval snapshot predates the inferred Browser permission; manifest adds exactly it.
    const mgr = makeBundledManager({ req: { hash: 'hashOLD', permissions: ['read'] } });
    mgr.setDeferredUpdateNames(['req']);
    expect(
      mgr.isRequiredPluginIntegrityTrusted(
        { name: 'req', version: '1.0.0', permissions: ['read', AUTHENTICATED_BROWSER] },
        'hashOLD',
      ),
    ).toBe(true);
    // A non-Browser permission delta is NOT tolerated.
    expect(
      mgr.isRequiredPluginIntegrityTrusted({ name: 'req', version: '1.0.0', permissions: ['read', 'net'] }, 'hashOLD'),
    ).toBe(false);
    mgr.setDeferredUpdateNames([]);
  });
});

// R34P1 / R33P1: the startup legacy-batch reconcile must NOT drop a legacy marker
// while a plugin that could still owe legacy cleanup is held out of the active set —
// awaiting consent, or in an unresolved activation state (`error`/`loading`). These
// two accessors are the signals it consults.
describe('hasPendingConsent / hasUnresolvedActivation (R33P1/R34P1)', () => {
  type StateMgr = {
    hasPendingConsent: () => boolean;
    hasUnresolvedActivation: () => boolean;
    plugins: Map<string, { state: string }>;
    pendingConsent: Map<string, unknown>;
  };
  function makeStateMgr(): StateMgr {
    const cfg = {} as unknown as AppConfig;
    return new PluginManager(
      join(HOME, 'plugins'),
      HOME,
      () => cfg,
      () => {},
      [],
      () => {},
    ) as unknown as StateMgr;
  }

  it('hasPendingConsent reflects the pendingConsent map', () => {
    const mgr = makeStateMgr();
    expect(mgr.hasPendingConsent()).toBe(false);
    mgr.pendingConsent.set('req', {});
    expect(mgr.hasPendingConsent()).toBe(true);
  });

  it('hasUnresolvedActivation is true for error/loading, false for active/disabled', () => {
    const mgr = makeStateMgr();
    expect(mgr.hasUnresolvedActivation()).toBe(false);

    mgr.plugins.set('a', { state: 'active' });
    mgr.plugins.set('d', { state: 'disabled' });
    // Only active + disabled → resolved (disabled is a deliberate opt-out, out of the
    // "all active" legacy batch scope).
    expect(mgr.hasUnresolvedActivation()).toBe(false);

    // A plugin that failed activation (may have done privileged setup pre-update) →
    // unresolved, so a legacy marker must not be dropped yet (R34P1).
    mgr.plugins.set('e', { state: 'error' });
    expect(mgr.hasUnresolvedActivation()).toBe(true);

    mgr.plugins.set('e', { state: 'active' });
    mgr.plugins.set('l', { state: 'loading' });
    expect(mgr.hasUnresolvedActivation()).toBe(true);
  });
});

// R37P1: loadAll must NOT treat a directory-READ failure as "no plugins" — that
// would let the startup legacy reconcile drop the marker with owed cleanup unrun.
describe('loadAll directory-read failure (R37P1)', () => {
  it('THROWS when the plugins path exists but cannot be read as a directory', async () => {
    // Point pluginsDir at a FILE: existsSync() is true, but readdirSync() throws
    // ENOTDIR — the same class as a transient EMFILE/EIO. loadAll must propagate it
    // (so main.ts's loader catch blocks installs + preserves the ledger), NOT load
    // zero plugins.
    const filePath = join(HOME, 'not-a-dir');
    writeFileSync(filePath, 'x');
    const cfg = {} as unknown as AppConfig;
    const mgr = new PluginManager(
      filePath,
      HOME,
      () => cfg,
      () => {},
      [],
      () => {},
    );
    await expect(mgr.loadAll()).rejects.toThrow();
  });

  it('does NOT throw for a genuinely ABSENT plugins directory (fresh install)', async () => {
    const missing = join(HOME, 'definitely-missing-dir');
    const cfg = {} as unknown as AppConfig;
    const mgr = new PluginManager(
      missing,
      HOME,
      () => cfg,
      () => {},
      [],
      () => {},
    );
    await expect(mgr.loadAll()).resolves.toBeUndefined();
  });

  // R40P1#structured: a DETERMINISTICALLY-malformed manifest (bad JSON — fails
  // identically on every launch) must NOT flag incomplete discovery, else it would
  // wedge ALL app updates forever with no in-app recovery. It's simply skipped.
  it('does NOT flag hadIncompleteDiscovery for a deterministically-malformed manifest (R40P1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kai-pm-disc-'));
    const bad = join(dir, 'broken');
    mkdirSync(bad);
    writeFileSync(join(bad, 'plugin.json'), '{ this is not valid json');
    const cfg = {} as unknown as AppConfig;
    const mgr = new PluginManager(
      dir,
      HOME,
      () => cfg,
      () => {},
      [],
      () => {},
    ) as unknown as PluginManager & {
      hadIncompleteDiscovery: () => boolean;
      getPluginCount: () => number;
    };
    await mgr.loadAll(); // resolves — a per-entry failure doesn't abort the whole load
    // Deterministic parse error → skipped, NOT flagged (would otherwise permanently
    // block updates). The plugin is simply absent from the loaded set.
    expect(mgr.hadIncompleteDiscovery()).toBe(false);
    expect(mgr.getPluginCount()).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('does NOT flag incomplete discovery for a clean empty plugins directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kai-pm-disc-clean-'));
    const cfg = {} as unknown as AppConfig;
    const mgr = new PluginManager(
      dir,
      HOME,
      () => cfg,
      () => {},
      [],
      () => {},
    ) as unknown as PluginManager & {
      hadIncompleteDiscovery: () => boolean;
    };
    await mgr.loadAll();
    expect(mgr.hadIncompleteDiscovery()).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  // R39P1: a NON-ENOENT stat error on the plugins dir (e.g. a path component is a
  // file → ENOTDIR) must NOT be treated as "absent" — on loadAll it propagates so the
  // legacy marker is preserved, rather than returning [] like a genuinely-missing dir.
  it('THROWS when the plugins dir path is unreadable for a reason other than ENOENT (R39P1)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'kai-pm-disc-err-'));
    const filePath = join(base, 'a-file');
    writeFileSync(filePath, 'x');
    // pluginsDir traverses THROUGH a file → statSync(pluginsDir) throws ENOTDIR (not
    // ENOENT) → classified 'error' → loadAll propagates.
    const pluginsDir = join(filePath, 'plugins');
    const cfg = {} as unknown as AppConfig;
    const mgr = new PluginManager(
      pluginsDir,
      HOME,
      () => cfg,
      () => {},
      [],
      () => {},
    );
    await expect(mgr.loadAll()).rejects.toThrow();
    rmSync(base, { recursive: true, force: true });
  });

  // R41P1: a DANGLING symlink entry makes statSync throw ENOENT (deterministic
  // debris, identical every launch) — it must NOT flag incomplete discovery, else it
  // would permanently wedge all app updates with no UI recovery. Just skipped.
  it('does NOT flag incomplete discovery for a dangling symlink entry (R41P1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kai-pm-disc-symlink-'));
    // readdir lists this entry, but its symlink target does not exist → statSync
    // (which follows symlinks) throws ENOENT.
    symlinkSync(join(dir, 'nonexistent-target'), join(dir, 'dangling'));
    const cfg = {} as unknown as AppConfig;
    const mgr = new PluginManager(
      dir,
      HOME,
      () => cfg,
      () => {},
      [],
      () => {},
    ) as unknown as PluginManager & {
      hadIncompleteDiscovery: () => boolean;
      getPluginCount: () => number;
    };
    await mgr.loadAll();
    expect(mgr.hadIncompleteDiscovery()).toBe(false);
    expect(mgr.getPluginCount()).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  // R43P1: a plugin discovered fine but with a DETERMINISTICALLY-missing backend.js
  // (plain ENOENT) → error state, but must NOT flag incomplete discovery (won't change
  // on retry; would otherwise permanently wedge updates). The transient sibling (EIO)
  // is symmetric code gated by isTransientFsError (unit-tested separately).
  it('does NOT flag incomplete discovery when a valid plugin is missing backend.js (deterministic) (R43P1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kai-pm-disc-nobackend-'));
    const p = join(dir, 'nobackend');
    mkdirSync(p);
    writeFileSync(join(p, 'plugin.json'), JSON.stringify({ name: 'nobackend', version: '1.0.0', permissions: [] }));
    // No backend.js written → deterministic ENOENT.
    const cfg = {} as unknown as AppConfig;
    const mgr = new PluginManager(
      dir,
      HOME,
      () => cfg,
      () => {},
      [],
      () => {},
    ) as unknown as PluginManager & {
      hadIncompleteDiscovery: () => boolean;
    };
    await mgr.loadAll();
    expect(mgr.hadIncompleteDiscovery()).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('flags incomplete discovery when loadAll SKIPS an existing error-stub with transientLoadFailure (R51P1)', async () => {
    // Simulate initMarketplace (which runs before loadAll) having pre-loaded a required
    // plugin as an `error` stub from a TRANSIENT activation failure. loadAll discovers
    // the same plugin on disk but skips it (name already present) — it must still honor
    // the recorded transient failure and mark discovery incomplete so installs block.
    const dir = mkdtempSync(join(tmpdir(), 'kai-pm-disc-preload-'));
    const p = join(dir, 'req');
    mkdirSync(p);
    writeFileSync(join(p, 'plugin.json'), JSON.stringify({ name: 'req', version: '1.0.0', permissions: [] }));
    writeFileSync(join(p, 'backend.js'), 'exports.activate = () => {};');
    const cfg = {} as unknown as AppConfig;
    const mgr = new PluginManager(
      dir,
      HOME,
      () => cfg,
      () => {},
      [],
      () => {},
    );
    const internal = mgr as unknown as {
      hadIncompleteDiscovery: () => boolean;
      plugins: Map<string, { state: string; manifest: { name: string }; transientLoadFailure?: boolean }>;
    };
    // Pre-seed the error stub a non-faithful earlier path would leave.
    internal.plugins.set('req', { state: 'error', manifest: { name: 'req' }, transientLoadFailure: true });
    await mgr.loadAll();
    expect(internal.hadIncompleteDiscovery()).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('does NOT flag when loadAll skips an existing error-stub WITHOUT transientLoadFailure (deterministic) (R51P1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kai-pm-disc-preload2-'));
    const p = join(dir, 'req');
    mkdirSync(p);
    writeFileSync(join(p, 'plugin.json'), JSON.stringify({ name: 'req', version: '1.0.0', permissions: [] }));
    writeFileSync(join(p, 'backend.js'), 'exports.activate = () => {};');
    const cfg = {} as unknown as AppConfig;
    const mgr = new PluginManager(
      dir,
      HOME,
      () => cfg,
      () => {},
      [],
      () => {},
    );
    const internal = mgr as unknown as {
      hadIncompleteDiscovery: () => boolean;
      plugins: Map<string, { state: string; manifest: { name: string }; transientLoadFailure?: boolean }>;
    };
    // A DETERMINISTIC error stub (no transient flag) must NOT wedge updates.
    internal.plugins.set('req', { state: 'error', manifest: { name: 'req' } });
    await mgr.loadAll();
    expect(internal.hadIncompleteDiscovery()).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
