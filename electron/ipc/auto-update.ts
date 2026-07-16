import { app, dialog, type IpcMain } from 'electron';
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import { broadcastToAllWindows } from '../utils/window-send.js';
import { writeUpdateReady } from '../local-bridge/update-signal.js';
import { existsSync, writeFileSync, readFileSync, unlinkSync, rmSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

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
  mode: 'auto' | 'always' | 'never' = __BRAND_UPDATE_FORCE_SINGLE_RANGE,
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

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const INITIAL_DELAY_MS = 5_000; // 5 seconds after launch
/** Upper bound on pre-update hooks (e.g. admin elevation). A hook that never
 *  settles (a stuck elevation prompt, a wedged helper) must not pin the app in
 *  the 'preparing' state forever — on expiry we fail closed exactly like a
 *  thrown hook: abort the install, revert to 'downloaded', allow a later retry. */
export const PRE_UPDATE_HOOK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Race a promise against a timeout. Resolves to `{ timedOut: true }` when the
 * deadline wins (the pending promise is abandoned, not cancelled — the caller
 * decides what to do). Clears the timer on either outcome so it can't leak.
 * Exported for unit testing.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    const value = await Promise.race([promise.then((v) => ({ timedOut: false as const, value: v })), timeout]);
    return value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
  }) => Promise<{ abort?: boolean; abortReason?: string }>;
  runPostUpdateHooks: (args: { version: string; success: boolean }) => Promise<void>;
};

let hookRunner: UpdateHookRunner | null = null;

export function setUpdateHookRunner(runner: UpdateHookRunner): void {
  hookRunner = runner;
}

/* ── Post-Update Marker ── */

const POST_UPDATE_MARKER = join(app.getPath('userData'), '.update-completed');

function writePostUpdateMarker(version: string): boolean {
  try {
    writeFileSync(
      POST_UPDATE_MARKER,
      JSON.stringify({
        version,
        fromVersion: app.getVersion(),
        timestamp: Date.now(),
      }),
    );
    return true;
  } catch (err) {
    // Non-fatal: the update itself still proceeds. But post-update hooks (e.g.
    // revoking admin granted by a pre-update hook) won't fire after relaunch,
    // which is a degraded state worth surfacing rather than silently swallowing.
    console.error('[auto-update] Failed to write post-update marker — post-update hooks will not run:', err);
    return false;
  }
}

/**
 * Consume the post-update marker file written before quitAndInstall().
 * Returns the update metadata if a marker existed, null otherwise.
 * Deletes the marker after reading.
 */
