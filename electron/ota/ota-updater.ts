/**
 * OTA Updater — Download, verify, and apply OTA code patches
 *
 * Handles the full lifecycle of an OTA update:
 * 1. Check the release feed for a new OTA archive
 * 2. Download the archive to a staging directory
 * 3. Verify file integrity via SHA-512 hashes
 * 4. Atomically swap staging → current (with rollback preservation)
 * 5. Signal readiness for restart
 */

import { createHash } from 'crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import { net, app } from 'electron';
import { gte as semverGte, gt as semverGt } from 'semver';
import type { OtaFeed, OtaFeedEntry, OtaManifest, OtaStatus } from './types.js';
import { OTA_DIR_NAME, OTA_CURRENT_DIR, OTA_STAGING_DIR, OTA_ROLLBACK_DIR, OTA_MANIFEST_FILE } from './types.js';
import { computeFilesHash, shouldSkipOtaSignature, verifyOtaSignature } from './signing.js';
import { broadcastToAllWindows } from '../utils/window-send.js';

// ── Configuration ────────────────────────────────────────────────────────────

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours (same as full updater)
const INITIAL_DELAY_MS = 8_000; // 8 seconds after launch (after full updater's 5s check)

/** Hard ceiling on an OTA archive download. The archive is hash-verified after
 *  download, but that runs too late to stop a tampered feed from filling disk
 *  with a huge response first. A legitimate overlay is a small fraction of this;
 *  the cap only rejects pathological/malicious sizes. */
const MAX_OTA_ARCHIVE_BYTES = 512 * 1024 * 1024; // 512 MiB

// Env overrides for testing (mirrors auto-update.ts pattern)
const DEV_TEST_VERSION = process.env.KAI_UPDATE_TEST_VERSION;
const isTestMode = !!DEV_TEST_VERSION;

// ── State ────────────────────────────────────────────────────────────────────

let currentStatus: OtaStatus = { state: 'idle' };
let checkInterval: ReturnType<typeof setInterval> | null = null;
let otaReady = false;
let readyVersion: string | undefined;

// ── Helpers ──────────────────────────────────────────────────────────────────

function getOtaRoot(appSlug: string): string {
  return join(homedir(), '.' + appSlug, OTA_DIR_NAME);
}

function broadcast(status: OtaStatus): void {
  currentStatus = status;
  broadcastToAllWindows('ota:status', status);
}

/**
 * Get the GitHub release feed URL for OTA manifests.
 */
function getOtaFeedUrl(): string {
  // Runtime env override (highest priority — for testing per CLAUDE.md)
  const updateUrl = process.env.KAI_UPDATE_URL;
  if (updateUrl) {
    return `${updateUrl.replace(/\/$/, '')}/latest-ota.json`;
  }
  // Brand-baked explicit feed URL (e.g. on-prem S3 for uhc-tech builds)
  if (typeof __BRAND_OTA_FEED_URL !== 'undefined' && __BRAND_OTA_FEED_URL) {
    return `${__BRAND_OTA_FEED_URL.replace(/\/$/, '')}/latest-ota.json`;
  }
  // Brand-baked GitHub repo → releases/latest/download
  const repo =
    process.env.KAI_UPDATE_REPO ??
    (typeof __BRAND_UPDATE_REPO !== 'undefined' ? __BRAND_UPDATE_REPO : 'legionio/kai-desktop');
  return `https://github.com/${repo}/releases/latest/download/latest-ota.json`;
}

/**
 * Fetch JSON from a URL using Electron's net module.
 */
