import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runLocalMacMouseCommand } from '../computer-use/permissions.js';
import { getPlatformAdapter } from '../platform/index.js';
import { dictationDebugLog } from './debug-log.js';

const execFileAsync = promisify(execFile);
const APPLESCRIPT_TIMEOUT_MS = 1500;
const MAX_FOCUS_SNAPSHOT_AGE_MS = 10 * 60 * 1000;
const RECAPTURE_RETRY_DELAY_MS = 80;

type FocusSnapshot = {
  appName: string;
  bundleId: string | null;
  pid: number | null;
  windowId?: string | null;
  capturedAt: number;
};

let targetFocus: FocusSnapshot | null = null;
let captureInFlight: Promise<void> | null = null;
let externalFocusRefreshSuppressed = false;

function appleString(value: string): string {
  const sanitized = value.replace(/[\u0000-\u001F\u007F]/g, ' ');
  return `"${sanitized.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function runAppleScript(script: string): Promise<string> {
  const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', script], {
    timeout: APPLESCRIPT_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
  });
  return stdout.trim();
}

function isOwnProcess(snapshot: FocusSnapshot): boolean {
  return snapshot.pid === process.pid || snapshot.appName.toLowerCase() === __BRAND_PRODUCT_NAME.toLowerCase();
}

async function captureFrontmostApp(): Promise<void> {
  const startedAt = Date.now();
  let snapshot: FocusSnapshot;

  if (process.platform === 'darwin') {
    const result = await runLocalMacMouseCommand(['frontmostApplication']);
    const rawPid = result.pid;
    const parsedPid = typeof rawPid === 'number' && Number.isFinite(rawPid) ? rawPid : Number(rawPid);
    const appName = typeof result.name === 'string' ? result.name.trim() : '';
    const bundleId = typeof result.bundleId === 'string' ? result.bundleId.trim() : '';
    snapshot = {
      bundleId: bundleId || null,
      appName,
      pid: Number.isFinite(parsedPid) ? parsedPid : null,
      capturedAt: Date.now(),
    };
  } else {
    const adapter = await getPlatformAdapter();
    const focus = await adapter.captureFocus();
    if (!focus) return;
    snapshot = {
      bundleId: focus.ownerId,
      appName: focus.appName,
      pid: focus.pid,
      windowId: focus.windowId ?? null,
      capturedAt: focus.capturedAt,
    };
  }

  dictationDebugLog('FOCUS_CAPTURE', {
    ok: Boolean(snapshot.appName && snapshot.pid != null && !isOwnProcess(snapshot)),
    pid: snapshot.pid,
    app: snapshot.appName,
    own: isOwnProcess(snapshot),
    durationMs: Date.now() - startedAt,
  });

  if (!snapshot.appName || isOwnProcess(snapshot)) return;
  targetFocus = snapshot;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runFreshFocusCapture(): Promise<void> {
  const capture = captureFrontmostApp()
    .catch((err) => {
      // Startup and mutation paths fail closed if a target cannot be identified.
      dictationDebugLog('FOCUS_CAPTURE_ERROR', {
        message: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      if (captureInFlight === capture) {
        captureInFlight = null;
      }
    });
  captureInFlight = capture;
  await capture;
}

export async function beginDictationFocusSession(): Promise<void> {
  targetFocus = null;
  await refreshDictationTargetFocusNow();
}

export function setDictationTargetFocusSnapshot(snapshot: FocusSnapshot | null): void {
  targetFocus = snapshot;
}

export function setDictationExternalFocusRefreshSuppressed(suppressed: boolean): void {
  externalFocusRefreshSuppressed = suppressed;
}

export function refreshDictationTargetFocus(): void {
  if (externalFocusRefreshSuppressed) {
    dictationDebugLog('FOCUS_REFRESH_SUPPRESSED');
    return;
  }
  void refreshDictationTargetFocusNow();
}

async function refreshDictationTargetFocusNow(): Promise<void> {
  if (captureInFlight) {
    await captureInFlight;
    return;
  }

  await runFreshFocusCapture();
}

export async function recaptureDictationTargetFocus(): Promise<boolean> {
  if (captureInFlight) {
    await captureInFlight;
  }

  const previousTarget = targetFocus;
  targetFocus = null;
  await runFreshFocusCapture();

  if (!targetFocus && previousTarget?.pid != null) {
    await delay(RECAPTURE_RETRY_DELAY_MS);
    await runFreshFocusCapture();
  }

  const snapshot = targetFocus as FocusSnapshot | null;
  return snapshot?.pid != null;
}

export function clearDictationTargetFocus(): void {
  targetFocus = null;
}

export function getDictationTargetPid(): number | null {
  return targetFocus?.pid ?? null;
}

export function getDictationTargetAppName(): string | null {
  return targetFocus?.appName ?? null;
}

export function getDictationTargetBundleId(): string | null {
  return targetFocus?.bundleId ?? null;
}

export function restoreDictationTargetFocusSoon(): void {
  setTimeout(() => {
    void restoreDictationTargetFocus().catch(() => {});
  }, 25);
  setTimeout(() => {
    void restoreDictationTargetFocus().catch(() => {});
  }, 150);
  setTimeout(() => {
    void restoreDictationTargetFocus().catch(() => {});
  }, 300);
}

async function restoreDictationTargetFocus(): Promise<void> {
  const snapshot = targetFocus;
  if (!snapshot || isOwnProcess(snapshot)) return;
  if (Date.now() - snapshot.capturedAt > MAX_FOCUS_SNAPSHOT_AGE_MS) return;

  // Validate that the target PID is still alive before attempting to activate it.
  // This prevents restoring focus to a stale/dead process from a previous session.
  if (snapshot.pid != null && !isProcessAlive(snapshot.pid)) {
    targetFocus = null;
    return;
  }

  if (process.platform !== 'darwin') {
    const adapter = await getPlatformAdapter();
    await adapter.restoreFocus({
      appName: snapshot.appName,
      ownerId: snapshot.bundleId,
      pid: snapshot.pid,
      windowId: snapshot.windowId ?? null,
      capturedAt: snapshot.capturedAt,
    });
    return;
  }

  const pidClause =
    snapshot.pid != null
      ? `
try
  tell application "System Events" to set frontmost of first application process whose unix id is ${snapshot.pid} to true
  return
end try`
      : '';
  const bundleClause = snapshot.bundleId
    ? `
try
  tell application id ${appleString(snapshot.bundleId)} to activate
  return
end try`
    : '';

  await runAppleScript(`
${pidClause}
${bundleClause}
try
  tell application ${appleString(snapshot.appName)} to activate
end try
`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