export function consumePostUpdateMarker(): { version: string; fromVersion: string } | null {
  try {
    if (!existsSync(POST_UPDATE_MARKER)) return null;
    const data = JSON.parse(readFileSync(POST_UPDATE_MARKER, 'utf-8'));
    unlinkSync(POST_UPDATE_MARKER);
    return data;
  } catch {
    try {
      unlinkSync(POST_UPDATE_MARKER);
    } catch {
      /* */
    }
    return null;
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
export async function performQuitAndInstall(): Promise<void> {
  // Guard: never run pre-update hooks, write the post-update marker, or call
  // quitAndInstall unless an update actually finished downloading. Invoking this
  // prematurely (e.g. a stray auto-update:install IPC) would write a spurious
  // marker and hand a non-existent artifact to the installer.
  if (!downloaded || !downloadedVersion || !downloadedFilePath) {
    console.warn('[auto-update] performQuitAndInstall called with no downloaded update — ignoring');
    return;
  }

  // Re-entrancy guard: multiple install calls could otherwise pass the guard
  // above and run elevation hooks / quitAndInstall more than once (accumulating
  // native Squirrel listeners on macOS). Only the first attempt proceeds.
  if (installInProgress) {
    console.warn('[auto-update] install already in progress — ignoring duplicate performQuitAndInstall');
    return;
  }
  installInProgress = true;

  // Run pre-update hooks (e.g., elevate to admin)
  if (hookRunner) {
    broadcast({ state: 'preparing', version: downloadedVersion });
    try {
      const outcome = await withTimeout(
        hookRunner.runPreUpdateHooks({
          version: downloadedVersion ?? 'unknown',
          artifactPath: downloadedFilePath ?? '',
        }),
        PRE_UPDATE_HOOK_TIMEOUT_MS,
      );
      if (outcome.timedOut) {
        // A hook that never settled must not pin the app in 'preparing' forever.
        // Fail closed: abort the install, revert to 'downloaded', allow a retry.
        console.error(
          `[auto-update] Pre-update hooks timed out after ${PRE_UPDATE_HOOK_TIMEOUT_MS}ms — aborting install.`,
        );
        broadcast({ state: 'downloaded', version: downloadedVersion });
        installInProgress = false;
        return;
      }
      const result = outcome.value;
      if (result.abort) {
        console.info('[auto-update] Pre-update hook aborted install:', result.abortReason ?? '(no reason)');
        broadcast({ state: 'downloaded', version: downloadedVersion });
        installInProgress = false; // aborted before install — allow a later retry
        return;
      }
    } catch (err) {
      console.error('[auto-update] Pre-update hooks threw, aborting install:', err);
      broadcast({ state: 'downloaded', version: downloadedVersion });
      installInProgress = false; // failed before install — allow a later retry
      return;
    }
  }

  // Write marker so post-update hooks fire after relaunch
  writePostUpdateMarker(downloadedVersion ?? 'unknown');

  broadcast({ state: 'restarting', version: downloadedVersion });

  // Let Squirrel.Mac handle extract + replace + relaunch
  autoUpdater.quitAndInstall(false, true);
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
      .then(({ response }) => {
        if (response === 0) {
          void performQuitAndInstall();
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

  const onAvailable = (info: { version: string }) => {
    settleOnce(() => {
      dialog.showMessageBox({
        type: 'info',
        title: 'Update Available',
        message: `${__BRAND_PRODUCT_NAME} ${info.version} is available.`,
        detail: `The update is downloading in the background. You'll be notified when it's ready to install.`,
        buttons: ['OK'],
      });
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

  autoUpdater.checkForUpdates().catch(onError);
}

let downloaded = false;
let downloadedVersion: string | undefined;
let downloadedFilePath: string | undefined;
let pendingVersion: string | undefined;
/** Guards checkForUpdatesInteractive against overlapping runs. */
let interactiveCheckInFlight = false;
/** Guards performQuitAndInstall against re-entrant install attempts. */
let installInProgress = false;
let pendingFullSize: number | undefined;

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
  // branding key controls this: 'always' | 'never' | 'auto' (detect S3 by a
  // host containing "s3"). GitHub-provider builds are unaffected (multi-range OK).
  // The dev-test path sets this directly; production relies on the baked
  // app-update.yml (which can't express it), so re-issue the feed config here.
  if (app.isPackaged && !isUpdateTestMode) {
    const configOnDisk = (autoUpdater as unknown as { configOnDisk?: { value?: Promise<Record<string, unknown>> } })
      .configOnDisk;
    void configOnDisk?.value
      ?.then((cfg) => {
        if (cfg?.provider !== 'generic') return; // GitHub etc. handle multi-range
        if (shouldForceSingleRange(typeof cfg.url === 'string' ? cfg.url : undefined)) {
          autoUpdater.setFeedURL({
            ...cfg,
            useMultipleRangeRequest: false,
          } as Parameters<typeof autoUpdater.setFeedURL>[0]);
          logLine('info', ['generic provider: forcing single-range requests (useMultipleRangeRequest=false)']);
        }
      })
      .catch(() => {
        /* best-effort: if the baked config can't be read, leave the default */
      });
  }

  autoUpdater.on('checking-for-update', () => {
    if (!downloaded) broadcast({ state: 'checking' });
  });
  autoUpdater.on('update-available', (info) => {
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
    if (!downloaded) broadcast({ state: 'idle' });
  });

  ipcMain.handle('auto-update:check', async () => {
    if (!app.isPackaged && !isUpdateTestMode) return { ok: false, error: 'Updates disabled in dev mode' };
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Update check failed';
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('auto-update:install', async () => {
    if (!downloaded || !downloadedVersion || !downloadedFilePath) {
      return { ok: false, error: 'No update has been downloaded yet' };
    }
    await performQuitAndInstall();
    return { ok: true };
  });

  // Automatic update checks (only in packaged builds or test mode)
  if (app.isPackaged || isUpdateTestMode) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        console.error('[auto-update] Initial check failed:', err.message);
      });
    }, INITIAL_DELAY_MS);

    setInterval(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        console.error('[auto-update] Periodic check failed:', err.message);
      });
    }, CHECK_INTERVAL_MS);
  }
}