async function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = net.request(url);
    let data = '';

    request.on('response', (response) => {
      // Follow redirects (GitHub uses 302 for release assets)
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const redirectUrl = Array.isArray(response.headers.location)
          ? response.headers.location[0]
          : response.headers.location;
        fetchJson<T>(redirectUrl).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode} fetching ${url}`));
        return;
      }

      response.on('data', (chunk) => {
        data += chunk.toString();
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`Failed to parse JSON from ${url}: ${err}`));
        }
      });
      response.on('error', reject);
    });

    request.on('error', reject);
    request.end();
  });
}

/**
 * Download a file with progress reporting.
 */
async function downloadFile(url: string, destPath: string, version: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = net.request(url);

    request.on('response', (response) => {
      // Follow redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const redirectUrl = Array.isArray(response.headers.location)
          ? response.headers.location[0]
          : response.headers.location;
        downloadFile(redirectUrl, destPath, version).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode} downloading ${url}`));
        return;
      }

      const totalStr = response.headers['content-length'];
      const total = totalStr ? parseInt(Array.isArray(totalStr) ? totalStr[0] : totalStr, 10) : 0;
      // Reject an oversized advertised length before streaming a single byte.
      if (total > MAX_OTA_ARCHIVE_BYTES) {
        request.abort();
        reject(new Error(`OTA archive too large: Content-Length ${total} exceeds ${MAX_OTA_ARCHIVE_BYTES}`));
        return;
      }
      let transferred = 0;
      let aborted = false;

      const writeStream = createWriteStream(destPath);
      writeStream.on('error', reject);
      writeStream.on('finish', resolve);

      response.on('data', (chunk) => {
        if (aborted) return;
        transferred += chunk.length;
        // Abort mid-stream if a lying/absent Content-Length lets the body run
        // past the ceiling — don't keep filling disk until the hash check.
        if (transferred > MAX_OTA_ARCHIVE_BYTES) {
          aborted = true;
          request.abort();
          writeStream.destroy();
          try {
            rmSync(destPath, { force: true });
          } catch {
            /* best-effort cleanup */
          }
          reject(new Error(`OTA archive exceeded ${MAX_OTA_ARCHIVE_BYTES} bytes mid-download`));
          return;
        }
        writeStream.write(chunk);
        if (total > 0) {
          broadcast({
            state: 'downloading',
            version,
            percent: Math.round((transferred / total) * 100),
            transferred,
            total,
          });
        }
      });

      response.on('end', () => {
        if (!aborted) writeStream.end();
      });
      response.on('error', reject);
    });

    request.on('error', reject);
    request.end();
  });
}

/**
 * Compute SHA-512 hash of a file.
 */
async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Verify the extracted OTA archive against its manifest hashes.
 */
async function verifyExtracted(stagingDir: string): Promise<{ valid: boolean; error?: string }> {
  const manifestPath = join(stagingDir, OTA_MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    return { valid: false, error: 'No manifest.json in extracted archive' };
  }

  let manifest: OtaManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch {
    return { valid: false, error: 'Failed to parse manifest.json' };
  }

  // Verify each file listed in the manifest
  for (const [filePath, entry] of Object.entries(manifest.files)) {
    const fullPath = join(stagingDir, filePath);
    if (!existsSync(fullPath)) {
      return { valid: false, error: `Missing file: ${filePath}` };
    }

    const actualHash = await hashFile(fullPath);
    if (actualHash !== entry.sha512) {
      return { valid: false, error: `Hash mismatch for ${filePath}` };
    }
  }

  return { valid: true };
}

/**
 * Gate an OTA feed entry on its Ed25519 signature.
 *
 * New clients REQUIRE a valid signature; the field is additive in the feed so
 * old clients (which lack this check) continue to upgrade via sha512-only and
 * will pick up this enforcement on their next update.
 *
 * @returns null if the entry is acceptable, otherwise a user-facing error string
 */
