import { app, dialog, type IpcMain } from 'electron';
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import { broadcastToAllWindows } from '../utils/window-send.js';
import { safeErrorText } from '../utils/safe-error-text.js';
import { recordAttempt, markPluginsDone, setAttemptSuccess, removeAttempt } from './post-update-ledger.js';
import { writeUpdateReady } from '../local-bridge/update-signal.js';
import { existsSync, readFileSync, rmSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'node:crypto';

// Mirror electron-updater's internal logger to disk so differential vs full
// decisions are inspectable, and sniff those log lines to derive downloadMode.
let downloadMode: 'full' | 'differential' | undefined;
const appHome = process.env.KAI_USER_DATA || join(homedir(), '.' + __BRAND_APP_SLUG);
const updateLogDir = join(appHome, 'logs');
const updateLogPath = join(updateLogDir, 'auto-update.log');
try {
  mkdirSync(updateLogDir, { recursive: true });
} catch {
  /* */
}
// electron-updater logs full feed/blockmap URLs; strip userinfo and query
// strings so signed URLs or private-feed tokens never land on disk.
const redact = (s: string): string =>
  s.replace(
    /\b(https?:\/\/)([^\s/@]+@)?([^\s?#]+)(\?[^\s#]*)?/gi,
    (_m, proto, _u, host, q) => proto + host + (q ? '?<redacted>' : ''),
  );
function logLine(level: 'info' | 'warn' | 'error', args: unknown[]): void {
  const msg = redact(args.map((a) => (a instanceof Error ? a.stack || a.message : String(a))).join(' '));
  console[level]('[auto-update]', msg);
  try {
    appendFileSync(updateLogPath, `${new Date().toISOString()} [${level}] ${msg}\n`);
  } catch {
    /* */
  }
  if (level === 'info' && /To download: /.test(msg)) downloadMode = 'differential';
  if (/fall(?:ing)? back to full download/i.test(msg)) downloadMode = 'full';
}
// Omit `debug` — electron-updater only calls it when defined, and its
// differential path would otherwise dump the full operations plan
// (tens of thousands of entries) through a synchronous appendFileSync.
autoUpdater.logger = {
  info: (...a: unknown[]) => logLine('info', a),
  warn: (...a: unknown[]) => logLine('warn', a),
  error: (...a: unknown[]) => logLine('error', a),
};

/**
 * Resolve the `updateForceSingleRange` branding mode WITHOUT assuming the Vite
 * build-time define exists. kai-platform (and any downstream) builds Kai from
 * this source with its OWN branding config; if that overlay predates / omits
 * the `updateForceSingleRange` key, `__BRAND_UPDATE_FORCE_SINGLE_RANGE` is never
 * defined and a bare reference throws `ReferenceError` at runtime — which is
 * exactly what silently disabled the delta fix on the Optum S3 feed
 * (`single-range check [registration] failed ReferenceError: ... is not
 * defined`). Guarding with `typeof` makes this default to 'auto' regardless.
 */
function brandForceSingleRangeMode(): 'auto' | 'always' | 'never' {
  try {
    if (typeof __BRAND_UPDATE_FORCE_SINGLE_RANGE !== 'undefined') {
      const v = __BRAND_UPDATE_FORCE_SINGLE_RANGE;
      if (v === 'always' || v === 'never' || v === 'auto') return v;
    }
  } catch {
    /* identifier not defined in this build — fall through to the default */
  }
  return 'auto';
}

/**
 * Whether to force single-range range requests for a GENERIC update provider,
 * driven by the `updateForceSingleRange` branding key:
 *  - 'always' → true
 *  - 'never'  → false
 *  - 'auto'   → true when the feed URL host looks like S3 (contains "s3"),
 *    which covers AWS S3 and most S3-compatible/on-prem stores that lack
 *    multipart/byteranges support. (Exported for tests.)
 */
export function shouldForceSingleRange(
  url: string | undefined,
  mode: 'auto' | 'always' | 'never' = brandForceSingleRangeMode(),
): boolean {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  if (!url) return false;
  try {
    return new URL(url).hostname.toLowerCase().includes('s3');
  } catch {
    return url.toLowerCase().includes('s3');
  }
}

/**
 * Parse the two fields we care about out of the baked `app-update.yml`
 * (`provider` + `url`). It's a tiny flat YAML we ship ourselves — a full YAML
 * parser would pull a transitive dep into the bundled main process (breaks the
 * release build; see the builder gotcha). A per-line `key: value` scan is
 * sufficient and dependency-free. Exported for tests.
 */
export function parseUpdateConfigFields(yaml: string): { provider?: string; url?: string } {
  const out: { provider?: string; url?: string } = {};
  for (const rawLine of yaml.split(/\r?\n/)) {
    const line = rawLine.trim();
    // Skip comments, list items, and nested keys (indented) — top-level scalars only.
    if (!line || line.startsWith('#') || rawLine[0] === ' ' || rawLine[0] === '\t' || rawLine[0] === '-') continue;
    const m = /^([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    // Strip surrounding quotes if present.
    const val = m[2].replace(/^['"]|['"]$/g, '');
    if (key === 'provider') out.provider = val;
    else if (key === 'url') out.url = val;
  }
  return out;
}

/**
 * Path to the baked update config, resolved the way electron-updater does
 * internally (its ElectronAppAdapter): packaged → `<resourcesPath>/app-update.yml`,
 * dev → `<appPath>/dev-app-update.yml`. NOTE: `appUpdateConfigPath` lives on
 * electron-updater's own app adapter, NOT on Electron's global `app` — reading
 * it off `app` returns undefined (the bug that silently disabled the delta fix
 * through 0.3.10x: the path was undefined → early return → setFeedURL never ran).
 * Exported for tests.
 */
export function resolveUpdateConfigPath(): string | undefined {
  try {
    if (app.isPackaged) return join(process.resourcesPath, 'app-update.yml');
    return join(app.getAppPath(), 'dev-app-update.yml');
  } catch {
    return undefined;
  }
}

/**
 * Read the baked update config synchronously and, if it's a generic S3-like
 * provider that needs it, re-issue the feed URL with `useMultipleRangeRequest:
 * false`. Idempotent + best-effort — safe to call at registration and on every
 * `update-available`. `reason` is logged so we can see WHEN it applied.
 */
function forceSingleRangeIfNeeded(reason: string): void {
  try {
    const cfgPath = resolveUpdateConfigPath();
    if (!cfgPath || !existsSync(cfgPath)) {
      logLine('info', [`single-range check [${reason}]: no update config at ${cfgPath ?? '(unresolved)'} — skipping`]);
      return;
    }
    const { provider, url } = parseUpdateConfigFields(readFileSync(cfgPath, 'utf-8'));
    if (provider !== 'generic') return; // GitHub etc. handle multi-range fine
    if (!shouldForceSingleRange(url)) {
      logLine('info', [`single-range check [${reason}]: provider=generic url host not S3-like — leaving multi-range`]);
      return;
    }
    autoUpdater.setFeedURL({
      provider: 'generic',
      url,
      useMultipleRangeRequest: false,
    } as Parameters<typeof autoUpdater.setFeedURL>[0]);
    logLine('info', [`generic provider: forcing single-range requests (useMultipleRangeRequest=false) [${reason}]`]);
  } catch (err) {
    logLine('warn', [`single-range check [${reason}] failed`, err]);
  }
}

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const INITIAL_DELAY_MS = 5_000; // 5 seconds after launch

// Set KAI_UPDATE_TEST_VERSION=0.0.1 to test the auto-updater in dev mode.
// This fakes the current version so the updater sees the latest release as new.
// Optionally set KAI_UPDATE_URL for a generic server (e.g. S3) or
// KAI_UPDATE_REPO=owner/repo to override the GitHub release source.
const DEV_TEST_VERSION = process.env.KAI_UPDATE_TEST_VERSION;
const isUpdateTestMode = !!DEV_TEST_VERSION;

if (isUpdateTestMode) {
  const updateUrl = process.env.KAI_UPDATE_URL;
  if (updateUrl) {
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: updateUrl,
      useMultipleRangeRequest: shouldForceSingleRange(updateUrl) ? false : undefined,
    } as Parameters<typeof autoUpdater.setFeedURL>[0]);
    console.info(`[auto-update] TEST MODE: faking version ${DEV_TEST_VERSION}, url ${updateUrl}`);
  } else {
    const repo = process.env.KAI_UPDATE_REPO ?? __BRAND_UPDATE_REPO;
    const [owner, repoName] = repo.split('/');
    autoUpdater.setFeedURL({ provider: 'github', owner, repo: repoName });
    console.info(`[auto-update] TEST MODE: faking version ${DEV_TEST_VERSION}, repo ${repo}`);
  }
  // Reuse the SemVer constructor from the existing currentVersion instance
  // so we get a real SemVer object without importing semver directly
  // (pnpm doesn't hoist it).
  const SemVer = (
    autoUpdater.currentVersion as unknown as { constructor: new (v: string) => typeof autoUpdater.currentVersion }
  ).constructor;
  (autoUpdater as { currentVersion: typeof autoUpdater.currentVersion }).currentVersion = new SemVer(DEV_TEST_VERSION!);
}

interface UpdateStatus {
  state: string;
  version?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  mode?: 'full' | 'differential';
  fullSize?: number;
  /** Set on a 'downloaded' broadcast that follows a DECLINED install (block /
   *  failure), so a web client — which can't see the host-native dialog and whose
   *  detached install invoke returned only a started-ack — can still surface why
   *  (R29P1). */
  error?: string;
}

function broadcast(status: UpdateStatus): void {
  broadcastToAllWindows('auto-update:status', status);
}

/**
 * Decide the download mode shown to the user from the ACTUAL bytes.
 *
 * electron-updater's logger sniff can label a download "differential" when it
 * PLANS a delta, but it may then silently fall back to downloading the full
 * file (e.g. a blockmap fetch/parse failure) — leaving a "delta" label on what
 * is really a full download. The bytes are authoritative: if the in-progress
 * total is within 2% of the known full size, it IS full regardless of the log.
 * Without a full-size reference, keep whatever the logger sniff derived.
 */
export function resolveDownloadMode(
  progressTotal: number,
  fullSize: number | undefined,
  loggerMode: 'full' | 'differential' | undefined,
): 'full' | 'differential' | undefined {
  if (fullSize && fullSize > 0) {
    return progressTotal < fullSize * 0.98 ? 'differential' : 'full';
  }
  return loggerMode;
}

/* ── Plugin Lifecycle Hook Runner ── */

export type UpdateHookRunner = {
  runPreUpdateHooks: (args: {
    version: string;
    artifactPath: string;
  }) => Promise<
    {
      rollback: (opts?: { onPluginDone?: (name: string) => void | Promise<void> }) => Promise<{ failed: string[] }>;
      stillFresh: () => boolean;
      participantNames: string[];
      postHookParticipantNames: string[];
      timedOutParticipantNames: string[];
      failedParticipantNames: string[];
    } & (
      | { decision: 'proceed' }
      | { decision: 'overridable'; reason: string }
      | { decision: 'blocked'; reason: string }
    )
  >;
  /** Names of every active plugin that has a post-update hook (participants +
   *  post-only). Recorded as an attempt's `owed` at commit so post-only plugins
   *  are still notified after a SUCCESSFUL update (R35P1). */
  getPostUpdatePluginNames: () => string[];
  /** Names of active plugins with BOTH a pre- and post-update hook — the set that
   *  could grant privileged setup then need cleanup. Recorded as a PROVISIONAL
   *  owed set BEFORE hooks run, so a crash mid-hook still leaves a revoke entry
   *  (R5P2). Optional: a runner that omits it simply skips the provisional record. */
  getSetupCapablePluginNames?: () => string[];
  /** ADD plugin names to the runtime auto-update deferral (merges, doesn't
   *  replace). Called when a rollback/teardown retains cleanup debt for specific
   *  plugins so a periodic refresh / explicit lifecycle op can't replace their
   *  generation before the user relaunches and reconciliation runs (R7). Optional
   *  — a runner that omits it just relies on the session-wide install block. */
  deferUpdates?: (names: readonly string[]) => void;
  /** FREEZE all plugin-generation replacement for the app-update window (R28P1):
   *  block the periodic required-plugin refresh AND every explicit lifecycle op
   *  from swapping/unloading a plugin after the updater sampled it but before the
   *  app quits, AND drain any lifecycle op already in flight. Async so the caller
   *  can await the drain. Paired with `unfreezePluginUpdates`. Optional — a runner
   *  that omits it just relies on the (weaker) per-participant deferral + session
   *  install block. */
  freezePluginUpdates?: () => void | Promise<void>;
  /** END the freeze started by `freezePluginUpdates`, restoring the pre-freeze
   *  deferral state. Any debt the updater still needs deferred is re-applied via a
   *  SUBSEQUENT `deferUpdates(...)` call, so this must run BEFORE those. */
  unfreezePluginUpdates?: () => void;
  // Returns which post-update hooks succeeded (per-plugin) plus an all-succeeded
  // flag. The startup reconciler clears ledger owed-state for exactly the plugins
  // that completed; the failed-install teardown uses the same signal. `opts`
  // narrows the run: `excludeNames` skips plugins already notified via the
  // rollback thunk so none is notified twice (R33P1); `onlyNames` restricts the
  // run to exactly a ledger attempt's still-owed plugins (R35P1).
  runPostUpdateHooks: (
    args: { version: string; success: boolean },
    opts?: {
      excludeNames?: readonly string[];
      onlyNames?: readonly string[];
      onPluginDone?: (name: string) => void | Promise<void>;
    },
  ) => Promise<{ allSucceeded: boolean; succeededNames: string[]; attemptedNames: string[] }>;
};

let hookRunner: UpdateHookRunner | null = null;

export function setUpdateHookRunner(runner: UpdateHookRunner): void {
  hookRunner = runner;
}

/**
 * A promise that resolves once plugins have finished loading AND the startup
 * post-update reconciliation has completed. `performQuitAndInstall` awaits it
 * before running any pre-update hook, so an install can never (a) evaluate an
 * incomplete plugin set or (b) run pre-update hooks concurrently with the
 * reconciler's post-update hooks (R35P1). Defaults to already-ready so an install
 * still works if the gate is never wired (e.g. in tests).
 */
let installReadyGate: Promise<void> = Promise.resolve();

export function setInstallReadyGate(gate: Promise<void>): void {
  installReadyGate = gate;
}

/**
 * Set when startup reconciliation could NOT persist an attempt's determined
 * outcome (a ledger write failed). While true, installs are refused: a new
 * install would create a newer version, and the still-unpersisted older attempt
 * would then recompute its outcome against that newer version and record the
 * WRONG success value (R35P1). Cleared only by a successful reconciliation on a
 * later launch. Set via `setInstallsBlockedForUnresolvedDebt`.
 */
let installsBlockedForUnresolvedDebt = false;

export function setInstallsBlockedForUnresolvedDebt(blocked: boolean): void {
  installsBlockedForUnresolvedDebt = blocked;
}

/**
 * Count of `checkForUpdates()` calls currently in flight. Used to CORRELATE a
 * global `autoUpdater` error with the install rather than an unrelated check
 * (R26P1/R26P2): message-string classification is unreliable (a genuine Squirrel
 * staging error can read "Update download failed", while a check error can read
 * anything). Instead: after we commit to quitAndInstall, an error is the
 * install's iff NO check is in flight. New checks are already suppressed while an
 * install runs (R25P2), so the only overlap is a check that began BEFORE the
 * install — this counter (settling via the check's own promise) tells us when it
 * is gone. Exported for tests.
 */
let checksInFlight = 0;

/** How long `performQuitAndInstall` waits for a pre-existing update check/download
 *  to settle before ABORTING the install (R28P4), so a post-commit error is
 *  unambiguously the install's. Bounded so a stuck/huge background download can't
 *  wedge the install forever; on timeout we abort (don't commit) and the user
 *  retries. Held on an object (not a bare `let`) so a test setter and the reader
 *  provably share the same mutable slot. */
const drainConfig = { checkDrainTimeoutMs: 10_000 };

/** Test-only: shorten the check-drain timeout so the timeout-abort path (R28P4)
 *  can be exercised without a real 10s wait. */
export function __setCheckDrainTimeoutForTests(ms: number): void {
  drainConfig.checkDrainTimeoutMs = ms;
}

/** Run `autoUpdater.checkForUpdates()` while accounting it in `checksInFlight`,
 *  so the error handler can tell a check error apart from an install error.
 *  The count spans the FULL check→download lifecycle (with autoDownload on, the
 *  check resolves while `downloadPromise` keeps running and can error later —
 *  R27P1). BUT the returned promise resolves as soon as the CHECK resolves, NOT
 *  when the download finishes: this function backs the `auto-update:check` IPC,
 *  and the web bridge times out invocations at 60s, so awaiting a full download
 *  here would make a large-but-healthy download look like a check timeout to a
 *  remote client (R28P1). We therefore decrement the counter from a DETACHED
 *  handler on the download's settle, decoupled from the caller's await. */
async function trackedCheckForUpdates(): Promise<unknown> {
  checksInFlight += 1;
  let handedOff = false; // true once the download owns the pending decrement
  try {
    const result = (await autoUpdater.checkForUpdates()) as { downloadPromise?: Promise<unknown> } | null;
    const downloadPromise = result?.downloadPromise as Promise<unknown> | undefined;
    if (downloadPromise && typeof downloadPromise.then === 'function') {
      // Hand the decrement to the download's completion so the counter stays live
      // through it, WITHOUT the caller waiting for the download.
      handedOff = true;
      void downloadPromise
        .catch(() => {}) // the global `error` handler observes failures; we only track lifecycle
        .finally(() => {
          checksInFlight -= 1;
        });
    }
    return result;
  } finally {
    // Only decrement here when there was no download to hand off to.
    if (!handedOff) checksInFlight -= 1;
  }
}

/* ── Post-Update Cleanup Ledger ──
 * Post-update cleanup state lives in an attempt-scoped, per-plugin ledger
 * (electron/ipc/post-update-ledger.ts). It replaces the old single
 * `.update-completed` marker, which a second update could overwrite while an
 * earlier attempt's cleanup was still owed, and whose retry re-ran every active
 * post-update hook rather than just the ones that hadn't completed (R35P1). */

/**
 * Surface a *broken* pre-update hook (one that threw or timed out) to the user
 * and let them decide. A native dialog is used deliberately: it works even if
 * the renderer's UpdateCard was dismissed, and it keeps the install decision in
 * the main process next to `quitAndInstall`. Returns `{ proceed }` for the
 * user's choice, or `{ proceed: false, dialogFailed: true }` if the dialog
 * itself couldn't be shown — so the caller can surface that distinctly instead
 * of it looking like a silent cancel. Exported for tests.
 */
export async function promptHookFailure(reason: string): Promise<{ proceed: boolean; dialogFailed?: boolean }> {
  try {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Plugin blocked the update',
      message: 'A plugin’s pre-update hook did not complete.',
      detail: `${reason}\n\nYou can proceed with the update anyway, or cancel and try again later.`,
      buttons: ['Proceed anyway', 'Cancel'],
      defaultId: 1, // default to the safe choice (Cancel)
      cancelId: 1,
    });
    return { proceed: response === 0 };
  } catch (err) {
    // If the dialog itself can't be shown, fail closed: DON'T proceed with an
    // install the user never confirmed. Flag it so the caller can surface a
    // distinct error rather than a silent no-op. The caller reverts to 'downloaded'.
    console.error('[auto-update] Failed to show hook-failure dialog — treating as cancel:', err);
    return { proceed: false, dialogFailed: true };
  }
}

/**
 * Surface a *deliberate* pre-update abort (a hook that intentionally returned
 * `{ abort: true }` — e.g. a migration guard). No override is offered; the
 * plugin blocked the update on purpose, so we only explain and cancel. Swallows
 * its own dialog errors — a failed info dialog must not throw into the caller
 * (which would otherwise be mis-handled as a broken hook). Returns whether the
 * dialog was ACTUALLY shown, so the caller only reports the failure as
 * `surfaced` when the user really saw it (R14P1).
 */
async function informDeliberateAbort(reason: string): Promise<boolean> {
  try {
    await dialog.showMessageBox({
      type: 'info',
      title: 'Update paused by a plugin',
      message: 'A plugin paused this update.',
      detail: `${reason}\n\nThe update is still downloaded and can be installed later.`,
      buttons: ['OK'],
      defaultId: 0,
      cancelId: 0,
    });
    return true;
  } catch (err) {
    console.error('[auto-update] Failed to show deliberate-abort dialog:', err);
    return false;
  }
}

/**
 * Install the downloaded update.
 *
 * Flow:
 * 1. Run pre-update hooks (e.g., elevate to admin via Privileges.app)
 * 2. Write a marker file so post-update hooks fire after relaunch
 * 3. Delegate to autoUpdater.quitAndInstall() (Squirrel.Mac handles
 *    extract + replace + relaunch atomically)
 */
export async function performQuitAndInstall(opts?: {
  suppressDialogs?: boolean;
}): Promise<{ ok: boolean; error?: string; surfaced?: boolean }> {
  // Guard: never run pre-update hooks, write the post-update marker, or call
  // quitAndInstall unless an update actually finished downloading. Invoking this
  // prematurely (e.g. a stray auto-update:install IPC) would write a spurious
  // marker and hand a non-existent artifact to the installer.
  if (!downloaded || !downloadedVersion || !downloadedFilePath) {
    console.warn('[auto-update] performQuitAndInstall called with no downloaded update — ignoring');
    return { ok: false, error: 'No update has been downloaded yet' };
  }

  // One-shot per session (R25P1): a committed install that failed asynchronously
  // leaves electron-updater's native MacUpdater listener installed. Retrying
  // in-process would stack another listener and risk a double native install, so
  // we refuse and ask the user to relaunch — the next launch re-checks cleanly.
  if (installFailedThisSession) {
    console.warn('[auto-update] a previous install failed this session — requiring relaunch before retry');
    return {
      ok: false,
      error: 'The update could not be installed. Please quit and reopen the app, then try again.',
    };
  }

  // Capture the artifact identity at entry. Pre-update hooks + dialogs can await
  // for minutes, during which a concurrent periodic checkForUpdates could finish
  // downloading a DIFFERENT version and overwrite these module globals. Writing
  // the marker / installing off the mutated globals would install an artifact the
  // hooks (and the user) never approved (R9P2). We install off these locals and,
  // just before the point of no return, revalidate the globals still match.
  const installVersion = downloadedVersion;
  const installFilePath = downloadedFilePath;
  // Unique id for THIS attempt's ledger record (so a later attempt can't
  // overwrite this one's owed cleanup — R35P1).
  const attemptId = randomUUID();

  // Rollback + revert are hoisted to function scope so EVERY non-proceed exit
  // (cancel, deliberate block, and the swapped-artifact abort at the install
  // site) uses the same path: roll back completed setup, clear the guard, and
  // return to a retryable 'downloaded' state.
  //
  // `rollbackHooks` is bound to the exact plugin instances that participated
  // this attempt (immune to concurrent reloads); a no-op until the runner
  // returns, so a runner-level throw rolls back nothing rather than firing
  // spurious cleanup. `revert` runs it at most once, best-effort, and ALWAYS
  // clears the guard + broadcasts in a finally (guard cleared before broadcast,
  // so a throwing broadcast can't latch 'preparing').
  let rollbackHooks: (opts?: {
    onPluginDone?: (name: string) => void | Promise<void>;
  }) => Promise<{ failed: string[] }> = async () => ({
    failed: [],
  });
  // Names of plugins whose pre-update hooks participated (rollback notifies them);
  // the committed-failure teardown excludes them from the all-active post-only
  // notify so none is notified twice (R33P1).
  let participantNames: string[] = [];
  // Subset of participants that captured ≥1 post-update hook — the cleanup that is
  // actually owed. Used (∪ post-only plugins) as the attempt's `owed` so a
  // hookless participant isn't owed forever (R35P1).
  let postHookParticipantNames: string[] = [];
  // Participants whose pre-update hook TIMED OUT (may still be running / applying
  // setup). Unioned into the committed `owed` so their cleanup is reconciled next
  // launch even if they never registered a post-hook (R8P1).
  let timedOutParticipantNames: string[] = [];
  // Participants whose pre-update hook FAILED (threw / failed:true), possibly after
  // partial setup and without registering a post-hook. Unioned into the committed
  // `owed` so their setup is reconciled even though they're hookless (R28P18).
  let failedParticipantNames: string[] = [];
  // The PROVISIONAL ledger attempt (owed = setup-capable plugins) recorded before
  // pre-update hooks run, so a crash mid-hook still yields a next-launch revoke
  // (R5P2). revert() rewrites the attempt's owed to the exact failed set.
  let provisionalAttemptRecorded = false;
  // The exact owed set recorded on the provisional attempt (setup-capable
  // plugins). Kept so that if a ledger CHECKPOINT write FAILS during revert — the
  // cleanup ran but couldn't be recorded done — we can conservatively defer the
  // WHOLE provisional set, since we can't know which entries actually cleared on
  // disk (R7P2).
  let provisionalOwedSnapshot: string[] = [];
  // Set if `runPreUpdateHooks` REJECTED (runner-level throw, not a hook result):
  // we then have no rollback/participant metadata and can't know what setup ran,
  // so revert() keeps the WHOLE provisional owed set rather than dropping it (R8P2).
  let runnerRejected = false;
  // Tracks whether we engaged the plugin-generation freeze (R28P1) so unfreeze is
  // idempotent and runs on exactly the non-quit exit paths.
  let pluginUpdatesFrozen = false;
  /** Lift the plugin-generation freeze if engaged (idempotent). MUST run before
   *  any `deferUpdates(...)` on an abort path so retained debt is layered on top
   *  of the restored deferral snapshot, not clobbered by it (R28P1). */
  const unfreezePluginUpdates = (): void => {
    if (!pluginUpdatesFrozen) return;
    pluginUpdatesFrozen = false;
    try {
      hookRunner?.unfreezePluginUpdates?.();
    } catch (e) {
      console.error('[auto-update] unfreezePluginUpdates threw:', e);
    }
  };
  // Rechecks (at install time) that the active plugin generation still matches
  // what the pre-update hooks evaluated — the override dialog may have been open
  // long enough for a plugin to activate (R12P1). Defaults to fresh (no hooks).
  let pluginsStillFresh: () => boolean = () => true;
  let rolledBack = false;
  // Returns true if rollback cleanup fully succeeded, false if it failed (a debt
  // entry was persisted). Callers use this to surface a cancel/block that left
  // cleanup incomplete rather than reporting a clean no-op (R32P1).
  const revert = async (): Promise<boolean> => {
    if (rolledBack) {
      installInProgress = false;
      broadcast({ state: 'downloaded', version: downloadedVersion });
      return true;
    }
    rolledBack = true;
    // NOTE: the plugin-generation freeze is deliberately HELD through the rollback
    // + ledger-checkpoint work below (R28P1). Releasing it here would let a
    // concurrent disable/update/uninstall tear down a participant whose async
    // cleanup hook is still running. It is lifted only AFTER cleanup settles — and,
    // on the incomplete path, only right before the still-owed names are re-deferred
    // so those survive the snapshot restore (see below).
    let ok = true;
    let checkpointFailed = false;
    // A PROVISIONAL attempt was recorded before the hooks ran (owed = setup-capable
    // plugins), so the cleanup debt is ALREADY on disk — a crash during rollback
    // still leaves a next-launch revoke (R5P2). We now run rollback and RECONCILE
    // that provisional: clear every provisional-owed plugin EXCEPT the participants
    // whose cleanup failed. Non-participants (in the superset but never ran setup)
    // owe nothing → cleared; succeeded participants → cleared; failed participants
    // → stay owed. If no provisional exists (no setup-capable plugins) we fall back
    // to recording debt only for failed participants that captured a cleanup hook.
    let failed: string[];
    // BEFORE running rollback, durably NARROW the provisional owed set (recorded as
    // the setup-capable SUPERSET before hooks ran) down to the plugins that ACTUALLY
    // PARTICIPATED (R28P23). A setup-capable plugin that never ran — e.g. because an
    // earlier plugin returned a terminal block, so its pre-hook was skipped — did NO
    // setup, so it owes nothing. Leaving it in the provisional means the per-plugin
    // `onPluginDone` narrowing during rollback transiently leaves IT owed with
    // success:false; a crash in that window would run its spurious cleanup next
    // launch. Narrowing up front removes it durably first. We keep the WHOLE
    // superset only when the runner REJECTED (we then don't have a trustworthy
    // participant set), or when the narrowing write itself fails.
    if (provisionalAttemptRecorded && !runnerRejected) {
      const trueParticipants = [...new Set(participantNames)];
      if (trueParticipants.length > 0) {
        if (
          !recordAttempt({
            id: attemptId,
            version: installVersion,
            fromVersion: app.getVersion(),
            owed: trueParticipants,
            success: false,
          })
        ) {
          console.error('[auto-update] Could not narrow provisional owed to participants — retaining superset (safe).');
          checkpointFailed = true;
        }
      } else if (!removeAttempt(attemptId)) {
        // No participants at all (every setup-capable plugin was skipped) → nothing
        // owed. Drop the provisional; a write failure is reconciled harmlessly next
        // launch (empty-owed modern attempt is dropped by the reconciler).
        checkpointFailed = true;
      }
    }
    try {
      const rb =
        typeof rollbackHooks === 'function'
          ? await rollbackHooks({
              // Clear each participant's provisional-owed entry the moment its
              // cleanup succeeds (crash-safety). Only meaningful when a provisional
              // entry exists on disk.
              onPluginDone: provisionalAttemptRecorded
                ? (name) => {
                    if (!markPluginsDone(attemptId, [name])) checkpointFailed = true;
                  }
                : undefined,
            })
          : { failed: [] as string[] };
      failed = Array.isArray(rb?.failed) ? rb.failed : [];
    } catch (err) {
      console.error(
        '[auto-update] Rollback thunk threw unexpectedly — treating all participant cleanup as failed:',
        err,
      );
      failed = [...postHookParticipantNames];
    }

    if (provisionalAttemptRecorded) {
      // After rollback, the ONLY plugins still owing cleanup are the ones whose
      // cleanup FAILED. Everything else — succeeded participants AND the
      // superset's non-participants (never set up) — owes nothing. Rewrite the
      // attempt's owed to EXACTLY the failed set (or drop it when none failed).
      // Using the failed set directly (not `provisionalOwed − failed`) means a
      // plugin that registered its cleanup DURING the run and then failed — and so
      // is absent from `provisionalOwed` — is still retained, not lost (R6P1).
      //
      // EXCEPTION: if the RUNNER itself rejected, we have no reliable `failed`
      // set and don't know what setup ran, so retain the WHOLE provisional owed
      // set rather than dropping it (R8P2).
      const uniqueFailed = runnerRejected ? [...provisionalOwedSnapshot] : [...new Set(failed)];
      if (uniqueFailed.length > 0) {
        const recorded = recordAttempt({
          id: attemptId,
          version: installVersion,
          fromVersion: app.getVersion(),
          owed: uniqueFailed,
          success: false,
        });
        if (!recorded) {
          console.error('[auto-update] Could not persist failed-cleanup debt after rollback.');
          checkpointFailed = true;
        }
        console.error(
          '[auto-update] Rollback cleanup incomplete — cleanup debt retained for next launch:',
          uniqueFailed,
        );
        ok = false;
      } else if (!removeAttempt(attemptId)) {
        // Clean rollback → drop the provisional entirely. A write failure here
        // leaves a stale (but success:false, owed=setup-capable) attempt that a
        // later launch reconciles harmlessly; still report incomplete.
        checkpointFailed = true;
      } else {
        // The final removeAttempt SUCCEEDED — the attempt is now durably gone from
        // the ledger. That authoritative empty state SUPERSEDES any earlier
        // transient per-plugin checkpoint (`onPluginDone` → markPluginsDone) failure
        // recorded above: there is no owed debt left, so we must NOT keep reporting
        // incomplete and blocking installs on a ledger that is already clean (R28P10).
        checkpointFailed = false;
      }
    } else {
      // No provisional (nothing setup-capable). Record debt only if a participant
      // that captured a cleanup hook actually failed to clean up.
      const failedOwed = [...new Set(postHookParticipantNames.filter((n) => failed.includes(n)))];
      if (failedOwed.length > 0) {
        const recorded = recordAttempt({
          id: attemptId,
          version: installVersion,
          fromVersion: app.getVersion(),
          owed: failedOwed,
          success: false,
        });
        if (!recorded) console.error('[auto-update] Could not persist cleanup debt after rollback failure.');
        ok = false;
      }
    }
    if (checkpointFailed) {
      console.error('[auto-update] Could not persist rollback completion to the ledger — reporting incomplete.');
      ok = false;
    }
    // Rollback + ledger checkpointing are DONE — the participants' cleanup hooks
    // have finished running. NOW it is safe to lift the freeze (R28P1). Doing it
    // here (before the retained-debt deferral below) restores the pre-freeze
    // snapshot first, so the `deferUpdates(retained)` that follows layers the
    // still-owed names on top rather than being clobbered by the restore.
    unfreezePluginUpdates();
    if (!ok) {
      // Rollback left privileged / possibly non-idempotent setup active (a cleanup
      // hook failed, or its completion couldn't be persisted). BLOCK further
      // installs this session: a second click would rerun pre-update hooks on top
      // of that dirty state. The user must relaunch — the next launch's startup
      // reconciliation runs the owed cleanup from the ledger (R4P1).
      installsBlockedForUnresolvedDebt = true;
      // DEFER the plugins whose cleanup is still owed so a periodic required-plugin
      // refresh / explicit lifecycle op can't replace their generation before
      // relaunch+reconcile (R7). `failed` covers the hook-failure case. If a ledger
      // CHECKPOINT WRITE failed (cleanup ran but couldn't be recorded done), we
      // can't know which entries actually cleared on disk — conservatively defer
      // the WHOLE provisional owed snapshot ∪ participants (R7P2).
      const retained =
        checkpointFailed || runnerRejected
          ? [...new Set([...failed, ...provisionalOwedSnapshot, ...participantNames, ...postHookParticipantNames])]
          : [...new Set(failed)];
      if (retained.length > 0) {
        try {
          hookRunner?.deferUpdates?.(retained);
        } catch (e) {
          console.error('[auto-update] deferUpdates after rollback failure threw:', e);
        }
      }
    }
    installInProgress = false;
    // Broadcast the CURRENTLY staged version, not the captured installVersion: if a
    // concurrent download swapped the artifact, `downloadedVersion` now reflects the
    // newer staged build the next attempt will install, so the card must show that —
    // not the version we just declined (R10P2).
    broadcast({ state: 'downloaded', version: downloadedVersion });
    return ok;
  };

  // Re-entrancy guard: multiple install calls could otherwise pass the guard
  // above and run elevation hooks / quitAndInstall more than once (accumulating
  // native Squirrel listeners on macOS). Only the first attempt proceeds. A
  // duplicate request (double-click, or renderer + menu both firing) is a benign
  // no-op — the first attempt is still valid — so return a SUCCESS result, not an
  // error, otherwise the UpdateCard/menu would show a false failure (R22P2).
  if (installInProgress) {
    console.warn('[auto-update] install already in progress — ignoring duplicate performQuitAndInstall');
    return { ok: true };
  }
  installInProgress = true;

  // Broadcast 'preparing' BEFORE awaiting the gate: startup reconciliation can
  // take minutes (a post-update hook per owed plugin), and without this the card
  // would sit on 'downloaded' with an enabled button — duplicate clicks look
  // successful (they no-op on the re-entrancy guard) but the UI never changes
  // (R4P1). 'preparing' disables the button and shows progress; if the gate later
  // refuses the install we restore 'downloaded' (with an error) on the way out.
  broadcast({ state: 'preparing', version: installVersion });

  // Wait until plugins have loaded AND startup post-update reconciliation has
  // finished before touching pre-update hooks: an install before loadAll() would
  // see an incomplete plugin set (missing a veto/elevation hook), and one during
  // reconciliation would run pre-update hooks concurrently with the reconciler's
  // post-update hooks on the same plugins (R35P1). The re-entrancy guard is
  // already set, so a duplicate call during this await is still a benign no-op.
  await installReadyGate;

  // Drain any update CHECK/DOWNLOAD that began before this install (a background
  // auto-check whose download is still running). New checks are already refused
  // while an install is in progress (the `installInProgress` gate on
  // `auto-update:check`), so only a pre-existing one can still be live here. If we
  // committed while it's in flight, an error it emits on the shared global channel
  // AFTER we quitAndInstall is indistinguishable from a genuine install failure —
  // so the error handler conservatively SKIPS teardown, leaving the UI latched on
  // 'restarting' with no feedback (R28P1). We therefore wait for it to settle, and
  // if it does NOT drain within the bounded window we ABORT this install rather
  // than commit into that ambiguity (R28P4): committing would risk the exact latch
  // (frozen plugins + active setup + stuck UI). The user simply retries once the
  // background download settles — no setup has run yet (we're before the hooks).
  if (checksInFlight > 0) {
    // Use a MONOTONIC clock (performance.now) not Date.now: tests freeze the wall
    // clock via vi.setSystemTime, which would make a Date-based deadline never
    // elapse and hang the drain. performance.now is unaffected and is the correct
    // clock for measuring elapsed time anyway.
    const drainDeadline = performance.now() + drainConfig.checkDrainTimeoutMs;
    while (checksInFlight > 0 && performance.now() < drainDeadline) {
      // Poll in small steps, never overshooting the deadline, so a short timeout
      // (tests) is respected promptly and a long one still polls responsively.
      const remaining = drainDeadline - performance.now();
      await new Promise((r) => setTimeout(r, Math.max(1, Math.min(50, remaining))));
    }
    if (checksInFlight > 0) {
      installInProgress = false;
      console.warn(
        '[auto-update] A pre-existing update check did not drain in time — aborting install to avoid an ambiguous post-commit error.',
      );
      if (downloaded) broadcast({ state: 'downloaded', version: downloadedVersion });
      return {
        ok: false,
        error: 'An update check is still finishing. Please try again in a moment.',
      };
    }
  }

  // Refuse if an earlier update attempt's outcome could not be persisted this
  // launch (a ledger write failed). Installing now would advance the version and
  // make that unresolved attempt recompute its outcome against the NEW version —
  // recording the wrong success value for its post-update hooks (R35P1). The user
  // relaunches (or the next launch's reconciliation persists it) and can retry.
  if (installsBlockedForUnresolvedDebt) {
    installInProgress = false;
    console.warn(
      '[auto-update] refusing install — a prior update attempt has unpersisted cleanup state; relaunch required.',
    );
    // Restore the card out of 'preparing' so the button isn't stuck disabled.
    if (downloaded) broadcast({ state: 'downloaded', version: downloadedVersion });
    return {
      ok: false,
      error: 'A previous update is still being finalized. Please quit and reopen the app, then try again.',
    };
  }

  // Re-validate the download after the gate: a concurrent flow (or the wait
  // itself spanning a state change) could have cleared the staged artifact.
  if (!downloaded || !downloadedVersion || !downloadedFilePath) {
    installInProgress = false;
    return { ok: false, error: 'No update has been downloaded yet' };
  }
  // Re-validate the ARTIFACT IDENTITY after the check-drain (R28P22): a pre-existing
  // check we drained may have finished downloading a DIFFERENT version, replacing
  // the staged artifact. `installVersion`/`installFilePath` were captured at entry,
  // before the drain — proceeding now would freeze plugins and run setup hooks
  // against a stale artifact only to abort at the point-of-no-return revalidation.
  // Bail here instead, BEFORE any freeze/hook side-effects. The freshly-downloaded
  // version installs on a subsequent, properly-vetted attempt.
  if (downloadedVersion !== installVersion || downloadedFilePath !== installFilePath) {
    installInProgress = false;
    console.warn(
      `[auto-update] Staged artifact changed during check-drain (was ${installVersion}, now ${downloadedVersion ?? 'none'}) — aborting before setup.`,
    );
    broadcast({ state: 'downloaded', version: downloadedVersion });
    return { ok: false, error: 'A newer update finished downloading — please install again.' };
  }
  // Run pre-update hooks (e.g., elevate to admin)
  if (hookRunner) {
    // Capture in a stable local: `hookRunner` is a mutable module-level var, so
    // its narrowing from the `if` above doesn't flow into the async closures
    // below (TS18047). This const is guaranteed non-null here.
    const runner = hookRunner;

    // FREEZE plugin-generation replacement for the whole install window BEFORE we
    // even enumerate the setup-capable set (R28P1). Doing it first closes the
    // window where a concurrent marketplace update/uninstall could swap or unload
    // a participant AFTER we sample it but before the app quits — which would
    // strand its pre-update setup or run cleanup against the wrong generation.
    // `pluginUpdatesFrozen` drives unfreeze on every non-quit exit below; the
    // happy path never unfreezes (the process exits at quitAndInstall).
    //
    // A THROW here means the freeze could not DRAIN in-flight lifecycle work within
    // its bounded window (a hung install/unload). We must NOT proceed: continuing
    // would run the whole update while a generation swap is possibly still in
    // flight, and the partial freeze (deferAllUpdates already set) would otherwise
    // stay latched. ABORT cleanly — mark engaged so we lift the partial freeze,
    // then unfreeze + clear the guard and return an error (R28P11). No setup has run
    // yet (we're before the hooks), so there is nothing to roll back.
    try {
      await runner.freezePluginUpdates?.();
      pluginUpdatesFrozen = true;
    } catch (e) {
      console.error(
        '[auto-update] freezePluginUpdates could not drain in-flight lifecycle work — aborting install:',
        e,
      );
      pluginUpdatesFrozen = true; // deferAllUpdates may be set → ensure it's lifted
      installInProgress = false;
      unfreezePluginUpdates();
      if (downloaded) broadcast({ state: 'downloaded', version: downloadedVersion });
      return {
        ok: false,
        error: 'A plugin operation is still finishing. Please try again in a moment.',
      };
    }

    // PROVISIONAL ledger entry BEFORE running any pre-update hook: a hook can
    // grant privileged setup (elevation) and the process could crash/force-quit
    // between that and the commit below — with no ledger entry, next launch would
    // never revoke it. Record the setup-capable plugins (pre+post hook) as owed
    // with success:false so a crash mid-hook still yields a next-launch revoke
    // (R5P2). Refined to the true participant set at commit; removed on a clean
    // no-op cancel. If it can't be persisted, abort before doing any setup — we
    // can't guarantee cleanup otherwise.
    let provisionalRecorded = false;
    try {
      const setupCapable = runner.getSetupCapablePluginNames ? runner.getSetupCapablePluginNames() : [];
      if (setupCapable.length > 0) {
        provisionalRecorded = recordAttempt({
          id: attemptId,
          version: installVersion,
          fromVersion: app.getVersion(),
          owed: setupCapable,
          success: false,
        });
        if (!provisionalRecorded) {
          installInProgress = false;
          unfreezePluginUpdates();
          console.error(
            '[auto-update] Could not record provisional cleanup ledger entry — aborting before running setup hooks.',
          );
          if (downloaded) broadcast({ state: 'downloaded', version: downloadedVersion });
          return { ok: false, error: 'The update could not be prepared safely. Please try again.' };
        }
        provisionalOwedSnapshot = setupCapable;
      }
    } catch (e) {
      console.error('[auto-update] Provisional ledger record threw — aborting before setup hooks:', e);
      installInProgress = false;
      unfreezePluginUpdates();
      if (downloaded) broadcast({ state: 'downloaded', version: downloadedVersion });
      return { ok: false, error: 'The update could not be prepared safely. Please try again.' };
    }
    // Track it so revert() (clean abort) can drop the provisional if no participant
    // actually owes cleanup.
    provisionalAttemptRecorded = provisionalRecorded;

    broadcast({ state: 'preparing', version: installVersion });

    // Step 1 — run the hooks. The try/catch scopes ONLY hook execution: a throw
    // here (or from the timeout race) is normalized into a `decision`. Crucially,
    // the user-facing dialogs are NOT inside this catch — otherwise a dialog that
    // rejected on the deliberate-abort path would fall into the "broken hook"
    // handler and wrongly offer "Proceed anyway", inverting the user's choice,
    // and a second dialog failure would leave `installInProgress` latched.
    //
    // The runner (PluginManager.runPreUpdateHooks) runs EVERY plugin's hooks,
    // bounds EACH one with its own timeout, and collapses them with the correct
    // precedence (a deliberate block from any plugin outranks any failure). It is
    // therefore guaranteed to settle in bounded time, so we consume its decision
    // directly — NO outer aggregate timer. A single outer timer here was wrong:
    // with N hooks each allowed 5m, a legitimate multi-hook run would trip a
    // fixed outer budget and get abandoned mid-flight (R4P2). A throw from the
    // runner itself is still normalized as an overridable failure below.
    type HookDecision =
      | { kind: 'proceed' } // hooks passed cleanly — install
      | { kind: 'overridable'; reason: string } // failure (threw / timed out / opted-in) — prompt, override allowed
      | { kind: 'blocked'; reason: string }; // deliberate abort from some plugin — inform only, no override
    let decision: HookDecision;
    try {
      const result = await runner.runPreUpdateHooks({
        version: installVersion,
        artifactPath: installFilePath,
      });
      rollbackHooks = result.rollback;
      pluginsStillFresh = result.stillFresh;
      participantNames = result.participantNames ?? [];
      postHookParticipantNames = result.postHookParticipantNames ?? [];
      timedOutParticipantNames = result.timedOutParticipantNames ?? [];
      failedParticipantNames = result.failedParticipantNames ?? [];
      decision =
        result.decision === 'proceed'
          ? { kind: 'proceed' }
          : result.decision === 'blocked'
            ? { kind: 'blocked', reason: result.reason }
            : { kind: 'overridable', reason: result.reason };
    } catch (err) {
      // A throw from the runner ITSELF (not a hook) — the runner is designed to
      // collapse every hook outcome internally and settle without rejecting, so a
      // rejection here means it failed BEFORE producing an aggregate result. We
      // therefore have NO proof that some not-yet-visited plugin didn't hold a
      // DELIBERATE (non-overridable) veto, and no rollback/freshness metadata. Fail
      // CLOSED: treat it as BLOCKED (inform-only, NO "Proceed anyway"), not
      // overridable — offering an override could install past an unvisited veto
      // (R28P2). safeErrorText never throws (a plugin can throw an object with a
      // throwing toString), so this normalization can't escape the catch.
      console.error('[auto-update] Pre-update hook runner threw — failing closed (no override):', err);
      decision = { kind: 'blocked', reason: `The plugin update checks could not complete: ${safeErrorText(err)}` };
      // The runner rejected before returning its rollback/participant metadata, so
      // we DON'T know what setup already ran. A plugin's hook may have elevated
      // before the runner threw. Mark this so revert() KEEPS the whole provisional
      // owed set (recorded before hooks ran) instead of dropping it as a clean
      // no-op — otherwise that setup would be stranded with no next-launch revoke
      // (R8P2).
      runnerRejected = true;
    }

    // Step 2 — act on the decision. Dialogs live here, OUTSIDE the hook catch.
    // Each dialog is itself fail-closed (see promptHookFailure/informDeliberateAbort),
    // so a dialog that throws can never accidentally proceed or latch the guard.
    if (decision.kind === 'blocked') {
      console.info('[auto-update] Pre-update hook deliberately aborted install:', decision.reason);
      // Roll back BEFORE showing the (informational, OK-only) dialog: the install
      // is already cancelled, and the dialog can sit open indefinitely if the
      // user is away. Undoing setup first means elevation/etc. isn't left active
      // for the lifetime of an unattended dialog. `revert()` clears the guard and
      // broadcasts 'downloaded' in its finally, so state is already correct when
      // the dialog is dismissed.
      const cleanupOk = await revert();
      // If cleanup FAILED, augment the reason so the user learns setup may still
      // be partially active and to relaunch — not just that a plugin blocked it
      // (R32P2). A debt marker was persisted by revert() for next-launch retry.
      const reason = cleanupOk
        ? decision.reason
        : `${decision.reason} Some cleanup did not complete — please relaunch the app.`;
      if (opts?.suppressDialogs) {
        // Web-bridge caller: no host-native dialog (the remote user can't see it).
        // Return the reason so the web UI surfaces it inline (R19P1).
        return { ok: false, error: reason };
      }
      const shown = await informDeliberateAbort(reason);
      // Only claim `surfaced` if the dialog was ACTUALLY shown (R14P1). If it
      // failed to display, leave surfaced falsy so the renderer/menu fall back to
      // their own error surface — otherwise the user would get no explanation.
      return { ok: false, error: reason, surfaced: shown };
    }
    if (decision.kind === 'overridable') {
      if (opts?.suppressDialogs) {
        // Web-bridge caller: we can't raise a host-native Proceed/Cancel prompt a
        // remote user could answer, and must not block the bridge on it (R19P1).
        // Fail closed — do not install without consent — and return the reason
        // for the web UI to surface. The user can retry from a desktop surface.
        const cleanupOk = await revert();
        return {
          ok: false,
          error: cleanupOk
            ? decision.reason
            : `${decision.reason} Some cleanup did not complete — please relaunch the app.`,
        };
      }
      // Prompt FIRST here (unlike the blocked path): the user may choose Proceed,
      // in which case we must NOT roll back. Only revert on cancel.
      const { proceed, dialogFailed } = await promptHookFailure(decision.reason);
      if (!proceed) {
        const cleanupOk = await revert();
        // A user cancel is normally a successful no-op. But if rollback cleanup
        // FAILED (a debt marker was persisted for next launch), surface that so
        // the user knows setup may still be partially active (R32P1). A dialog
        // that FAILED to show is likewise surfaced.
        if (dialogFailed) {
          return { ok: false, error: 'Could not show the update confirmation dialog. Please try again.' };
        }
        if (!cleanupOk) {
          return { ok: false, error: 'The update was cancelled but some cleanup did not complete. Please relaunch.' };
        }
        return { ok: true };
      }
      // fall through to install (user chose to proceed anyway)
    }
    // decision.kind === 'proceed' → fall through to install
  }

  // Point-of-no-return revalidation (R12P1): the override dialog may have been
  // open long enough for a plugin to activate/reload after the runner's own
  // generation check. Re-check freshness here; if the active plugin set changed,
  // its veto/setup hooks were never evaluated — fail closed and roll back.
  if (typeof pluginsStillFresh === 'function' && !pluginsStillFresh()) {
    console.warn('[auto-update] Active plugin set changed while awaiting the install decision — aborting.');
    const cleanupOk = await revert();
    return {
      ok: false,
      error: cleanupOk
        ? 'The set of installed plugins changed. Please install again.'
        : 'The set of installed plugins changed and some cleanup did not complete. Please relaunch the app.',
    };
  }

  // Point-of-no-return revalidation (R9P2): if a concurrent periodic download
  // replaced the staged artifact while our hooks/dialogs were awaiting, the
  // module globals no longer match what we vetted. Do NOT install the swapped
  // artifact — abort this attempt, clear the guard, and leave the freshly
  // downloaded version to be installed by a subsequent, properly-vetted attempt.
  if (downloadedVersion !== installVersion || downloadedFilePath !== installFilePath) {
    console.warn(
      `[auto-update] Staged artifact changed during pre-update hooks (was ${installVersion}, now ${downloadedVersion ?? 'none'}) — aborting this install attempt.`,
    );
    // Same rollback path as cancel/block: any completed setup (e.g. elevation)
    // must be undone even though we're aborting because the artifact changed.
    const cleanupOk = await revert();
    return {
      ok: false,
      error: cleanupOk
        ? 'A newer update finished downloading — please install again.'
        : 'A newer update finished downloading, and some cleanup did not complete. Please relaunch the app.',
    };
  }

  // Record this attempt in the post-update ledger so post-update hooks (e.g.
  // revoking admin elevation a pre-update hook granted, or a post-only plugin
  // reacting to the new version) reliably run after relaunch. `owed` is EVERY
  // active plugin with a post-update hook — participants AND post-only ones — so a
  // successful update still notifies post-only plugins (R35P1); without the union
  // they'd be silently skipped. If it CANNOT be recorded we must NOT proceed: a
  // successful relaunch would then have no ledger entry, silently leaving setup
  // active (R27P2). Roll back + abort; the update stays downloaded and installable
  // once the ledger can be written.
  // `owed` = every plugin that actually has post-update cleanup to run:
  //   • post-only plugins + participants whose hook is live now (getPostUpdatePluginNames), ∪
  //   • participants that CAPTURED a post-hook during their pre-hook even if a
  //     concurrent unload later hid it from the live array (postHookParticipantNames).
  // Deliberately EXCLUDES participants with no post-update hook — owing them would
  // strand the attempt forever, since reconciliation refuses to clear a hookless
  // plugin (R35P1). If the enumeration throws, fall back to the captured subset.
  let owedAtCommit: string[];
  try {
    const postOnly = hookRunner ? hookRunner.getPostUpdatePluginNames() : [];
    // Union timed-out participants too: their hook may still be running and apply
    // setup after we proceed, so their cleanup must be owed even if they have no
    // registered post-hook yet (R8P1). Also union FAILED participants (threw /
    // failed:true): they may have applied partial setup before failing, again
    // possibly without a post-hook (R28P18). Owing a hookless plugin no longer
    // strands the attempt forever — reconciliation counts an un-attemptable owed
    // plugin as incomplete and the give-up cap eventually drops it (R28P8).
    owedAtCommit = [
      ...new Set([...postHookParticipantNames, ...postOnly, ...timedOutParticipantNames, ...failedParticipantNames]),
    ];
  } catch (e) {
    console.error('[auto-update] Could not enumerate post-update plugins — falling back to captured participants:', e);
    owedAtCommit = [...new Set([...postHookParticipantNames, ...timedOutParticipantNames, ...failedParticipantNames])];
  }
  // Nothing owed → no cleanup to reconcile after a SUCCESSFUL relaunch. But if there
  // were PARTICIPANTS (plugins whose pre-update hooks ran), we still record a durable
  // FAILURE-ONLY entry carrying `participants` with `owed:[]` (R28P38): a hookless-at-
  // commit participant can register cleanup after commit, and if the install then
  // fails AND the teardown's own ledger-widening write fails, this commit-time record
  // — written while the ledger was writable — is the only durable trace. On a
  // SUCCESSFUL relaunch it's harmless: a modern attempt with empty `owed` is dropped
  // (participants are consulted ONLY when success===false). With NO participants at
  // all there's genuinely nothing to track → drop any provisional and proceed.
  if (owedAtCommit.length === 0) {
    if (participantNames.length > 0) {
      // Durable failure-only record. Replaces the provisional (same id) with owed:[]
      // + participants; on success it's dropped, on failure it seeds reconcile.
      let recorded = false;
      try {
        recorded = recordAttempt({
          id: attemptId,
          version: installVersion,
          fromVersion: app.getVersion(),
          owed: [],
          participants: [...new Set(participantNames)],
        });
      } catch (e) {
        console.error('[auto-update] recordAttempt (participants-only) threw at commit — aborting install:', e);
      }
      if (!recorded) {
        console.error(
          '[auto-update] Could not record participants-only ledger entry — aborting install to preserve the cleanup guarantee.',
        );
        const cleanupOk = await revert();
        return {
          ok: false,
          error: cleanupOk
            ? 'The update could not be prepared safely. Please try again.'
            : 'The update could not be prepared safely and some cleanup did not complete. Please relaunch the app.',
        };
      }
    } else if (provisionalAttemptRecorded) {
      // No participants AND a provisional exists (setup-capable plugins existed but
      // none participated) → drop it. If we DON'T, next launch reads that stale
      // entry as a real, un-reconciled attempt: it blocks installs, and (worse) its
      // persisted `success:false` misrepresents what will be a SUCCESSFUL install
      // (R9P2/R28P1). A failure to drop is NOT harmless → abort + roll back.
      let dropped = false;
      try {
        dropped = removeAttempt(attemptId);
      } catch (e) {
        console.error('[auto-update] Dropping empty provisional ledger entry threw:', e);
      }
      if (!dropped) {
        console.error(
          '[auto-update] Could not drop empty provisional ledger entry — aborting install to avoid a stale success:false record.',
        );
        const cleanupOk = await revert();
        return {
          ok: false,
          error: cleanupOk
            ? 'The update could not be prepared safely. Please try again.'
            : 'The update could not be prepared safely and some cleanup did not complete. Please relaunch the app.',
        };
      }
    }
  } else {
    // Record the committed owed set. `recordAttempt` returns false on a write
    // failure (already handled), but wrap it defensively (R28P34): an UNEXPECTED
    // throw here would otherwise escape performQuitAndInstall WITHOUT rolling back —
    // leaving installInProgress + the plugin freeze latched. Route any throw through
    // the same abort+revert path as a false return.
    let recorded = false;
    try {
      recorded = recordAttempt({
        id: attemptId,
        version: installVersion,
        fromVersion: app.getVersion(),
        owed: owedAtCommit,
        // Durable full participant list for the failure path (R28P38).
        participants: [...new Set(participantNames)],
      });
    } catch (e) {
      console.error('[auto-update] recordAttempt threw unexpectedly at commit — aborting install:', e);
    }
    if (!recorded) {
      console.error(
        '[auto-update] Could not record post-update ledger entry — aborting install to preserve cleanup guarantee.',
      );
      const cleanupOk = await revert();
      return {
        ok: false,
        error: cleanupOk
          ? 'The update could not be prepared safely. Please try again.'
          : 'The update could not be prepared safely and some cleanup did not complete. Please relaunch the app.',
      };
    }
  }

  broadcast({ state: 'restarting', version: installVersion });

  // Mark the attempt COMMITTED and capture its rollback, so the global `error`
  // handler can (a) tell a genuine post-quit Squirrel failure apart from an
  // unrelated periodic-check error, and (b) roll back this attempt's setup if the
  // install fails asynchronously (R24P1).
  installCommitted = true;
  committedRollback = rollbackHooks;
  committedParticipantNames = participantNames;
  committedOwed = owedAtCommit;
  committedVersion = installVersion;
  committedAttemptId = attemptId;

  // Let Squirrel.Mac handle extract + replace + relaunch. On the happy path this
  // never returns (the app quits within moments). If it throws SYNCHRONOUSLY (e.g.
  // the native updater rejects the staged bundle before quitting), we've already
  // committed — route the failure through the SAME teardown as an async failure so
  // the attempt's setup is rolled back and the UI/guards don't stay latched (R35P1).
  try {
    autoUpdater.quitAndInstall(false, true);
  } catch (err) {
    console.error('[auto-update] quitAndInstall threw synchronously — tearing down the committed attempt:', err);
    await teardownCommittedInstall('quitAndInstall threw');
    // teardownCommittedInstall set installFailedThisSession → EVERY subsequent
    // in-process attempt is rejected until relaunch (R25P1). So do NOT tell the user
    // to "try again" (that retry is guaranteed to fail) — give the same
    // quit-and-reopen guidance the teardown status broadcast uses (R28P15).
    return {
      ok: false,
      error: 'The update could not be installed. Please quit and reopen the app, then try again.',
    };
  }
  // ACCEPTED RESIDUAL (R28P44, do NOT add a time-based watchdog — codex flagged
  // that as unsafe and it was reverted): on macOS `MacUpdater.quitAndInstall()`
  // RETURNS while native Squirrel keeps staging (it retains its own
  // `update-downloaded` listener), with NO bounded completion guarantee — a large
  // update on a slow machine can legitimately take a long time. So we canNOT treat
  // "still running after N seconds" as a failure: a timer teardown would roll back
  // this attempt's setup (e.g. revoke elevation) and clear the ledger WHILE staging
  // is still valid, after which Squirrel could STILL install — the worst outcome
  // (new version installed, its pre-update setup undone). The native op isn't
  // cancellable, so elapsed time alone can't confirm failure. The residual: if
  // quitAndInstall genuinely stalls without ever emitting `error`, the UI sits on
  // 'restarting' until the user quits/relaunches — where the ledger reconciles the
  // owed cleanup. That recoverable hang is strictly safer than rolling back a valid
  // in-progress install. A GENUINE async failure still routes through the global
  // `error` handler → teardownCommittedInstall (R24P1); a SYNC throw is handled
  // above. Only those two SIGNALLED failures tear down — never a bare timeout.
  return { ok: true };
}

/**
 * Show native dialogs when the user manually triggers "Check for Updates…".
 * Background/automatic checks remain silent.
 */
export function checkForUpdatesInteractive(): void {
  if (!app.isPackaged && !isUpdateTestMode) {
    dialog.showMessageBox({
      type: 'info',
      title: 'Updates',
      message: 'Updates are not available in development mode.',
      buttons: ['OK'],
    });
    return;
  }

  // If an update was already downloaded, skip the check and offer install
  if (downloaded) {
    dialog
      .showMessageBox({
        type: 'info',
        title: 'Update Ready',
        message: `A new version of ${__BRAND_PRODUCT_NAME} is ready to install.`,
        detail:
          `${__BRAND_PRODUCT_NAME} ${downloadedVersion ?? ''} has been downloaded. Would you like to restart now to finish updating?`.trim(),
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(async ({ response }) => {
        if (response === 0) {
          // Surface a failure here too (R12P1): performQuitAndInstall can decline
          // without a native dialog of its own (artifact swap, plugin-set change,
          // or a confirmation dialog that couldn't be shown). Without this, the
          // menu action would silently do nothing.
          const result = await performQuitAndInstall();
          // `surfaced` means the failure already showed its own dialog (a
          // deliberate plugin veto) — don't stack a second generic warning (R13P1).
          if (!result.ok && result.error && !result.surfaced) {
            void dialog.showMessageBox({
              type: 'warning',
              title: 'Update not installed',
              message: 'The update could not be installed.',
              detail: result.error,
              buttons: ['OK'],
            });
          }
        }
      });
    return;
  }

  // Serialize interactive checks — a repeat click while one is in flight would
  // attach more one-shot listeners + promise catches to the same operation.
  if (interactiveCheckInFlight) return;
  interactiveCheckInFlight = true;

  const cleanup = () => {
    autoUpdater.removeListener('update-available', onAvailable);
    autoUpdater.removeListener('update-not-available', onNotAvailable);
    autoUpdater.removeListener('error', onError);
    interactiveCheckInFlight = false;
  };

  // checkForUpdates() emits `error` AND rejects on failure, so both onError
  // (via the once listener) and .catch(onError) can fire — guard so only the
  // first settles (one dialog, one cleanup).
  let settled = false;
  const settleOnce = (fn: () => void) => {
    if (settled) return;
    settled = true;
    cleanup();
    fn();
  };

  // No dialog here on purpose: `dialog.showMessageBox` is an app-modal native
  // alert, and on macOS showing one stalls the main process's event loop —
  // including the `download-progress`/network callbacks for the update
  // electron-updater just started (autoDownload=true kicks it off the moment
  // `update-available` fires, in the same tick as this listener). A blocking
  // "Update Available" alert here would visibly delay the download until the
  // user dismissed it. The persistent listener in registerAutoUpdateHandlers
  // already broadcasts `{ state: 'available' }` to the renderer, which the
  // non-blocking corner card (UpdateCard) picks up and live-updates through
  // downloading → downloaded — so no separate notification is needed.
  const onAvailable = () => {
    settleOnce(() => {
      /* handled by the non-blocking status broadcast */
    });
  };

  const onNotAvailable = () => {
    settleOnce(() => {
      dialog.showMessageBox({
        type: 'info',
        title: 'No Updates',
        message: `${__BRAND_PRODUCT_NAME} is up to date.`,
        detail: `You are running the latest version (${__APP_VERSION}).`,
        buttons: ['OK'],
      });
    });
  };

  const onError = (err: Error) => {
    settleOnce(() => {
      dialog.showMessageBox({
        type: 'warning',
        title: 'Update Error',
        message: 'Could not check for updates.',
        detail: err.message,
        buttons: ['OK'],
      });
    });
  };

  autoUpdater.once('update-available', onAvailable);
  autoUpdater.once('update-not-available', onNotAvailable);
  autoUpdater.once('error', onError);

  void trackedCheckForUpdates().catch(onError);
}

let downloaded = false;
let downloadedVersion: string | undefined;
let downloadedFilePath: string | undefined;
let pendingVersion: string | undefined;
/** Guards checkForUpdatesInteractive against overlapping runs. */
let interactiveCheckInFlight = false;
/** Guards performQuitAndInstall against re-entrant install attempts. */
let installInProgress = false;
/** True once quitAndInstall() has actually been invoked for the current attempt.
 *  Distinguishes a genuine ASYNC install failure (Squirrel `error` after quit)
 *  from an unrelated periodic-check `error` that happens to fire while a
 *  pre-update hook/dialog is still pending — only the former should unlatch the
 *  install (R24P1). */
let installCommitted = false;
/** The version the committed attempt is installing. Used for the failure-path
 *  post-update notification instead of the live `downloadedVersion`, which a
 *  concurrent download that finished after commit may have advanced past the
 *  committed artifact (R35P1). */
let committedVersion: string | undefined;
/** Rollback thunk of the committed attempt, so an async install failure can
 *  undo the setup its pre-update hooks performed (R24P1). */
let committedRollback:
  | ((opts?: { onPluginDone?: (name: string) => void | Promise<void> }) => Promise<{ failed: string[] }>)
  | null = null;
/** Participant plugin names for the committed attempt — excluded from the
 *  committed-failure all-active notify so none is notified twice (R33P1). */
let committedParticipantNames: string[] = [];
/** The exact `owed` set recorded for the committed attempt (participants ∪
 *  post-only, snapshotted at commit). The failed-install teardown notifies only
 *  these — NOT whatever is active now — so a plugin that activated after commit
 *  never receives an unrelated success:false hook (R35P1). */
let committedOwed: string[] = [];
/** Ledger attempt id of the committed attempt, so an async install failure can
 *  clear per-plugin owed state (or drop the whole attempt) in the ledger once
 *  teardown cleanup completes (R35P1). */
let committedAttemptId: string | undefined;
/** Set once a committed install has FAILED asynchronously this session. A failed
 *  macOS quitAndInstall leaves electron-updater's native MacUpdater listener
 *  installed; calling quitAndInstall again would stack another and could
 *  double-invoke the native install. So we refuse a second in-process attempt
 *  this session and tell the user to relaunch — the next launch re-checks
 *  cleanly (the ShipIt cache is cleared on the failing error) (R25P1). */
let installFailedThisSession = false;
let pendingFullSize: number | undefined;

/**
 * Tear down a COMMITTED-but-failed install: roll back the setup its pre-update
 * hooks performed and reconcile the ledger, then return the UI out of
 * 'restarting'. Called both from the global `error` handler (async Squirrel
 * failure) and from a synchronous `quitAndInstall` throw (R35P1) — sharing one
 * path so neither leaves state latched. Idempotent: gated on `installCommitted`,
 * which it clears first, so a second call (error + sync-throw both firing) is a
 * no-op. Never throws.
 */
async function teardownCommittedInstall(reason: string): Promise<void> {
  if (!installCommitted) return;
  installCommitted = false;
  installFailedThisSession = true;
  const rollback = committedRollback;
  committedRollback = null;
  const excludeNames = committedParticipantNames;
  committedParticipantNames = [];
  const owedAtCommit = committedOwed;
  committedOwed = [];
  const failedVersion = committedVersion ?? 'unknown';
  committedVersion = undefined;
  const attemptId = committedAttemptId;
  committedAttemptId = undefined;
  const runner = hookRunner;
  console.error(`[auto-update] Tearing down committed install (${reason}).`);
  // NOTE: the plugin-generation freeze is HELD through the two teardown phases
  // below (participant rollback + post-only notify) and the ledger reconcile, then
  // lifted right before the still-owed names are re-deferred (R28P1). Releasing it
  // earlier would let a concurrent disable/update/uninstall tear down a participant
  // whose async cleanup hook is still running.
  // Post-only plugins to notify with success:false: exactly those recorded as
  // owed AT COMMIT minus the participants (whom phase 1 rolls back). Using this
  // snapshot — not the currently-active set — means a plugin that activated AFTER
  // commit never receives an unrelated success:false hook (R35P1).
  const excludeSet = new Set(excludeNames);
  const postOnlyOwed = owedAtCommit.filter((n) => !excludeSet.has(n));
  // Persist the FAILED outcome on the ledger first, so a later launch never
  // recomputes it from the running version (R35P1). Then run the two teardown
  // phases INDEPENDENTLY: a failure in phase 1 must not skip phase 2, or post-only
  // plugins would never be notified (R31P2).
  if (attemptId) {
    try {
      setAttemptSuccess(attemptId, false);
    } catch (e) {
      console.error('[auto-update] Ledger success-persist after failed install threw:', e);
    }
  }
  // Durably WIDEN the attempt's owed set to include EVERY participant, not just
  // those owed at commit (R28P35). A participant with NO post-hook at commit was
  // excluded from `owedAtCommit`, but it can register a post-hook AFTER commit and
  // before this async-failure teardown; if that late hook then FAILS, rollback
  // reports it in `participantsFailed`, but it was never on the ledger — so the debt
  // would be lost on relaunch. Recording the union up front puts every participant
  // on the ledger; the per-plugin `markPluginsDone` below clears the ones whose
  // cleanup succeeds. (Un-attemptable/hookless owed no longer strands installs — the
  // reconcile give-up cap drops it, R28P8.)
  const owedForTeardown = [...new Set([...owedAtCommit, ...excludeNames])];
  let wideningFailed = false;
  if (attemptId && owedForTeardown.length > owedAtCommit.length) {
    // recordAttempt returns FALSE on a write failure (it never throws for that) — so
    // we MUST check the return, not just guard against throws (R28P36). If it can't
    // be persisted, the widened names exist only in memory; mark `wideningFailed` so
    // the final deferral below conservatively holds the WHOLE participant set and
    // installs stay blocked (installFailedThisSession already forces a relaunch,
    // where reconciliation retries). We can't do better this launch — the ledger is
    // unwritable right now — but we never SILENTLY lose the debt.
    let widened = false;
    try {
      widened = recordAttempt({
        id: attemptId,
        version: failedVersion,
        fromVersion: app.getVersion(),
        owed: owedForTeardown,
        success: false,
      });
    } catch (e) {
      console.error('[auto-update] Widening attempt owed set for teardown threw:', e);
    }
    if (!widened) {
      wideningFailed = true;
      console.error(
        '[auto-update] Could not durably widen attempt owed set — retaining all participants in memory + blocking installs.',
      );
    }
  }
  // 1) Revert PARTICIPANTS' setup (aborts their still-live signals + runs their
  //    post-update hooks). Resolves with the per-plugin `failed` set so we mark
  //    the SUCCEEDED participants done and re-owe only the failed ones — never
  //    re-running a participant's cleanup that already completed (R35P1). Each
  //    success is persisted immediately via onPluginDone so a crash mid-batch
  //    can't re-run an already-cleaned plugin. A throw (unexpected) conservatively
  //    treats ALL participants as failed.
  let participantsFailed = new Set<string>();
  try {
    const rb = rollback
      ? await rollback({ onPluginDone: attemptId ? (name) => void markPluginsDone(attemptId, [name]) : undefined })
      : { failed: [] as string[] };
    participantsFailed = new Set(Array.isArray(rb?.failed) ? rb.failed : []);
  } catch (e) {
    console.error('[auto-update] Participant rollback after failed install threw:', e);
    participantsFailed = new Set(excludeNames);
  }
  // 2) Notify the post-only plugins recorded as owed at commit (they registered
  //    only a post-update hook and were never participants). Participants are NOT
  //    re-notified here — phase 1 already ran their post-update hook; doing so
  //    twice could break a non-idempotent one-shot cleanup (R33P1). A post-only
  //    plugin whose notify fails is simply not marked done and stays owed for next
  //    launch — no re-owe needed (it was already owed at commit). Each success is
  //    persisted immediately (onPluginDone) for the same crash-safety reason.
  let notifiedNames: string[] = [];
  try {
    if (runner && postOnlyOwed.length > 0) {
      const res = await runner.runPostUpdateHooks(
        { version: failedVersion, success: false },
        {
          onlyNames: postOnlyOwed,
          onPluginDone: attemptId ? (name) => void markPluginsDone(attemptId, [name]) : undefined,
        },
      );
      notifiedNames = Array.isArray(res?.succeededNames) ? res.succeededNames : [];
    }
  } catch (e) {
    console.error('[auto-update] Post-only success:false notify after failed install threw:', e);
  }
  // Clear owed-state for exactly the plugins whose hook completed: participants
  // whose rollback succeeded (excludeNames minus the failed set) + post-only
  // plugins phase 2 confirmed. Plugins that threw/timed out stay owed so the next
  // launch retries them ONLY — never re-running a plugin already finished (R35P1).
  // If nothing remains owed the attempt is dropped. Clearing a not-yet-cleaned
  // plugin early would strand privileged setup (R29P1) or skip a notify (R31P1).
  let teardownCheckpointFailed = false;
  if (attemptId) {
    try {
      const doneNames = [...notifiedNames, ...excludeNames.filter((n) => !participantsFailed.has(n))];
      // A false return means the write failed: those plugins remain owed on disk
      // even though their cleanup ran → defer them conservatively below (R7P2).
      if (doneNames.length > 0 && !markPluginsDone(attemptId, doneNames)) teardownCheckpointFailed = true;
    } catch (e) {
      console.error('[auto-update] Ledger reconcile after failed install threw:', e);
      teardownCheckpointFailed = true;
    }
  }
  // DEFER the plugins whose cleanup is still owed after this teardown — failed
  // participants + post-only plugins not confirmed — so a periodic required-plugin
  // refresh / explicit lifecycle op can't replace their generation before the user
  // relaunches and the next-launch reconciler runs the owed cleanup (R7). If a
  // checkpoint WRITE failed, we can't know what actually cleared on disk, so
  // conservatively defer the WHOLE committed owed set (R7P2).
  const notifiedSet = new Set(notifiedNames);
  const stillOwed =
    teardownCheckpointFailed || wideningFailed
      ? [...new Set([...owedAtCommit, ...excludeNames])]
      : [...new Set([...participantsFailed, ...postOnlyOwed.filter((n) => !notifiedSet.has(n))])];
  // Both teardown phases + the ledger reconcile are DONE — lift the freeze NOW,
  // before re-deferring the still-owed subset so those names layer on top of the
  // restored snapshot (R28P1). Idempotent on the manager side.
  try {
    runner?.unfreezePluginUpdates?.();
  } catch (e) {
    console.error('[auto-update] unfreezePluginUpdates during teardown threw:', e);
  }
  if (stillOwed.length > 0) {
    try {
      runner?.deferUpdates?.(stillOwed);
    } catch (e) {
      console.error('[auto-update] deferUpdates after committed-install teardown threw:', e);
    }
  }
  // Clear the re-entrancy guard (installFailedThisSession now blocks any retry
  // regardless). Return the UI out of 'restarting' with a failure message so the
  // card/web client learns the install failed WITHOUT the user pressing Install
  // again (R32P1) — the started-ack already resolved, so this status broadcast is
  // the only channel left to report it.
  installInProgress = false;
  if (downloaded) {
    broadcast({
      state: 'downloaded',
      version: downloadedVersion,
      error: 'The update could not be installed. Please quit and reopen the app, then try again.',
    });
  }
}

/**
 * Test-only: reset the module-internal install/download state. In production a
 * successful `performQuitAndInstall` ends with the app quitting, so
 * `installInProgress` is never observed again; tests reuse the module instance
 * across cases and need a clean slate. Not exported through preload/IPC.
 */
export function __resetForTests(): void {
  downloaded = false;
  downloadedVersion = undefined;
  downloadedFilePath = undefined;
  installInProgress = false;
  installCommitted = false;
  committedRollback = null;
  committedParticipantNames = [];
  committedOwed = [];
  committedVersion = undefined;
  committedAttemptId = undefined;
  installFailedThisSession = false;
  installsBlockedForUnresolvedDebt = false;
  installReadyGate = Promise.resolve();
  checksInFlight = 0;
}

/** Test-only: simulate a pre-existing update check/download being in flight so
 *  the install-time drain (R28P1) can be exercised. */
export function __setChecksInFlightForTests(n: number): void {
  checksInFlight = n;
}

export function registerAutoUpdateHandlers(ipcMain: IpcMain, onUpdateDownloaded?: () => void): void {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.autoRunAppAfterInstall = true;

  // macOS differential (delta) downloads over a GENERIC provider (on-prem S3,
  // e.g. kai-platform's s3api-core.optum.com): electron-updater's macOS delta
  // path requests many byte-ranges in ONE call (multipart/byteranges). Some
  // S3-compatible stores don't support that and return the whole file as
  // `200 application/zip`, so electron-updater logs
  // `Content-Type "multipart/byteranges" is expected, but got "application/zip"`
  // and falls back to a FULL download every time — even though the block-map diff
  // computed correctly. Forcing SINGLE-range requests (`useMultipleRangeRequest:
  // false`) makes each block a plain `bytes=a-b` → `206` GET the server DOES
  // support, so the delta actually downloads. The `updateForceSingleRange`
  // branding key controls whether we do this: 'always' | 'never' | 'auto'
  // (detect S3 by a host containing "s3"). GitHub-provider builds are unaffected.
  // We apply this SYNCHRONOUSLY at registration — BEFORE the first
  // `checkForUpdates` runs — so the provider electron-updater builds for the
  // check (and reuses for the download; `getUpdateInfoAndProvider` only rebuilds
  // `clientPromise` when it's null) is already single-range. The earlier
  // fire-and-forget `configOnDisk.value.then(setFeedURL)` was racy: a
  // `checkForUpdates` that ran before the async config read resolved built the
  // provider from the UNMODIFIED baked config (multi-range), and the download
  // captures that provider at check time — so the late override landed on a
  // client the download never used. Reading the baked `app-update.yml`
  // synchronously (a tiny flat file we ship ourselves) removes the race.
  if (app.isPackaged && !isUpdateTestMode) {
    forceSingleRangeIfNeeded('registration');
  }

  autoUpdater.on('checking-for-update', () => {
    if (!downloaded) broadcast({ state: 'checking' });
  });
  autoUpdater.on('update-available', (info) => {
    // Defensive re-assert: the provider the CURRENT download uses was already
    // captured during the check (built from our single-range clientPromise set
    // at registration). Re-applying here keeps subsequent checks single-range
    // too, in case anything reset the feed config in between.
    if (app.isPackaged && !isUpdateTestMode) forceSingleRangeIfNeeded('update-available');
    pendingVersion = info.version;
    // Best-effort pick of the artifact MacUpdater will actually download
    // (arch-matching .zip). This only feeds the fallback heuristic — the
    // logger sniff is the authoritative mode signal.
    const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
    const zips = info.files?.filter((f) => f.url?.endsWith('.zip')) ?? [];
    const zipEntry =
      zips.find((f) => f.url.includes(arch) || f.url.includes('universal')) ??
      zips[0] ??
      info.files?.find((f) => f.url === info.path) ??
      info.files?.[0];
    pendingFullSize = zipEntry?.size;
    downloadMode = undefined;
    if (!downloaded) broadcast({ state: 'available', version: info.version });
  });
  autoUpdater.on('update-not-available', () => {
    if (!downloaded) broadcast({ state: 'idle' });
  });
  autoUpdater.on('download-progress', (progress) => {
    if (!downloaded) {
      // The bytes are authoritative for the mode label (see resolveDownloadMode):
      // a "differential" plan that silently fell back to a full download must
      // not keep showing "delta" while the whole file transfers.
      downloadMode = resolveDownloadMode(progress.total, pendingFullSize, downloadMode);
      broadcast({
        state: 'downloading',
        version: pendingVersion,
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
        mode: downloadMode,
        fullSize: pendingFullSize,
      });
    }
  });
  autoUpdater.on('update-downloaded', (info) => {
    downloaded = true;
    downloadedVersion = info.version;
    // electron-updater sets `downloadedFile` to the absolute path of the
    // staged artifact. Capture it so pre-update hooks can reference the path.
    const maybeFile = (info as { downloadedFile?: unknown }).downloadedFile;
    if (typeof maybeFile === 'string' && maybeFile.length > 0) {
      downloadedFilePath = maybeFile;
    }
    broadcast({ state: 'downloaded', version: info.version });
    // Signal any detached HEADLESS backend leader (spawned by a prior `kai` CLI,
    // untouched by this GUI's quitAndInstall) that a newer version exists, so it
    // self-exits when idle and the next CLI connect spawns a fresh backend.
    writeUpdateReady(info.version);
    onUpdateDownloaded?.();
  });
  autoUpdater.on('error', (err) => {
    console.error('[auto-update] Error:', err.message);
    // Squirrel.Mac leaves the extracted bundle in ~/Library/Caches/<appId>.ShipIt
    // when validation fails (e.g. a published zip with dereferenced framework
    // symlinks). Every subsequent check then re-fails on that stale extract
    // before it even re-downloads. Clear it so a fixed release can land.
    if (process.platform === 'darwin' && /SQRL|Code signature|ShipIt/i.test(err.message)) {
      const shipItCache = join(homedir(), 'Library', 'Caches', `${__BRAND_APP_ID}.ShipIt`);
      try {
        rmSync(shipItCache, { recursive: true, force: true });
        console.info('[auto-update] Cleared stale ShipIt cache:', shipItCache);
      } catch {
        /* non-fatal */
      }
    }
    // An error AFTER we committed to quitAndInstall means the install failed
    // ASYNCHRONOUSLY (macOS Squirrel can emit `error` before quitting) — the app
    // did NOT relaunch. Tear the attempt down: roll back the setup its pre-update
    // hooks performed and drop the UI out of 'restarting'. We gate on
    // `installCommitted`, NOT merely `installInProgress`: an unrelated periodic
    // checkForUpdates() emits the SAME global `error` while a pre-update
    // hook/dialog is still pending, and acting then would corrupt the live attempt
    // (R24P1). Because a failed quitAndInstall leaves electron-updater's native
    // listener installed, we mark the session install-failed so no second
    // in-process attempt runs — the user must relaunch (R25P1).
    //
    // We ALSO require that NO update check/download is currently in flight: one
    // that began before the install can still error on this same global channel
    // after we commit. Correlating by in-flight-check count (spanning the full
    // check→download lifecycle, R27P1) rather than by message string is reliable
    // in the common case — a genuine Squirrel staging error can read "Update
    // download failed" while a check error can read anything, so message
    // classification is unsafe in both directions (R26P1/R26P2). New checks are
    // suppressed during an install (R25P2), and `performQuitAndInstall` DRAINS any
    // pre-existing check/download before committing AND ABORTS the install if it
    // fails to drain within the timeout (R28P4) — so by the time we can be
    // `installCommitted`, `checksInFlight` is guaranteed 0 and a post-commit error
    // unambiguously tears down. The `checksInFlight === 0` guard below is thus
    // belt-and-suspenders; it can only ever be false for an UNCOMMITTED attempt
    // (an unrelated check erroring while a hook/dialog is pending), which we
    // correctly ignore. We never falsely tear down a healthy install.
    if (installCommitted && checksInFlight === 0) {
      void teardownCommittedInstall('async install error');
      return;
    }
    if (!downloaded) broadcast({ state: 'idle' });
  });

  ipcMain.handle('auto-update:check', async () => {
    if (!app.isPackaged && !isUpdateTestMode) return { ok: false, error: 'Updates disabled in dev mode' };
    // Don't start a check while an install attempt is running: an in-flight check
    // that errors after we commit to quitAndInstall would be misread as an install
    // failure (R25P2). The install is the higher-priority operation.
    if (installInProgress) return { ok: false, error: 'An update install is in progress' };
    try {
      await trackedCheckForUpdates();
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Update check failed';
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('auto-update:install', async (event) => {
    // A web-bridge caller (authenticated remote client) can't see or answer a
    // host-native dialog, so suppress dialogs for it — otherwise the hook-failure
    // prompt would hang the bridge until its timeout (R19P1). The bridge marks its
    // synthetic event with `__kaiWebBridge`.
    const isWebBridge = (event as unknown as { __kaiWebBridge?: boolean })?.__kaiWebBridge === true;

    if (isWebBridge) {
      // Reject synchronously if no artifact is staged: a stale/reconnected web tab
      // can retain its 'downloaded' UI across a backend restart and invoke install
      // when the new process has nothing staged. Acking {started:true} then would
      // leave the button apparently dead (the detached decline broadcast is also
      // suppressed with no artifact) — so surface the error inline instead (R31P1).
      if (!downloaded || !downloadedVersion || !downloadedFilePath) {
        return { ok: false, error: 'No update has been downloaded yet' };
      }
      // Don't block the web-bridge invoke on the full install: pre-update hooks
      // can take minutes and the bridge times out invocations at ~60s, which would
      // make a healthy in-progress install look like a failure while the backend
      // keeps going (R28P2). Fire it detached and ack immediately; the web client
      // tracks progress/outcome via the `auto-update:status` broadcasts (preparing
      // → restarting, or back to downloaded on decline) it already subscribes to.
      void performQuitAndInstall({ suppressDialogs: true })
        .then((result) => {
          // Forward a decline REASON to the web client: its detached invoke only
          // got the started-ack, so without this it can't explain why the install
          // did nothing (R29P1). Attach it to the follow-up 'downloaded' status.
          // Only broadcast 'downloaded' when an artifact is actually staged — a
          // stale/reconnected client invoking with nothing downloaded would
          // otherwise be shown an install button for a nonexistent update (R30P1).
          if (!result.ok && result.error && downloaded && downloadedVersion) {
            broadcast({ state: 'downloaded', version: downloadedVersion, error: result.error });
          }
        })
        .catch((err) => {
          console.error('[auto-update] Detached web-bridge install threw:', err);
        });
      return { ok: true, started: true };
    }

    // Local renderer: relay performQuitAndInstall's result so the card can surface
    // a failure that has no native dialog of its own (R10P2). The local invoke has
    // no 60s cap.
    return performQuitAndInstall({ suppressDialogs: false });
  });

  // Automatic update checks (only in packaged builds or test mode). Both the
  // initial and periodic checks skip while an install attempt is in progress —
  // an unrelated check that errors after quitAndInstall would otherwise be
  // misclassified as an install failure (R25P2).
  if (app.isPackaged || isUpdateTestMode) {
    setTimeout(() => {
      if (installInProgress) return;
      void trackedCheckForUpdates().catch((err) => {
        console.error('[auto-update] Initial check failed:', err.message);
      });
    }, INITIAL_DELAY_MS);

    setInterval(() => {
      if (installInProgress) return;
      void trackedCheckForUpdates().catch((err) => {
        console.error('[auto-update] Periodic check failed:', err.message);
      });
    }, CHECK_INTERVAL_MS);
  }
}
