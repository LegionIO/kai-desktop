import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const APPLESCRIPT_TIMEOUT_MS = 1500;
const MAX_FOCUS_SNAPSHOT_AGE_MS = 10 * 60 * 1000;

type FocusSnapshot = {
  appName: string;
  bundleId: string | null;
  pid: number | null;
  capturedAt: number;
};

let targetFocus: FocusSnapshot | null = null;
let captureInFlight: Promise<void> | null = null;

function appleString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
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
  if (process.platform !== 'darwin') return;

  const output = await runAppleScript(`
tell application "System Events"
  set frontProcess to first application process whose frontmost is true
  set frontBundle to ""
  try
    set frontBundle to bundle identifier of frontProcess as text
  end try
  set frontName to name of frontProcess as text
  set frontPid to unix id of frontProcess as text
  return frontBundle & linefeed & frontName & linefeed & frontPid
end tell
`);

  const [bundleId = '', appName = '', pidText = ''] = output.split(/\r?\n/);
  const trimmedPid = pidText.trim();
  const parsedPid = Number(trimmedPid);
  const snapshot: FocusSnapshot = {
    bundleId: bundleId.trim() || null,
    appName: appName.trim(),
    pid: trimmedPid && Number.isFinite(parsedPid) ? parsedPid : null,
    capturedAt: Date.now(),
  };

  if (!snapshot.appName || isOwnProcess(snapshot)) return;
  targetFocus = snapshot;
}

export async function beginDictationFocusSession(): Promise<void> {
  targetFocus = null;
  await refreshDictationTargetFocusNow();
}

export function refreshDictationTargetFocus(): void {
  void refreshDictationTargetFocusNow();
}

async function refreshDictationTargetFocusNow(): Promise<void> {
  if (process.platform !== 'darwin') return;
  if (captureInFlight) {
    await captureInFlight;
    return;
  }

  captureInFlight = captureFrontmostApp()
    .catch(() => {
      // Accessibility/Automation may be unavailable; dictation should still work.
    })
    .finally(() => {
      captureInFlight = null;
    });
  await captureInFlight;
}

export function clearDictationTargetFocus(): void {
  targetFocus = null;
}

export function restoreDictationTargetFocusSoon(): void {
  if (process.platform !== 'darwin') return;

  setTimeout(() => { void restoreDictationTargetFocus().catch(() => {}); }, 25);
  setTimeout(() => { void restoreDictationTargetFocus().catch(() => {}); }, 150);
  setTimeout(() => { void restoreDictationTargetFocus().catch(() => {}); }, 300);
}

async function restoreDictationTargetFocus(): Promise<void> {
  const snapshot = targetFocus;
  if (!snapshot || isOwnProcess(snapshot)) return;
  if (Date.now() - snapshot.capturedAt > MAX_FOCUS_SNAPSHOT_AGE_MS) return;

  const pidClause = snapshot.pid != null
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