function checkFeedSignature(latest: OtaFeedEntry): string | null {
  if (shouldSkipOtaSignature(app.isPackaged)) {
    console.warn('[ota-updater] KAI_OTA_SKIP_SIGNATURE or dev mode — skipping OTA signature verification');
    return null;
  }
  if (!latest.signature || !latest.filesHash) {
    console.error('[ota-updater] OTA feed entry is unsigned — refusing update');
    return 'OTA feed entry is unsigned — refusing update';
  }
  const ok = verifyOtaSignature({
    sha512: latest.sha512,
    codeVersion: latest.codeVersion,
    minBaseVersion: latest.minBaseVersion,
    filesHash: latest.filesHash,
    signature: latest.signature,
  });
  if (!ok) {
    console.error('[ota-updater] OTA signature verification failed — refusing update');
    return 'OTA signature verification failed';
  }
  return null;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Check the remote feed for an available OTA update.
 *
 * @param appSlug - App directory name (e.g. "kai")
 * @param currentCodeVersion - Currently running code version
 * @param shellVersion - Shell/base version of the installed .app
 * @returns Whether an OTA update is available
 */
export async function checkForOtaUpdate(
  appSlug: string,
  currentCodeVersion: string,
  shellVersion: string,
): Promise<boolean> {
  try {
    broadcast({ state: 'checking' });

    const feedUrl = getOtaFeedUrl();
    const feed = await fetchJson<OtaFeed>(feedUrl);

    if (!feed?.latest) {
      broadcast({ state: 'idle' });
      return false;
    }

    const { latest } = feed;

    // Already on this version or newer — return idle before signature check
    // so a stale/legacy unsigned feed for an already-installed version
    // doesn't surface a spurious signature error to the user.
    if (semverGte(currentCodeVersion, latest.codeVersion)) {
      broadcast({ state: 'idle' });
      return false;
    }

    // Signature gate — refuse to advertise an unsigned/invalid update
    const sigError = checkFeedSignature(latest);
    if (sigError) {
      broadcast({ state: 'error', message: sigError });
      return false;
    }

    // Check shell compatibility
    if (!semverGte(shellVersion, latest.minBaseVersion)) {
      broadcast({
        state: 'not-applicable',
        reason: `Shell version ${shellVersion} is below minimum ${latest.minBaseVersion}. A full update is required.`,
      });
      return false;
    }

    broadcast({ state: 'available', version: latest.codeVersion, size: latest.size });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error checking OTA feed';
    console.error('[ota-updater] Check failed:', message);
    broadcast({ state: 'error', message });
    return false;
  }
}

/**
 * Download and stage an OTA update. Does NOT apply it — call applyOtaUpdate() after.
 */
export async function downloadOtaUpdate(
  appSlug: string,
  currentCodeVersion: string,
  shellVersion: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const feedUrl = getOtaFeedUrl();
    const feed = await fetchJson<OtaFeed>(feedUrl);

    if (!feed?.latest) {
      return { success: false, error: 'No OTA feed available' };
    }

    const { latest } = feed;

    // Re-validate compatibility before signature check — no need to error
    // on an unsigned legacy feed when we wouldn't apply it anyway.
    if (semverGte(currentCodeVersion, latest.codeVersion)) {
      return { success: false, error: 'Already up to date' };
    }

    // Signature gate — MUST run before any download or extraction
    const sigError = checkFeedSignature(latest);
    if (sigError) {
      broadcast({ state: 'error', message: sigError });
      return { success: false, error: sigError };
    }
    if (!semverGte(shellVersion, latest.minBaseVersion)) {
      return { success: false, error: 'Shell version incompatible, full update required' };
    }

    const otaRoot = getOtaRoot(appSlug);
    const stagingDir = join(otaRoot, OTA_STAGING_DIR);

    // Clean staging
    if (existsSync(stagingDir)) {
      rmSync(stagingDir, { recursive: true, force: true });
    }
    mkdirSync(stagingDir, { recursive: true });

    // Resolve download URL (may be relative to feed URL) — same precedence
    // as getOtaFeedUrl(): KAI_UPDATE_URL > __BRAND_OTA_FEED_URL > GitHub repo.
    let archiveUrl = latest.url;
    if (!archiveUrl.startsWith('http')) {
      const updateUrl = process.env.KAI_UPDATE_URL;
      if (updateUrl) {
        archiveUrl = `${updateUrl.replace(/\/$/, '')}/${latest.url}`;
      } else if (typeof __BRAND_OTA_FEED_URL !== 'undefined' && __BRAND_OTA_FEED_URL) {
        archiveUrl = `${__BRAND_OTA_FEED_URL.replace(/\/$/, '')}/${latest.url}`;
      } else {
        const repo =
          process.env.KAI_UPDATE_REPO ??
          (typeof __BRAND_UPDATE_REPO !== 'undefined' ? __BRAND_UPDATE_REPO : 'legionio/kai-desktop');
        archiveUrl = `https://github.com/${repo}/releases/latest/download/${latest.url}`;
      }
    }

    // Download archive
    const archivePath = join(stagingDir, 'ota-archive.tar.gz');
    broadcast({ state: 'downloading', version: latest.codeVersion, percent: 0, transferred: 0, total: latest.size });
    await downloadFile(archiveUrl, archivePath, latest.codeVersion);

    // Verify archive hash
    broadcast({ state: 'verifying', version: latest.codeVersion });
    const archiveHash = await hashFile(archivePath);
    if (archiveHash !== latest.sha512) {
      rmSync(stagingDir, { recursive: true, force: true });
      const error = 'Archive hash verification failed';
      broadcast({ state: 'error', message: error });
      return { success: false, error };
    }

    // Extract archive using system tar (always available on macOS)
    const extractDir = join(stagingDir, 'extracted');
    mkdirSync(extractDir, { recursive: true });
    execFileSync('/usr/bin/tar', ['-xzf', archivePath, '-C', extractDir]);

    // Verify extracted files against manifest
    const verification = await verifyExtracted(extractDir);
    if (!verification.valid) {
      rmSync(stagingDir, { recursive: true, force: true });
      const error = `File verification failed: ${verification.error}`;
      broadcast({ state: 'error', message: error });
      return { success: false, error };
    }

    // Persist the verified signature + archive hash into the on-disk manifest
    // so that bootstrap.ts can re-verify the overlay on every launch without
    // needing the (now-deleted) archive or a network round-trip.
    try {
      const extractedManifestPath = join(extractDir, OTA_MANIFEST_FILE);
      const extractedManifest: OtaManifest = JSON.parse(readFileSync(extractedManifestPath, 'utf-8'));
      // Verify the archive's manifest.files actually hashes to the signed
      // filesHash before persisting it. Catching the mismatch here fails the
      // update cleanly instead of letting bootstrap wipe a bad overlay on
      // next launch.
      const extractedFilesHash = computeFilesHash(extractedManifest.files ?? {});
      if (extractedFilesHash !== latest.filesHash) {
        rmSync(stagingDir, { recursive: true, force: true });
        const error = 'Archive manifest.files does not match signed filesHash';
        console.error('[ota-updater]', error);
        broadcast({ state: 'error', message: error });
        return { success: false, error };
      }
      extractedManifest.sha512 = latest.sha512;
      extractedManifest.filesHash = latest.filesHash;
      extractedManifest.signature = latest.signature;
      writeFileSync(extractedManifestPath, JSON.stringify(extractedManifest, null, 2));
    } catch (err) {
      rmSync(stagingDir, { recursive: true, force: true });
      const error = `Failed to persist OTA signature to manifest: ${err}`;
      broadcast({ state: 'error', message: error });
      return { success: false, error };
    }

    // Clean up the archive file (keep only extracted)
    rmSync(archivePath, { force: true });

    // Rename extracted to staging root for apply step
    // Move extracted/* up to staging/
    const extractedContents = readdirSync(extractDir);
    for (const item of extractedContents) {
      renameSync(join(extractDir, item), join(stagingDir, item));
    }
    rmSync(extractDir, { recursive: true, force: true });

    otaReady = true;
    readyVersion = latest.codeVersion;
    broadcast({ state: 'ready', version: latest.codeVersion });
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error downloading OTA';
    console.error('[ota-updater] Download failed:', message);
    broadcast({ state: 'error', message });
    return { success: false, error: message };
  }
}

