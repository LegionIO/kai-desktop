/**
 * Tests for pre-update-hook FAILURE surfacing in performQuitAndInstall.
 *
 * When a plugin's pre-update hook throws or times out, the install must not
 * silently no-op (the button looked "dead" in the field). Instead:
 *  - a *broken* hook (threw / timed out → result.failed) raises a native
 *    "Proceed anyway / Cancel" dialog; proceeding runs quitAndInstall, cancel
 *    reverts to a retryable 'downloaded';
 *  - a *deliberate* abort ({abort:true} without failed) shows an info dialog and
 *    cancels only (no override).
 *
 * This file owns its own electron / electron-updater mocks so it can capture the
 * `update-downloaded` handler and drive the module-internal downloaded state,
 * which is the precondition performQuitAndInstall guards on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { IpcMain } from 'electron';

const USERDATA = mkdtempSync(join(tmpdir(), 'kai-autoupdate-hook-'));
process.env.KAI_USER_DATA = USERDATA;

const showMessageBox = vi.fn();
// Capture registered autoUpdater event handlers so we can fire `update-downloaded`.
const handlers: Record<string, (...args: unknown[]) => void> = {};
const quitAndInstall = vi.fn();

vi.mock('electron', () => ({
  app: {
    getPath: () => USERDATA,
    getVersion: () => '2.5.0',
    isPackaged: false,
    getAppPath: () => '/app/path',
  },
  dialog: { showMessageBox },
}));
vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: {
      on: (event: string, cb: (...args: unknown[]) => void) => {
        handlers[event] = cb;
      },
      removeListener: vi.fn(),
      once: vi.fn(),
      checkForUpdates: vi.fn().mockResolvedValue(undefined),
      quitAndInstall,
      setFeedURL: vi.fn(),
      logger: null,
      autoDownload: false,
      autoInstallOnAppQuit: false,
      autoRunAppAfterInstall: false,
      currentVersion: { version: '2.5.0' },
    },
  },
}));
vi.mock('../../utils/window-send.js', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../local-bridge/update-signal.js', () => ({ writeUpdateReady: vi.fn() }));

const {
  registerAutoUpdateHandlers,
  setUpdateHookRunner,
  performQuitAndInstall,
  promptHookFailure,
  __resetForTests,
  __setChecksInFlightForTests,
  __setCheckDrainTimeoutForTests,
  setInstallsBlockedForUnresolvedDebt,
} = await import('../auto-update.js');
const { safeErrorText } = await import('../../utils/safe-error-text.js');
const { readLedger } = await import('../post-update-ledger.js');

// The post-update cleanup ledger reuses the marker path; "outstanding debt"
// means one or more attempts are still recorded (replaces the old marker-exists
// check). `owedFor` returns a specific attempt's still-owed plugin set.
const LEDGER_PATH = join(USERDATA, '.update-completed');
function hasDebt(): boolean {
  return readLedger().length > 0;
}

// Minimal ipcMain that records handlers (registerAutoUpdateHandlers wires them).
const ipcMain = { handle: vi.fn() } as unknown as IpcMain;

/** Put the module into the "downloaded" precondition by firing update-downloaded. */
function markDownloaded() {
  handlers['update-downloaded']?.({ version: '2.6.0', downloadedFile: '/tmp/Kai-2.6.0.zip' });
}

beforeEach(() => {
  __resetForTests();
  rmSync(LEDGER_PATH, { recursive: true, force: true });
  showMessageBox.mockReset();
  quitAndInstall.mockReset();
  registerAutoUpdateHandlers(ipcMain);
});
afterEach(() => vi.clearAllMocks());

describe('promptHookFailure', () => {
  it('returns { proceed: true } when the user picks "Proceed anyway" (button 0)', async () => {
    showMessageBox.mockResolvedValue({ response: 0 });
    await expect(promptHookFailure('boom')).resolves.toEqual({ proceed: true });
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ buttons: ['Proceed anyway', 'Cancel'], cancelId: 1 }),
    );
  });
  it('returns { proceed: false } when the user picks "Cancel" (button 1)', async () => {
    showMessageBox.mockResolvedValue({ response: 1 });
    await expect(promptHookFailure('boom')).resolves.toEqual({ proceed: false });
  });
  it('returns { proceed: false, dialogFailed: true } when the dialog cannot be shown', async () => {
    showMessageBox.mockRejectedValue(new Error('no display'));
    await expect(promptHookFailure('boom')).resolves.toEqual({ proceed: false, dialogFailed: true });
  });
});

