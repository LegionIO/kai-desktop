/**
 * OTA Rollback — Crash-count recovery mechanism
 *
 * Tracks consecutive crashes. If the app fails to stay running for 30 seconds
 * three times in a row after an OTA update, the overlay is wiped and the app
 * falls back to the bundled (signed) code.
 */

import { existsSync, readFileSync, rmSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { OtaMeta } from './types.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import {
  OTA_DIR_NAME,
  OTA_CURRENT_DIR,
  OTA_ROLLBACK_DIR,
  OTA_META_FILE,
  OTA_MAX_CRASHES,
  OTA_STABLE_THRESHOLD_MS,
} from './types.js';

let stableTimer: ReturnType<typeof setTimeout> | null = null;
let otaRootPath: string | null = null;

/**
 * Get the OTA root directory for a given app slug.
 */
function getOtaRoot(appSlug: string): string {
  if (otaRootPath) return otaRootPath;
  otaRootPath = join(homedir(), '.' + appSlug, OTA_DIR_NAME);
  return otaRootPath;
}

/**
 * Read the OTA meta file, returning defaults if not found.
 */
function readMeta(otaRoot: string): OtaMeta {
  const metaPath = join(otaRoot, OTA_META_FILE);
  try {
    if (existsSync(metaPath)) {
      const parsed = JSON.parse(readFileSync(metaPath, 'utf-8')) as unknown;
      // Schema-validate before trusting it: a valid-JSON-but-wrong-shape file
      // (e.g. `null`, or a non-numeric crashCount) must not crash the rollback
      // check or mis-drive the threshold. Coerce/repair into a well-formed meta.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const p = parsed as Record<string, unknown>;
        return {
          crashCount: typeof p.crashCount === 'number' && Number.isFinite(p.crashCount) ? p.crashCount : 0,
          lastStableVersion: typeof p.lastStableVersion === 'string' ? p.lastStableVersion : null,
          shellVersion: typeof p.shellVersion === 'string' ? p.shellVersion : '',
          lastStableTimestamp: typeof p.lastStableTimestamp === 'string' ? p.lastStableTimestamp : null,
        };
      }
    }
  } catch {
    // Corrupted meta file — return defaults
  }
  return {
    crashCount: 0,
    lastStableVersion: null,
    shellVersion: '',
    lastStableTimestamp: null,
  };
}

/**
 * Write the OTA meta file atomically (write-temp + rename) so a crash DURING the
 * write can't leave a truncated file — which readMeta would treat as corrupt and
 * reset crashCount to 0, letting a persistent crash-loop evade the rollback
 * threshold indefinitely.
 */
function writeMeta(otaRoot: string, meta: OtaMeta): void {
  const metaPath = join(otaRoot, OTA_META_FILE);
  try {
    mkdirSync(otaRoot, { recursive: true });
    atomicWriteFileSync(metaPath, JSON.stringify(meta, null, 2));
  } catch (err) {
    console.error('[ota-rollback] Failed to write meta:', err);
  }
}

/**
 * Wipe the current OTA overlay, forcing the app to fall back to bundled code.
 * Preserves the rollback directory if it exists (in case we want to inspect it).
 * Returns true only if the overlay is gone afterward — so the caller doesn't
 * reset the crash counter (and report a successful rollback) while a broken
 * overlay actually remains on disk.
 */
function wipeOverlay(otaRoot: string): boolean {
  const currentDir = join(otaRoot, OTA_CURRENT_DIR);
  try {
    if (existsSync(currentDir)) {
      rmSync(currentDir, { recursive: true, force: true });
      console.info('[ota-rollback] Wiped OTA overlay due to repeated crashes');
    }
    return !existsSync(currentDir);
  } catch (err) {
    console.error('[ota-rollback] Failed to wipe overlay:', err);
    return !existsSync(currentDir);
  }
}

/**
 * Check if the overlay should be rolled back due to repeated crashes.
 * Call this at the very start of the app, BEFORE resolveCodePaths().
 *
 * If the crash count has reached the threshold, the overlay is deleted
 * and the function returns the version that was rolled back from (for UI notification).
 *
 * @returns The version that was rolled back from, or null if no rollback occurred.
 */