/**
 * Apply a staged OTA update by atomically swapping directories.
 *
 * Flow:
 * 1. current/ → rollback/ (preserve for inspection)
 * 2. staging/ → current/ (atomic rename)
 * 3. Signal restart needed
 */
export function applyOtaUpdate(
  appSlug: string,
  currentCodeVersion?: string,
): { success: boolean; error?: string; version?: string } {
  const otaRoot = getOtaRoot(appSlug);
  const stagingDir = join(otaRoot, OTA_STAGING_DIR);
  const currentDir = join(otaRoot, OTA_CURRENT_DIR);
  const rollbackDir = join(otaRoot, OTA_ROLLBACK_DIR);

  if (!existsSync(stagingDir) || !existsSync(join(stagingDir, OTA_MANIFEST_FILE))) {
    return { success: false, error: 'No staged OTA update to apply' };
  }

  try {
    // Read version from staging manifest
    const manifest: OtaManifest = JSON.parse(readFileSync(join(stagingDir, OTA_MANIFEST_FILE), 'utf-8'));

    // Apply-time downgrade guard: a stale-but-signed staged overlay must not be
    // applied over an equal/newer running version (mirrors the load-layer check
    // in bootstrap.ts). Only enforced when the caller supplies the current
    // version; skipped otherwise for back-compat.
    if (currentCodeVersion && !semverGt(manifest.codeVersion, currentCodeVersion)) {
      rmSync(stagingDir, { recursive: true, force: true });
      const error = `Refusing to apply OTA ${manifest.codeVersion} over current ${currentCodeVersion} (not newer)`;
      broadcast({ state: 'error', message: error });
      return { success: false, error };
    }

    broadcast({ state: 'applying', version: manifest.codeVersion });

    // Step 1: Remove old rollback
    if (existsSync(rollbackDir)) {
      rmSync(rollbackDir, { recursive: true, force: true });
    }

    // Step 2: Move current → rollback (if exists)
    if (existsSync(currentDir)) {
      renameSync(currentDir, rollbackDir);
    }

    // Step 3: Move staging → current (atomic on same filesystem)
    renameSync(stagingDir, currentDir);

    otaReady = false;
    readyVersion = undefined;
    broadcast({ state: 'applied', version: manifest.codeVersion });

    return { success: true, version: manifest.codeVersion };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error applying OTA';
    console.error('[ota-updater] Apply failed:', message);

    // Attempt recovery: if current was moved to rollback, move it back
    if (!existsSync(currentDir) && existsSync(rollbackDir)) {
      try {
        renameSync(rollbackDir, currentDir);
      } catch {
        // Best-effort recovery
      }
    }

    broadcast({ state: 'error', message });
    return { success: false, error: message };
  }
}

