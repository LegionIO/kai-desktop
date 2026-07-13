import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { getRunDir } from './paths.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

/**
 * Cross-process "an update has been downloaded" signal.
 *
 * When the GUI's auto-updater finishes downloading a new version, it writes this
 * flag into the shared run dir (same `~/.kai` both the GUI and any detached
 * HEADLESS backend leader use). A headless leader — spawned by a prior `kai` CLI
 * and NOT touched by the GUI's quitAndInstall — watches for it and self-exits
 * once idle, so the next `kai` connect spawns a FRESH backend on the new code
 * instead of attaching to a stale leader still running the old version.
 *
 * This is NON-destructive (unlike the consume-once post-update marker in
 * auto-update.ts, which the relaunching GUI reads+deletes): both the GUI and the
 * headless leader need to observe it independently, so no reader deletes it. It's
 * cleared on a fresh startup whose running version already matches (stale flag
 * from a completed update).
 */

const SIGNAL_FILE = 'update-ready.json';

function signalPath(): string {
  return join(getRunDir(), SIGNAL_FILE);
}

interface UpdateSignal {
  /** The version that was downloaded and will be installed on restart. */
  version: string;
  timestamp: number;
}

/** Record that `version` has been downloaded (called by the GUI on update-downloaded). */
export function writeUpdateReady(version: string): void {
  try {
    const path = signalPath();
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, JSON.stringify({ version, timestamp: Date.now() } satisfies UpdateSignal));
  } catch {
    // Non-fatal: without it, a stale headless leader just isn't nudged to exit
    // (the CLI still surfaces the version mismatch to the user).
  }
}

/** Read the pending-update signal, or null if none / unreadable. Does NOT delete it. */
export function readUpdateReady(): UpdateSignal | null {
  try {
    const path = signalPath();
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (raw && typeof raw === 'object' && typeof (raw as UpdateSignal).version === 'string') {
      return raw as UpdateSignal;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Remove the signal file (best-effort). Called once the running version matches
 *  the downloaded one (the update completed — the flag is stale). */
export function clearUpdateReady(): void {
  try {
    const path = signalPath();
    if (existsSync(path)) writeFileSync(path, '', 'utf-8'); // truncate → readUpdateReady returns null
  } catch {
    /* ignore */
  }
}

/**
 * Should a headless leader running `runningVersion` step aside for an update?
 * True only when a signal exists AND names a DIFFERENT version — i.e. an update
 * was downloaded that this stale leader is not running. Pure/ testable.
 */
export function shouldStepAsideForUpdate(runningVersion: string): boolean {
  const sig = readUpdateReady();
  return !!sig && !!sig.version && sig.version !== runningVersion;
}