export function checkAndHandleRollback(
  appSlug: string,
  shellVersion: string,
): { rolledBackFrom: string; reason: string } | null {
  const otaRoot = getOtaRoot(appSlug);
  const meta = readMeta(otaRoot);

  // Update shell version in meta
  meta.shellVersion = shellVersion;

  // If no overlay exists, reset crash count
  const currentDir = join(otaRoot, OTA_CURRENT_DIR);
  if (!existsSync(currentDir)) {
    if (meta.crashCount > 0) {
      meta.crashCount = 0;
      writeMeta(otaRoot, meta);
    }
    return null;
  }

  // Increment crash counter (we haven't proven stability yet)
  meta.crashCount += 1;
  writeMeta(otaRoot, meta);

  // If we've hit the threshold, wipe the overlay
  if (meta.crashCount >= OTA_MAX_CRASHES) {
    const rolledBackFrom = meta.lastStableVersion ?? 'unknown';
    // Only reset the counter + report success if the overlay is actually gone.
    // If the wipe failed, keep the elevated count so the next boot retries
    // rather than resurrecting a broken overlay under a fresh (0) counter.
    if (!wipeOverlay(otaRoot)) {
      writeMeta(otaRoot, meta);
      console.error('[ota-rollback] Overlay wipe did not complete; keeping crash count for retry.');
      return null;
    }
    meta.crashCount = 0;
    meta.lastStableVersion = null;
    writeMeta(otaRoot, meta);
    return {
      rolledBackFrom,
      reason: `App crashed ${OTA_MAX_CRASHES} times consecutively after OTA update`,
    };
  }

  return null;
}

/**
 * Signal that the app has launched and is running. Starts a timer that,
 * after OTA_STABLE_THRESHOLD_MS, resets the crash counter to 0 (proving stability).
 *
 * Call this after the window is ready and the app is operational.
 */
export function signalAppRunning(appSlug: string, codeVersion: string): void {
  if (stableTimer) {
    clearTimeout(stableTimer);
  }

  stableTimer = setTimeout(() => {
    const otaRoot = getOtaRoot(appSlug);
    const meta = readMeta(otaRoot);
    meta.crashCount = 0;
    meta.lastStableVersion = codeVersion;
    meta.lastStableTimestamp = new Date().toISOString();
    writeMeta(otaRoot, meta);
    console.info(`[ota-rollback] Stable run confirmed for v${codeVersion}, crash counter reset`);
    stableTimer = null;
  }, OTA_STABLE_THRESHOLD_MS);
}

/**
 * Clean up the stability timer (call on graceful app quit to avoid
 * counting a user-initiated quit as a crash on the next launch).
 */
export function signalGracefulQuit(appSlug: string): void {
  if (stableTimer) {
    clearTimeout(stableTimer);
    stableTimer = null;
  }

  // Reset crash counter on graceful quit — the app didn't crash
  const otaRoot = getOtaRoot(appSlug);
  const meta = readMeta(otaRoot);
  if (meta.crashCount > 0) {
    meta.crashCount = 0;
    writeMeta(otaRoot, meta);
  }
}

/**
 * Manually trigger a rollback (e.g. user-initiated from settings).
 * Moves current → rollback and resets state.
 */
export function manualRollback(appSlug: string): { success: boolean; error?: string } {
  const otaRoot = getOtaRoot(appSlug);
  const currentDir = join(otaRoot, OTA_CURRENT_DIR);
  const rollbackDir = join(otaRoot, OTA_ROLLBACK_DIR);

  if (!existsSync(currentDir)) {
    return { success: false, error: 'No OTA overlay is currently active' };
  }

  try {
    // Remove old rollback if it exists
    if (existsSync(rollbackDir)) {
      rmSync(rollbackDir, { recursive: true, force: true });
    }

    // Move current → rollback (preserve for inspection)
    renameSync(currentDir, rollbackDir);

    // Reset meta
    const meta = readMeta(otaRoot);
    meta.crashCount = 0;
    writeMeta(otaRoot, meta);

    console.info('[ota-rollback] Manual rollback completed');
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[ota-rollback] Manual rollback failed:', message);
    return { success: false, error: message };
  }
}

/**
 * Get the current OTA meta state (for status reporting).
 */
export function getOtaMeta(appSlug: string): OtaMeta {
  const otaRoot = getOtaRoot(appSlug);
  return readMeta(otaRoot);
}