describe('performQuitAndInstall — suppressDialogs (web-bridge caller)', () => {
  it('a duplicate concurrent install request is a benign no-op, not a failure (R22P2)', async () => {
    // First call hangs in its pre-update hook so installInProgress stays true.
    let releaseHook: (() => void) | undefined;
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseHook = () => resolve({ decision: 'proceed', rollback: vi.fn() });
          }),
      ),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    markDownloaded();
    const first = performQuitAndInstall(); // in-flight, awaiting the hook
    await Promise.resolve();
    // Second (duplicate) call while the first is in progress → benign no-op.
    await expect(performQuitAndInstall()).resolves.toEqual({ ok: true });
    releaseHook?.();
    await first;
    expect(quitAndInstall).toHaveBeenCalledTimes(1); // installed exactly once
  });

  it('an async quitAndInstall failure rolls back and marks the session (R23P2/R24P1)', async () => {
    const rollback = vi.fn().mockResolvedValue(undefined);
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({ decision: 'proceed', rollback }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    markDownloaded();
    await performQuitAndInstall(); // reaches quitAndInstall; committed
    expect(quitAndInstall).toHaveBeenCalledTimes(1);

    // Squirrel emits `error` asynchronously (install failed, app did NOT quit).
    handlers['error']?.(new Error('staging failed'));
    expect(rollback).toHaveBeenCalledTimes(1); // committed attempt's setup rolled back (R24P1)
    await Promise.resolve();
    await Promise.resolve();
  });

  it('notifies post-only plugins with success:false (only the owed post-only set) on committed failure (R31P1/R33P1)', async () => {
    const runPost = vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [], attemptedNames: [] });
    setUpdateHookRunner({
      // Owed at commit = participant 'pluginA' ∪ post-only 'postOnly'.
      getPostUpdatePluginNames: vi.fn().mockReturnValue(['postOnly']),
      runPreUpdateHooks: vi
        .fn()
        .mockResolvedValue({
          decision: 'proceed',
          rollback: vi.fn().mockResolvedValue({ failed: [] }),
          participantNames: ['pluginA'],
          postHookParticipantNames: ['pluginA'],
        }),
      runPostUpdateHooks: runPost,
    });
    markDownloaded();
    await performQuitAndInstall(); // committed
    handlers['error']?.(new Error('staging failed'));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    // The post-only notify ran for exactly the owed post-only set (participant
    // 'pluginA' excluded — rollback already notified it, R33P1).
    expect(runPost).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
      expect.objectContaining({ onlyNames: ['postOnly'] }),
    );
  });

  it('runs the post-only notify EVEN IF participant rollback reports failure (R31P2)', async () => {
    const runPost = vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [], attemptedNames: [] });
    setUpdateHookRunner({
      // Participant rollback reports a FAILED plugin — the post-only notify must
      // still run so post-only plugins aren't skipped (independent teardown phases).
      getPostUpdatePluginNames: vi.fn().mockReturnValue(['postOnly']),
      runPreUpdateHooks: vi
        .fn()
        .mockResolvedValue({
          decision: 'proceed',
          rollback: vi.fn().mockResolvedValue({ failed: ['pluginA'] }),
          participantNames: ['pluginA'],
          postHookParticipantNames: ['pluginA'],
        }),
      runPostUpdateHooks: runPost,
    });
    markDownloaded();
    await performQuitAndInstall();
    handlers['error']?.(new Error('staging failed'));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(runPost).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
      expect.objectContaining({ onlyNames: ['postOnly'] }),
    );
  });

  it('keeps a cleanup-owed ledger entry when a post-only notify FAILS after a committed failure (R31P1/R35P1)', async () => {
    rmSync(LEDGER_PATH, { recursive: true, force: true });
    setUpdateHookRunner({
      // A POST-ONLY plugin (owed at commit via getPostUpdatePluginNames) whose
      // failure-notify fails must STAY owed so the next launch retries exactly it.
      getPostUpdatePluginNames: vi.fn().mockReturnValue(['postOnly']),
      runPreUpdateHooks: vi
        .fn()
        .mockResolvedValue({
          decision: 'proceed',
          rollback: vi.fn().mockResolvedValue({ failed: [] }),
          participantNames: [],
        }),
      runPostUpdateHooks: vi
        .fn()
        .mockResolvedValue({ allSucceeded: false, succeededNames: [], attemptedNames: ['postOnly'] }),
    });
    markDownloaded();
    await performQuitAndInstall();
    expect(hasDebt()).toBe(true); // attempt recorded at commit (owed: postOnly)
    handlers['error']?.(new Error('staging failed'));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    // The failed post-only plugin is still owed for next-launch retry.
    const led = readLedger();
    expect(led).toHaveLength(1);
    expect(led[0].owed).toEqual(['postOnly']);
    expect(led[0].success).toBe(false); // outcome persisted
    rmSync(LEDGER_PATH, { recursive: true, force: true });
  });

  it('keeps a participant owed in the ledger when rollback cleanup FAILS after a committed failure (R29P2/R35P1)', async () => {
    rmSync(LEDGER_PATH, { recursive: true, force: true });
    // Rollback reports a FAILED participant → it must remain owed for next-launch
    // reconciliation.
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({
        decision: 'proceed',
        rollback: vi.fn().mockResolvedValue({ failed: ['pluginA'] }),
        participantNames: ['pluginA'],
        postHookParticipantNames: ['pluginA'],
      }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [], attemptedNames: [] }),
    });
    markDownloaded();
    await performQuitAndInstall(); // records the attempt (owed: pluginA), commits
    expect(hasDebt()).toBe(true);
    handlers['error']?.(new Error('staging failed'));
    // Let the detached rollback settle.
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const led = readLedger();
    expect(led).toHaveLength(1);
    expect(led[0].owed).toEqual(['pluginA']); // preserved because cleanup failed
    expect(led[0].success).toBe(false);
    rmSync(LEDGER_PATH, { recursive: true, force: true });
  });

  it('records a HOOKLESS-at-commit participant on the ledger when its rollback FAILS after a committed failure (R28P35)', async () => {
    rmSync(LEDGER_PATH, { recursive: true, force: true });
    // 'pluginA' participates but has NO post-hook at commit → excluded from
    // owedAtCommit (empty → no committed record). It registers a post-hook after
    // commit; on the async install failure its rollback FAILS. The teardown must
    // WIDEN the attempt to include the participant so its debt is durable (R28P35),
    // not lost on relaunch.
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      getSetupCapablePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({
        decision: 'proceed',
        rollback: vi.fn().mockResolvedValue({ failed: ['pluginA'] }), // its late cleanup failed
        participantNames: ['pluginA'],
        postHookParticipantNames: [], // hookless AT COMMIT
        timedOutParticipantNames: [],
        failedParticipantNames: [],
      }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [], attemptedNames: [] }),
    });
    markDownloaded();
    await performQuitAndInstall(); // owedAtCommit empty → commits with no record
    handlers['error']?.(new Error('staging failed')); // async committed failure → teardown
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const led = readLedger();
    expect(led).toHaveLength(1);
    expect(led[0].owed).toContain('pluginA'); // debt durably recorded despite hookless-at-commit
    expect(led[0].success).toBe(false);
    rmSync(LEDGER_PATH, { recursive: true, force: true });
  });

  it('clears the ledger attempt when rollback cleanup SUCCEEDS after a committed failure (R29P2/R35P1)', async () => {
    rmSync(LEDGER_PATH, { recursive: true, force: true });
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({
        decision: 'proceed',
        rollback: vi.fn().mockResolvedValue(undefined),
        participantNames: ['pluginA'],
        postHookParticipantNames: ['pluginA'],
      }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [], attemptedNames: [] }),
    });
    markDownloaded();
    await performQuitAndInstall();
    expect(hasDebt()).toBe(true);
    handlers['error']?.(new Error('staging failed'));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(hasDebt()).toBe(false); // attempt dropped because all cleanup succeeded
  });

  it('persists a cleanup-debt ledger entry when CANCEL rollback cleanup fails (R30P1/R35P1)', async () => {
    rmSync(LEDGER_PATH, { recursive: true, force: true });
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({
        decision: 'overridable',
        reason: 'boom',
        rollback: vi.fn().mockResolvedValue({ failed: ['pluginA'] }),
        participantNames: ['pluginA'],
        postHookParticipantNames: ['pluginA'],
      }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [], attemptedNames: [] }),
    });
    markDownloaded();
    showMessageBox.mockResolvedValue({ response: 1 }); // Cancel → revert() runs rollback (reports failure)
    const res = await performQuitAndInstall();
    expect(quitAndInstall).not.toHaveBeenCalled();
    // The cancel path never committed, so a failed cleanup must record a debt
    // attempt (owed: the participant) for next-launch reconciliation (R30P1)…
    const led = readLedger();
    expect(led).toHaveLength(1);
    expect(led[0].owed).toEqual(['pluginA']);
    // …and surface the incomplete cleanup rather than reporting a clean no-op (R32P1).
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/cleanup|relaunch/i);
    rmSync(LEDGER_PATH, { recursive: true, force: true });
  });

  it('a clean cancel (cleanup succeeds) returns ok:true (R32P1)', async () => {
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi
        .fn()
        .mockResolvedValue({ decision: 'overridable', reason: 'boom', rollback: vi.fn().mockResolvedValue(undefined) }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    markDownloaded();
    showMessageBox.mockResolvedValue({ response: 1 }); // Cancel, cleanup succeeds
    await expect(performQuitAndInstall()).resolves.toEqual({ ok: true });
  });

  it("a clean cancel does NOT clobber an unrelated earlier attempt's debt (R35P1 supersedes R34P1)", async () => {
    // The old single marker made a clean cancel blanket-delete ANY debt marker
    // (R34P1). The per-attempt ledger keeps each attempt isolated: a clean cancel
    // of THIS attempt must leave an earlier, unrelated attempt's owed cleanup
    // intact for its own next-launch reconciliation.
    rmSync(LEDGER_PATH, { recursive: true, force: true });
    writeFileSync(
      LEDGER_PATH,
      JSON.stringify({
        v: 1,
        attempts: [{ id: 'earlier', version: 'x', fromVersion: 'y', ts: 1, owed: ['stalePlugin'] }],
      }),
    );
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({
        decision: 'overridable',
        reason: 'boom',
        rollback: vi.fn().mockResolvedValue(undefined),
        participantNames: [],
      }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [], attemptedNames: [] }),
    });
    markDownloaded();
    showMessageBox.mockResolvedValue({ response: 1 }); // Cancel → revert() cleanup succeeds
    await performQuitAndInstall();
    const led = readLedger();
    expect(led.map((a) => a.id)).toContain('earlier'); // unrelated debt preserved
    expect(led.find((a) => a.id === 'earlier')?.owed).toEqual(['stalePlugin']);
    rmSync(LEDGER_PATH, { recursive: true, force: true });
  });

  it('async install failure broadcasts a failure message on the follow-up status (R32P1)', async () => {
    const statuses: Array<{ state: string; error?: string }> = [];
    // Capture broadcasts via the mocked window-send.
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi
        .fn()
        .mockResolvedValue({ decision: 'proceed', rollback: vi.fn().mockResolvedValue(undefined) }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    const { broadcastToAllWindows } = (await import('../../utils/window-send.js')) as unknown as {
      broadcastToAllWindows: { mock: { calls: Array<[string, { state: string; error?: string }]> } };
    };
    markDownloaded();
    await performQuitAndInstall();
    handlers['error']?.(new Error('staging failed'));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (const [ch, payload] of broadcastToAllWindows.mock.calls) {
      if (ch === 'auto-update:status') statuses.push(payload);
    }
    const failedDownloaded = statuses.find((s) => s.state === 'downloaded' && s.error);
    expect(failedDownloaded?.error).toBeTruthy();
  });

  it('after a failed install, a retry requires relaunch (one-shot per session, R25P1)', async () => {
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({ decision: 'proceed', rollback: vi.fn() }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    markDownloaded();
    await performQuitAndInstall();
    handlers['error']?.(new Error('staging failed')); // committed failure → session marked
    await Promise.resolve();
    await Promise.resolve();

    // A retry does NOT call quitAndInstall again (would stack native listeners);
    // it returns a clear relaunch-required error.
    quitAndInstall.mockClear();
    const res = await performQuitAndInstall();
    expect(quitAndInstall).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toMatch(/relaunch|reopen|quit/i);
  });

  it('broadcasts "preparing" BEFORE the install proceeds (progress while gate/hooks run, R4P1)', async () => {
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({ decision: 'proceed', rollback: vi.fn() }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    const { broadcastToAllWindows } = (await import('../../utils/window-send.js')) as unknown as {
      broadcastToAllWindows: { mock: { calls: Array<[string, { state: string }]> } };
    };
    broadcastToAllWindows.mock.calls.length = 0;
    markDownloaded();
    await performQuitAndInstall();
    const states = broadcastToAllWindows.mock.calls
      .filter(([ch]) => ch === 'auto-update:status')
      .map(([, p]) => p.state);
    expect(states).toContain('preparing');
  });

  it('a CANCEL whose rollback cleanup fails BLOCKS a subsequent install until relaunch (R4P1)', async () => {
    rmSync(LEDGER_PATH, { recursive: true, force: true });
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({
        decision: 'overridable',
        reason: 'boom',
        // Rollback reports a FAILED participant → revert() returns ok:false.
        rollback: vi.fn().mockResolvedValue({ failed: ['pluginA'] }),
        participantNames: ['pluginA'],
        postHookParticipantNames: ['pluginA'],
      }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [], attemptedNames: [] }),
    });
    markDownloaded();
    showMessageBox.mockResolvedValue({ response: 1 }); // Cancel
    const first = await performQuitAndInstall();
    expect(first.ok).toBe(false); // incomplete cleanup surfaced
    // A second attempt (even "Proceed anyway") is now refused — dirty state.
    showMessageBox.mockResolvedValue({ response: 0 });
    const second = await performQuitAndInstall();
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/finalized|relaunch|reopen/i);
    expect(quitAndInstall).not.toHaveBeenCalled();
    rmSync(LEDGER_PATH, { recursive: true, force: true });
  });

  it('a CANCEL whose rollback cleanup fails DEFERS the failed plugin (R7)', async () => {
    rmSync(LEDGER_PATH, { recursive: true, force: true });
    const deferUpdates = vi.fn();
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      getSetupCapablePluginNames: vi.fn().mockReturnValue(['pluginA']),
      deferUpdates,
      runPreUpdateHooks: vi.fn().mockResolvedValue({
        decision: 'overridable',
        reason: 'boom',
        rollback: vi.fn().mockResolvedValue({ failed: ['pluginA'] }),
        participantNames: ['pluginA'],
        postHookParticipantNames: ['pluginA'],
      }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [], attemptedNames: [] }),
    });
    markDownloaded();
    showMessageBox.mockResolvedValue({ response: 1 }); // Cancel
    await performQuitAndInstall();
    expect(deferUpdates).toHaveBeenCalledWith(['pluginA']);
    rmSync(LEDGER_PATH, { recursive: true, force: true });
  });

  it('a committed error with NO check in flight IS treated as an install failure (R26P2)', async () => {
    const rollback = vi.fn().mockResolvedValue(undefined);
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({ decision: 'proceed', rollback }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    markDownloaded();
    await performQuitAndInstall(); // committed; no check in flight
    // Correlation is by in-flight-check count, NOT message string: even a
    // message that reads like a download error is the install's here, because no
    // check is running (R26P2).
    handlers['error']?.(new Error('Update download failed'));
    await Promise.resolve();
    await Promise.resolve();
    expect(rollback).toHaveBeenCalledTimes(1); // correctly torn down as an install failure
  });

  it('a periodic-check error while a hook is PENDING does not unlatch the live attempt (R24P1)', async () => {
    // First install hangs in its pre-update hook: installInProgress=true but NOT
    // yet committed (quitAndInstall not called).
    let releaseHook: (() => void) | undefined;
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseHook = () => resolve({ decision: 'proceed', rollback: vi.fn() });
          }),
      ),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    markDownloaded();
    const first = performQuitAndInstall();
    await Promise.resolve();

    // An unrelated periodic checkForUpdates() emits the global `error` mid-hook.
    handlers['error']?.(new Error('net::ERR_CONNECTION_RESET'));

    // The guard must still hold — a concurrent install must NOT start.
    await expect(performQuitAndInstall()).resolves.toEqual({ ok: true }); // duplicate no-op
    releaseHook?.();
    await first;
    expect(quitAndInstall).toHaveBeenCalledTimes(1); // exactly one install, no concurrency
  });

  it('overridable → no host dialog, no install, returns the reason (R19P1)', async () => {
    const rollback = vi.fn().mockResolvedValue(undefined);
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({ decision: 'overridable', reason: 'boom', rollback }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    markDownloaded();
    const res = await performQuitAndInstall({ suppressDialogs: true });
    expect(showMessageBox).not.toHaveBeenCalled(); // no host-native prompt for a remote caller
    expect(quitAndInstall).not.toHaveBeenCalled(); // fail closed (no remote consent)
    expect(res).toMatchObject({ ok: false, error: 'boom' });
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('blocked → no host dialog, returns the reason unsurfaced (R19P1)', async () => {
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({ decision: 'blocked', reason: 'veto', rollback: vi.fn() }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    markDownloaded();
    const res = await performQuitAndInstall({ suppressDialogs: true });
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(quitAndInstall).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: false, error: 'veto' });
    expect(res.surfaced).toBeFalsy(); // web UI must surface it (no host dialog shown)
  });

  it('proceed → installs even for a web-bridge caller', async () => {
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({ decision: 'proceed', rollback: vi.fn() }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    markDownloaded();
    await performQuitAndInstall({ suppressDialogs: true });
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('the auto-update:install IPC handler acks a web-bridge caller immediately (detached, R28P2)', async () => {
    // Grab the registered install handler from the recording ipcMain mock.
    const handleMock = ipcMain.handle as unknown as {
      mock: { calls: Array<[string, (event: unknown) => Promise<unknown>]> };
    };
    const installHandler = handleMock.mock.calls.find((c) => c[0] === 'auto-update:install')?.[1];
    expect(installHandler).toBeTypeOf('function');

    // A web-bridge install whose pre-update hook HANGS (would blow the 60s bridge
    // timeout if awaited).
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockReturnValue(new Promise(() => {})), // never settles
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    markDownloaded();
    // The handler must resolve immediately with a started ack, NOT wait for hooks.
    const res = await installHandler!({ __kaiWebBridge: true });
    expect(res).toMatchObject({ ok: true, started: true });
  });

  it('the auto-update:install IPC handler rejects a web-bridge caller when nothing is staged (R31P1)', async () => {
    const handleMock = ipcMain.handle as unknown as {
      mock: { calls: Array<[string, (event: unknown) => Promise<unknown>]> };
    };
    const installHandler = handleMock.mock.calls.find((c) => c[0] === 'auto-update:install')?.[1];
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({ decision: 'proceed', rollback: vi.fn() }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    // NOTE: no markDownloaded() → nothing staged. A stale web tab invoking install
    // must get an inline error, not a started-ack that leaves the button dead.
    const res = (await installHandler!({ __kaiWebBridge: true })) as { ok: boolean; started?: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.started).toBeFalsy();
    expect(res.error).toBeTruthy();
    expect(quitAndInstall).not.toHaveBeenCalled();
  });
});

describe('performQuitAndInstall — pre-update hook failure surfacing', () => {
  it('broken hook + "Proceed anyway" → installs', async () => {
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi
        .fn()
        .mockResolvedValue({ decision: 'overridable', reason: 'Hook "x" failed: boom', rollback: vi.fn() }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    markDownloaded();
    showMessageBox.mockResolvedValue({ response: 0 }); // Proceed anyway
    await performQuitAndInstall();
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });

  // R5 P1b / R7: a non-proceed outcome after preparing must roll back the setup
  // done this attempt, via the rollback thunk bound to the participating plugins.
  it('cancel invokes the rollback thunk', async () => {
    const rollback = vi.fn().mockResolvedValue(undefined);
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({ decision: 'overridable', reason: 'boom', rollback }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    markDownloaded();
    showMessageBox.mockResolvedValue({ response: 1 }); // Cancel
    await performQuitAndInstall();
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(quitAndInstall).not.toHaveBeenCalled();
  });

  it('a throwing rollback thunk is swallowed and the guard is still cleared (retryable)', async () => {
    const rollback = vi.fn().mockRejectedValue(new Error('cleanup blew up'));
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({ decision: 'overridable', reason: 'boom', rollback }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    markDownloaded();
    showMessageBox.mockResolvedValue({ response: 1 }); // Cancel
    await performQuitAndInstall();
    expect(quitAndInstall).not.toHaveBeenCalled();

    // Guard cleared despite the rollback throw → a later Proceed installs.
    const rollback2 = vi.fn().mockResolvedValue(undefined);
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({ decision: 'overridable', reason: 'boom', rollback: rollback2 }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    showMessageBox.mockResolvedValue({ response: 0 });
    await performQuitAndInstall();
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('deliberate block invokes the rollback thunk, never installs', async () => {
    const rollback = vi.fn().mockResolvedValue(undefined);
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({ decision: 'blocked', reason: 'veto', rollback }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    markDownloaded();
    showMessageBox.mockResolvedValue({ response: 0 });
    // Blocked returns { surfaced: true }: it shows its own info dialog, so callers
    // must not stack a second generic failure dialog (R13P1).
    await expect(performQuitAndInstall()).resolves.toMatchObject({ ok: false, surfaced: true });
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(quitAndInstall).not.toHaveBeenCalled();
  });

  // R14P1: if the deliberate-block info dialog FAILS to show, surfaced must be
  // falsy so the renderer/menu fall back to their own error surface.
  it('deliberate block whose info dialog fails to show → surfaced is falsy', async () => {
    const rollback = vi.fn().mockResolvedValue(undefined);
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({ decision: 'blocked', reason: 'veto', rollback }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    markDownloaded();
    showMessageBox.mockRejectedValue(new Error('no display'));
    const res = await performQuitAndInstall();
    expect(res.ok).toBe(false);
    expect(res.surfaced).toBeFalsy();
    expect(quitAndInstall).not.toHaveBeenCalled();
  });

  // R8P1: rollback must run BEFORE the (possibly long-open) block info dialog,
  // so setup isn't left active for the dialog's lifetime.
  it('deliberate block rolls back BEFORE showing the info dialog', async () => {
    let rolledBackWhenDialogShown: boolean | undefined;
    const rollback = vi.fn().mockResolvedValue(undefined);
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({ decision: 'blocked', reason: 'veto', rollback }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    markDownloaded();
    showMessageBox.mockImplementation(async () => {
      rolledBackWhenDialogShown = rollback.mock.calls.length > 0;
      return { response: 0 };
    });
    await performQuitAndInstall();
    expect(rolledBackWhenDialogShown).toBe(true); // rollback already ran when dialog appeared
  });

  it('REFUSES to install while an earlier attempt has unpersisted outcome (R35P1)', async () => {
    setInstallsBlockedForUnresolvedDebt(true);
    try {
      setUpdateHookRunner({
        getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
        runPreUpdateHooks: vi.fn().mockResolvedValue({ decision: 'proceed', rollback: vi.fn() }),
        runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
      });
      markDownloaded();
      const res = await performQuitAndInstall();
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/finalized|relaunch|reopen/i);
      expect(quitAndInstall).not.toHaveBeenCalled();
    } finally {
      setInstallsBlockedForUnresolvedDebt(false);
    }
  });

  it('a runner REJECTION on Cancel RETAINS the provisional owed set (R8P2)', async () => {
    rmSync(LEDGER_PATH, { recursive: true, force: true });
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      getSetupCapablePluginNames: vi.fn().mockReturnValue(['elevator']),
      // The runner itself REJECTS (not a hook result) — we can't know what setup ran.
      runPreUpdateHooks: vi.fn().mockRejectedValue(new Error('runner exploded after elevation')),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [], attemptedNames: [] }),
    });
    markDownloaded();
    showMessageBox.mockResolvedValue({ response: 1 }); // Cancel → revert
    await performQuitAndInstall();
    // The provisional owed (recorded before the rejecting runner ran) is RETAINED,
    // not dropped — the elevated setup gets a next-launch revoke.
    const led = readLedger();
    expect(led).toHaveLength(1);
    expect(led[0].owed).toEqual(['elevator']);
    expect(led[0].success).toBe(false);
    rmSync(LEDGER_PATH, { recursive: true, force: true });
  });

  it('narrows the provisional to ACTUAL participants before rollback — a SKIPPED setup-capable plugin is not left owed (R28P23)', async () => {
    rmSync(LEDGER_PATH, { recursive: true, force: true });
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      // Provisional records BOTH as setup-capable, but only 'a' actually participates
      // ('a' returned a terminal block so 'b' was skipped and never set up).
      getSetupCapablePluginNames: vi.fn().mockReturnValue(['a', 'b']),
      runPreUpdateHooks: vi.fn().mockResolvedValue({
        decision: 'blocked',
        reason: 'a blocked',
        rollback: vi.fn().mockResolvedValue({ failed: [] }), // 'a' rolls back cleanly
        participantNames: ['a'], // only 'a' ran
        postHookParticipantNames: [],
        timedOutParticipantNames: [],
        failedParticipantNames: [],
      }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [], attemptedNames: [] }),
    });
    markDownloaded();
    showMessageBox.mockResolvedValue({ response: 0 }); // blocked → inform-only → revert
    await performQuitAndInstall();
    // 'b' (a skipped non-participant) must NOT linger as owed; a clean rollback of the
    // sole participant 'a' drops the attempt entirely.
    expect(readLedger()).toEqual([]);
    rmSync(LEDGER_PATH, { recursive: true, force: true });
  });

  it('unions a TIMED-OUT participant into the committed owed set (R8P1)', async () => {
    rmSync(LEDGER_PATH, { recursive: true, force: true });
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      getSetupCapablePluginNames: vi.fn().mockReturnValue(['slowPlugin']),
      // Overridable (the hook timed out) with a timed-out participant that has NO
      // post-hook — it must still be owed at commit so a still-running elevation
      // is revoked next launch.
      runPreUpdateHooks: vi.fn().mockResolvedValue({
        decision: 'overridable',
        reason: 'timed out',
        rollback: vi.fn().mockResolvedValue({ failed: [] }),
        participantNames: ['slowPlugin'],
        postHookParticipantNames: [],
        timedOutParticipantNames: ['slowPlugin'],
      }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [], attemptedNames: [] }),
    });
    markDownloaded();
    showMessageBox.mockResolvedValue({ response: 0 }); // Proceed anyway → commits
    await performQuitAndInstall();
    const led = readLedger();
    expect(led).toHaveLength(1);
    expect(led[0].owed).toContain('slowPlugin'); // timed-out plugin owed at commit
    rmSync(LEDGER_PATH, { recursive: true, force: true });
  });

  it('unions a FAILED (hookless) participant into the committed owed set (R28P18)', async () => {
    rmSync(LEDGER_PATH, { recursive: true, force: true });
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      getSetupCapablePluginNames: vi.fn().mockReturnValue(['elevator']),
      // A pre-hook that FAILED after partial setup and registered NO post-hook: it
      // must still be owed at commit so its stranded setup is reconciled next launch.
      runPreUpdateHooks: vi.fn().mockResolvedValue({
        decision: 'overridable',
        reason: 'elevation failed',
        rollback: vi.fn().mockResolvedValue({ failed: ['elevator'] }),
        participantNames: ['elevator'],
        postHookParticipantNames: [], // hookless
        timedOutParticipantNames: [],
        failedParticipantNames: ['elevator'],
      }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [], attemptedNames: [] }),
    });
    markDownloaded();
    showMessageBox.mockResolvedValue({ response: 0 }); // Proceed anyway → commits
    await performQuitAndInstall();
    const led = readLedger();
    expect(led).toHaveLength(1);
    expect(led[0].owed).toContain('elevator'); // failed hookless plugin owed at commit
    rmSync(LEDGER_PATH, { recursive: true, force: true });
  });

  it('records a PROVISIONAL ledger entry BEFORE running pre-update hooks (crash-mid-hook safety, R5P2)', async () => {
    rmSync(LEDGER_PATH, { recursive: true, force: true });
    let ledgerAtHookTime: ReturnType<typeof readLedger> = [];
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue(['pluginA']),
      getSetupCapablePluginNames: vi.fn().mockReturnValue(['pluginA']),
      // Capture the ledger state AS the pre-update hook runs — the provisional
      // must already be on disk so a crash right here still yields a next-launch revoke.
      runPreUpdateHooks: vi.fn().mockImplementation(async () => {
        ledgerAtHookTime = readLedger();
        return {
          decision: 'proceed',
          rollback: vi.fn().mockResolvedValue({ failed: [] }),
          participantNames: ['pluginA'],
          postHookParticipantNames: ['pluginA'],
        };
      }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [], attemptedNames: [] }),
    });
    markDownloaded();
    await performQuitAndInstall();
    expect(ledgerAtHookTime).toHaveLength(1);
    expect(ledgerAtHookTime[0].owed).toEqual(['pluginA']);
    expect(ledgerAtHookTime[0].success).toBe(false);
    rmSync(LEDGER_PATH, { recursive: true, force: true });
  });

  it('a clean CANCEL drops the provisional entry when no participant owes cleanup (R5P2)', async () => {
    rmSync(LEDGER_PATH, { recursive: true, force: true });
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue(['pluginA']),
      getSetupCapablePluginNames: vi.fn().mockReturnValue(['pluginA']),
      runPreUpdateHooks: vi.fn().mockResolvedValue({
        decision: 'overridable',
        reason: 'boom',
        rollback: vi.fn().mockResolvedValue({ failed: [] }), // clean rollback
        participantNames: ['pluginA'],
        postHookParticipantNames: ['pluginA'],
      }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [], attemptedNames: [] }),
    });
    markDownloaded();
    showMessageBox.mockResolvedValue({ response: 1 }); // Cancel → revert reconciles provisional
    const res = await performQuitAndInstall();
    expect(readLedger()).toEqual([]); // provisional cleared (nothing owed)
    // The authoritative removeAttempt succeeded → the ledger is clean, so the cancel
    // is reported as a clean no-op (R28P10): a superseded per-plugin checkpoint blip
    // must NOT leave it reporting incomplete / blocking future installs.
    expect(res).toMatchObject({ ok: true });
    rmSync(LEDGER_PATH, { recursive: true, force: true });
  });

  it('proceed path does NOT invoke the rollback thunk', async () => {
    const rollback = vi.fn().mockResolvedValue(undefined);
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({ decision: 'proceed', rollback }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    markDownloaded();
    await performQuitAndInstall();
    expect(rollback).not.toHaveBeenCalled();
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('aborts BEFORE running hooks when the provisional ledger entry cannot be written (R27P2/R5P2)', async () => {
    const rollback = vi.fn().mockResolvedValue({ failed: [] });
    const runPre = vi.fn().mockResolvedValue({
      decision: 'proceed',
      rollback,
      participantNames: ['pluginA'],
      postHookParticipantNames: ['pluginA'],
      timedOutParticipantNames: [],
    });
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue(['pluginA']),
      // Setup-capable → a PROVISIONAL entry must be recorded BEFORE hooks run. A
      // ledger write failure there aborts before any setup, so the pre-update
      // hooks never run and there's nothing to roll back (R5P2).
      getSetupCapablePluginNames: vi.fn().mockReturnValue(['pluginA']),
      runPreUpdateHooks: runPre,
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [], attemptedNames: [] }),
    });
    markDownloaded();
    // Make the ledger write fail: put a DIRECTORY where the ledger file goes, so
    // the tmp→rename in recordAttempt fails → the provisional record returns false.
    const markerPath = join(USERDATA, '.update-completed');
    rmSync(markerPath, { recursive: true, force: true });
    mkdirSync(markerPath);
    try {
      const res = await performQuitAndInstall();
      expect(quitAndInstall).not.toHaveBeenCalled(); // did NOT install without a cleanup guarantee
      expect(res).toMatchObject({ ok: false });
      expect(runPre).not.toHaveBeenCalled(); // aborted BEFORE running any setup hook
      expect(rollback).not.toHaveBeenCalled();
    } finally {
      rmSync(markerPath, { recursive: true, force: true });
    }
  });

  it('aborts + rolls back when an empty-owed provisional cannot be DROPPED at commit (R28P1)', async () => {
    // A setup-capable plugin records a PROVISIONAL entry (success:false), but by
    // commit it owes no post-update cleanup (no post-hook, not post-only, not
    // timed-out) → owedAtCommit is empty and we must DROP the provisional. If that
    // drop fails, proceeding would leave a stale success:false record that both
    // blocks future installs and misrepresents a successful install to the
    // next-launch reconciler — so we must abort + roll back instead (R28P1).
    const rollback = vi.fn().mockResolvedValue({ failed: [] });
    const markerPath = join(USERDATA, '.update-completed');
    rmSync(markerPath, { recursive: true, force: true });
    const runPre = vi.fn().mockImplementation(async () => {
      // The provisional entry is already written by now. Sabotage the ledger path
      // so the subsequent drop (removeAttempt) write fails.
      rmSync(markerPath, { recursive: true, force: true });
      mkdirSync(markerPath);
      return {
        decision: 'proceed',
        rollback,
        // No post-hook participants, no post-only, no timed-out → owedAtCommit empty.
        participantNames: ['pluginA'],
        postHookParticipantNames: [],
        timedOutParticipantNames: [],
      };
    });
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      getSetupCapablePluginNames: vi.fn().mockReturnValue(['pluginA']), // → provisional recorded
      runPreUpdateHooks: runPre,
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [], attemptedNames: [] }),
    });
    markDownloaded();
    try {
      const res = await performQuitAndInstall();
      expect(runPre).toHaveBeenCalledTimes(1); // provisional written, hooks DID run
      expect(quitAndInstall).not.toHaveBeenCalled(); // did NOT install on a lying ledger
      expect(res).toMatchObject({ ok: false });
      expect(rollback).toHaveBeenCalledTimes(1); // setup rolled back
    } finally {
      rmSync(markerPath, { recursive: true, force: true });
    }
  });

  it('freezes plugin updates for the install window and unfreezes on CANCEL (R28P1)', async () => {
    const freeze = vi.fn();
    const unfreeze = vi.fn();
    let frozenDuringHooks = false;
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue(['pluginA']),
      getSetupCapablePluginNames: vi.fn().mockReturnValue(['pluginA']),
      freezePluginUpdates: freeze,
      unfreezePluginUpdates: unfreeze,
      runPreUpdateHooks: vi.fn().mockImplementation(async () => {
        // The freeze must already be engaged BEFORE hooks run (R28P1).
        frozenDuringHooks = freeze.mock.calls.length > 0 && unfreeze.mock.calls.length === 0;
        return {
          decision: 'overridable',
          reason: 'boom',
          rollback: vi.fn().mockResolvedValue({ failed: [] }),
          participantNames: ['pluginA'],
          postHookParticipantNames: ['pluginA'],
        };
      }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [], attemptedNames: [] }),
    });
    markDownloaded();
    showMessageBox.mockResolvedValue({ response: 1 }); // Cancel → revert() → unfreeze
    await performQuitAndInstall();
    expect(freeze).toHaveBeenCalledTimes(1);
    expect(frozenDuringHooks).toBe(true);
    expect(unfreeze).toHaveBeenCalled(); // revert lifted the freeze (no quit)
    expect(quitAndInstall).not.toHaveBeenCalled();
    rmSync(join(USERDATA, '.update-completed'), { recursive: true, force: true });
  });

  it('freeze STAYS engaged through a successful proceed→quitAndInstall (process exits) (R28P1)', async () => {
    const freeze = vi.fn();
    const unfreeze = vi.fn();
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      getSetupCapablePluginNames: vi.fn().mockReturnValue([]),
      freezePluginUpdates: freeze,
      unfreezePluginUpdates: unfreeze,
      runPreUpdateHooks: vi.fn().mockResolvedValue({ decision: 'proceed', rollback: vi.fn() }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [], attemptedNames: [] }),
    });
    markDownloaded();
    await performQuitAndInstall();
    expect(freeze).toHaveBeenCalledTimes(1);
    expect(unfreeze).not.toHaveBeenCalled(); // happy path never unfreezes — the app quits
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
    rmSync(join(USERDATA, '.update-completed'), { recursive: true, force: true });
  });

  it('waits for a pre-existing update check/download to drain before committing (R28P1)', async () => {
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({ decision: 'proceed', rollback: vi.fn() }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [], attemptedNames: [] }),
    });
    markDownloaded();
    __setChecksInFlightForTests(1); // a background check/download is still live
    const p = performQuitAndInstall();
    // Give the install a moment to reach (and block on) the drain loop.
    await new Promise((r) => setTimeout(r, 50));
    expect(quitAndInstall).not.toHaveBeenCalled(); // must NOT commit while a check is in flight
    __setChecksInFlightForTests(0); // check settles → drain completes
    await p;
    expect(quitAndInstall).toHaveBeenCalledTimes(1); // now it commits
    rmSync(join(USERDATA, '.update-completed'), { recursive: true, force: true });
  });

  it('ABORTS the install if a pre-existing check does not drain within the timeout (R28P4)', async () => {
    const freeze = vi.fn();
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      freezePluginUpdates: freeze,
      unfreezePluginUpdates: vi.fn(),
      runPreUpdateHooks: vi.fn().mockResolvedValue({ decision: 'proceed', rollback: vi.fn() }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [], attemptedNames: [] }),
    });
    markDownloaded();
    __setChecksInFlightForTests(1); // never drains
    __setCheckDrainTimeoutForTests(60); // short timeout so the abort fires fast
    try {
      const res = await performQuitAndInstall();
      expect(res).toMatchObject({ ok: false });
      expect(quitAndInstall).not.toHaveBeenCalled(); // aborted, did NOT commit into ambiguity
      expect(freeze).not.toHaveBeenCalled(); // aborted BEFORE the hook phase → no freeze to leak
    } finally {
      __setCheckDrainTimeoutForTests(10_000);
      __setChecksInFlightForTests(0);
    }
  });

  it('ABORTS before freeze/hooks if the check-drain swapped the artifact (R28P22)', async () => {
    const freeze = vi.fn();
    const runPre = vi.fn().mockResolvedValue({ decision: 'proceed', rollback: vi.fn() });
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      freezePluginUpdates: freeze,
      unfreezePluginUpdates: vi.fn(),
      runPreUpdateHooks: runPre,
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [], attemptedNames: [] }),
    });
    markDownloaded(); // installVersion captured as 2.6.0 at entry
    __setChecksInFlightForTests(1); // a check is in flight → install waits in the drain
    const p = performQuitAndInstall();
    await new Promise((r) => setTimeout(r, 30));
    // The in-flight check finishes downloading a DIFFERENT version, replacing the
    // staged artifact, THEN drains.
    handlers['update-downloaded']?.({ version: '2.7.0', downloadedFile: '/tmp/Kai-2.7.0.zip' });
    __setChecksInFlightForTests(0);
    const res = await p;
    expect(res).toMatchObject({ ok: false });
    expect(freeze).not.toHaveBeenCalled(); // aborted BEFORE freezing plugins
    expect(runPre).not.toHaveBeenCalled(); // and BEFORE running any setup hook
    expect(quitAndInstall).not.toHaveBeenCalled();
    rmSync(join(USERDATA, '.update-completed'), { recursive: true, force: true });
  });

  // (R10P1) we must still roll back any completed setup.
  it('aborts install + rolls back when a concurrent download swaps the artifact during hooks', async () => {
    const rollback = vi.fn().mockResolvedValue(undefined);
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockImplementation(async () => {
        // Simulate a periodic checkForUpdates finishing a DIFFERENT version
        // mid-hook by firing update-downloaded again with new identity.
        handlers['update-downloaded']?.({ version: '2.7.0', downloadedFile: '/tmp/Kai-2.7.0.zip' });
        return { decision: 'proceed', rollback };
      }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    markDownloaded(); // stages 2.6.0
    await performQuitAndInstall();
    expect(quitAndInstall).not.toHaveBeenCalled(); // vetted 2.6.0 no longer staged → do not install 2.7.0
    expect(rollback).toHaveBeenCalledTimes(1); // completed setup rolled back
  });

  it('broken hook + "Cancel" → does NOT install and stays retryable', async () => {
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({ decision: 'overridable', reason: 'boom' }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    markDownloaded();
    showMessageBox.mockResolvedValue({ response: 1 }); // Cancel
    await performQuitAndInstall();
    expect(quitAndInstall).not.toHaveBeenCalled();

    // installInProgress must have been cleared: a second attempt (Proceed) installs.
    showMessageBox.mockResolvedValue({ response: 0 });
    await performQuitAndInstall();
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('deliberate block → info dialog, never installs, no override', async () => {
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({ decision: 'blocked', reason: 'Unsaved work in progress' }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    markDownloaded();
    showMessageBox.mockResolvedValue({ response: 0 });
    await performQuitAndInstall();
    // Info dialog only offers OK — no Proceed-anyway path.
    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ buttons: ['OK'] }));
    expect(quitAndInstall).not.toHaveBeenCalled();
  });

  it('runner itself throws → fails CLOSED (blocked, inform-only, no install) (R28P2)', async () => {
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockRejectedValue(new Error('runner exploded')),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    markDownloaded();
    // Even if the user WOULD click "Proceed" (response 0), a runner rejection must
    // NOT offer an override — an unvisited plugin might hold a deliberate veto.
    showMessageBox.mockResolvedValue({ response: 0 });
    const res = await performQuitAndInstall();
    // A single INFORM-ONLY dialog (OK button), NOT a Proceed/Cancel prompt.
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ buttons: ['OK'] }));
    expect(quitAndInstall).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: false });
    rmSync(join(USERDATA, '.update-completed'), { recursive: true, force: true });
  });

  it('hook succeeds (proceed) → installs with no dialog', async () => {
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({ decision: 'proceed' }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    markDownloaded();
    await performQuitAndInstall();
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });

  // Regression guard for the R1P2 P1 hazard: a dialog that THROWS must never
  // flip a decision into an install, nor latch the install guard.
  it('deliberate block + info dialog THROWS → does NOT install, no Proceed-anyway, stays retryable', async () => {
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({ decision: 'blocked', reason: 'migration guard' }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    markDownloaded();
    // The (single) deliberate-abort info dialog rejects.
    showMessageBox.mockRejectedValueOnce(new Error('no display'));
    await performQuitAndInstall();
    // Must NOT have escalated to a second (Proceed-anyway) dialog, and must NOT install.
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(quitAndInstall).not.toHaveBeenCalled();

    // Guard cleared → a later successful attempt can still install.
    showMessageBox.mockReset();
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({ decision: 'proceed' }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    await performQuitAndInstall();
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('broken hook + Proceed dialog THROWS → fails closed (no install), stays retryable', async () => {
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({ decision: 'overridable', reason: 'boom' }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    markDownloaded();
    showMessageBox.mockRejectedValueOnce(new Error('no display'));
    // R10P2: a dialog that failed to show is surfaced as { ok:false }, not a silent no-op.
    await expect(performQuitAndInstall()).resolves.toMatchObject({ ok: false });
    expect(quitAndInstall).not.toHaveBeenCalled(); // dialog failure ⇒ do NOT proceed unconfirmed

    // Retryable: a second attempt with a working Proceed dialog installs.
    showMessageBox.mockResolvedValue({ response: 0 });
    await performQuitAndInstall();
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('a plain user Cancel returns { ok: true } (normal no-op, not an error)', async () => {
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({ decision: 'overridable', reason: 'boom', rollback: vi.fn() }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    markDownloaded();
    showMessageBox.mockResolvedValue({ response: 1 }); // Cancel
    await expect(performQuitAndInstall()).resolves.toEqual({ ok: true });
  });

  // An 'overridable' runner decision surfaces the Proceed-anyway prompt;
  // Cancel does not install.
  it('overridable decision → prompts (Proceed anyway/Cancel), Cancel does NOT install', async () => {
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockResolvedValue({ decision: 'overridable', reason: 'partial failure' }),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    markDownloaded();
    showMessageBox.mockResolvedValue({ response: 1 }); // Cancel
    await performQuitAndInstall();
    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ buttons: ['Proceed anyway', 'Cancel'] }));
    expect(quitAndInstall).not.toHaveBeenCalled();
  });

  // R2P2 P2: a hook that throws an object whose toString itself throws must not
  // wedge the installer — safeErrorText absorbs it and the flow still settles
  // (fail-closed as blocked per R28P2), never wedging the guard.
  it('runner throws an object with a throwing toString → does not wedge, fails closed', async () => {
    const nasty = {
      toString() {
        throw new Error('toString exploded');
      },
    };
    setUpdateHookRunner({
      getPostUpdatePluginNames: vi.fn().mockReturnValue([]),
      runPreUpdateHooks: vi.fn().mockRejectedValue(nasty),
      runPostUpdateHooks: vi.fn().mockResolvedValue({ allSucceeded: true, succeededNames: [] }),
    });
    markDownloaded();
    showMessageBox.mockResolvedValue({ response: 0 }); // even "Proceed" must not install
    const res = await performQuitAndInstall();
    expect(res).toMatchObject({ ok: false });
    expect(showMessageBox).toHaveBeenCalledTimes(1); // reached the inform-only dialog, didn't throw out
    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ buttons: ['OK'] }));
    expect(quitAndInstall).not.toHaveBeenCalled();
    rmSync(join(USERDATA, '.update-completed'), { recursive: true, force: true });
  });
});

describe('safeErrorText', () => {
  it('returns the message for an Error', () => {
    expect(safeErrorText(new Error('nope'))).toBe('nope');
  });
  it('stringifies non-Errors', () => {
    expect(safeErrorText('plain')).toBe('plain');
    expect(safeErrorText(42)).toBe('42');
  });
  it('never throws when toString throws', () => {
    const nasty = {
      toString() {
        throw new Error('boom');
      },
    };
    expect(safeErrorText(nasty)).toBe('(unprintable error)');
  });
});