/**
 * Convenience: check + download + apply in one shot (for automatic updates).
 */
export async function checkAndDownloadOta(
  appSlug: string,
  currentCodeVersion: string,
  shellVersion: string,
): Promise<boolean> {
  const available = await checkForOtaUpdate(appSlug, currentCodeVersion, shellVersion);
  if (!available) return false;

  const result = await downloadOtaUpdate(appSlug, currentCodeVersion, shellVersion);
  return result.success;
}

/**
 * Get the current OTA status.
 */
export function getOtaStatus(): OtaStatus {
  return currentStatus;
}

/**
 * Whether an OTA update has been downloaded and is ready to apply.
 */
export function isOtaReady(): boolean {
  return otaReady;
}

/**
 * Get the version of the ready OTA update (if any).
 */
export function getReadyVersion(): string | undefined {
  return readyVersion;
}

/**
 * Start periodic OTA checks.
 *
 * @param appSlug - App slug
 * @param getCodeVersion - Function to get current code version (may change after apply)
 * @param getShellVersion - Function to get shell version
 */
export function startOtaChecks(appSlug: string, getCodeVersion: () => string, getShellVersion: () => string): void {
  if (!app.isPackaged && !isTestMode) return;

  // Initial check (delayed to avoid competing with full updater)
  setTimeout(async () => {
    try {
      await checkAndDownloadOta(appSlug, getCodeVersion(), getShellVersion());
    } catch (err) {
      console.error('[ota-updater] Initial OTA check failed:', err);
    }
  }, INITIAL_DELAY_MS);

  // Periodic checks
  checkInterval = setInterval(async () => {
    try {
      if (!otaReady) {
        await checkAndDownloadOta(appSlug, getCodeVersion(), getShellVersion());
      }
    } catch (err) {
      console.error('[ota-updater] Periodic OTA check failed:', err);
    }
  }, CHECK_INTERVAL_MS);
}

/**
 * Stop periodic OTA checks.
 */
export function stopOtaChecks(): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}
