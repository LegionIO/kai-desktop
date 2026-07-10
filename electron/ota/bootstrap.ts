/**
 * OTA Bootstrap — Overlay Code Path Resolution
 *
 * This module must be imported at the very top of electron/main.ts (before any
 * other application imports) to determine whether the app should load code from
 * an OTA overlay directory or from the bundled asar.
 *
 * The overlay lives at ~/.kai/ota/current/out/ and is completely outside the
 * signed .app bundle, so macOS code signing is unaffected.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join, resolve, sep } from 'path';
import { homedir } from 'os';
import { app } from 'electron';
import { valid as semverValid, gte as semverGte } from 'semver';
import type { CodePaths, OtaManifest } from './types.js';
import { OTA_DIR_NAME, OTA_CURRENT_DIR, OTA_MANIFEST_FILE } from './types.js';
import { computeFilesHash, shouldSkipOtaSignature, verifyOtaSignature } from './signing.js';

/** Entrypoint files whose on-disk hash is re-checked against the signed manifest at boot. */
const OTA_ENTRYPOINT_FILES = ['out/main/index.js', 'out/preload/index.mjs', 'out/renderer/index.html'] as const;

function hashFileSync(filePath: string): string {
  return createHash('sha512').update(readFileSync(filePath)).digest('hex');
}

/** Remove a poisoned/invalid overlay so the next launch starts clean. */
function wipeOverlay(dir: string, reason: string): void {
  console.warn(`[ota-bootstrap] Wiping overlay (${reason}): ${dir}`);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn('[ota-bootstrap] Failed to wipe overlay:', err);
  }
}

/**
 * Resolve the code paths for the current launch.
 *
 * Checks for a valid OTA overlay at ~/.{appSlug}/ota/current/ and returns
 * paths pointing to either the overlay or the bundled code.
 *
 * @param appSlug - The app's directory name (e.g. "kai")
 * @param shellVersion - The version baked into the signed .app bundle (__APP_VERSION)
 * @param bundledOutDir - The bundled out/ directory (import.meta.dirname for main process)
 * @returns Resolved code paths
 */
export function resolveCodePaths(appSlug: string, shellVersion: string, bundledOutDir: string): CodePaths {
  const bundledPaths: CodePaths = {
    main: bundledOutDir,
    preload: join(bundledOutDir, '..', 'preload'),
    renderer: join(bundledOutDir, '..', 'renderer'),
    isOverlay: false,
    codeVersion: shellVersion,
  };

  try {
    const otaRoot = join(homedir(), '.' + appSlug, OTA_DIR_NAME);
    const currentDir = join(otaRoot, OTA_CURRENT_DIR);
    const manifestPath = join(currentDir, OTA_MANIFEST_FILE);

    // No overlay installed
    if (!existsSync(manifestPath)) {
      return bundledPaths;
    }

    // Parse and validate manifest
    const manifest: OtaManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

    if (!manifest.codeVersion || !manifest.minBaseVersion) {
      console.warn('[ota-bootstrap] Invalid manifest: missing required fields');
      return bundledPaths;
    }

    // Validate semver format
    if (!semverValid(manifest.minBaseVersion) || !semverValid(shellVersion)) {
      console.warn('[ota-bootstrap] Invalid version format in manifest or shell');
      return bundledPaths;
    }

    // Check compatibility: shell version must be >= minBaseVersion
    if (!semverGte(shellVersion, manifest.minBaseVersion)) {
      console.warn(
        `[ota-bootstrap] Shell version ${shellVersion} < minBaseVersion ${manifest.minBaseVersion}, skipping overlay`,
      );
      return bundledPaths;
    }

    // Anti-rollback floor: the overlay must never be OLDER than the code baked
    // into the signed shell. A stale or attacker-planted overlay with a lower
    // codeVersion would otherwise downgrade the user past known-fixed bugs.
    if (!semverValid(manifest.codeVersion) || !semverGte(manifest.codeVersion, shellVersion)) {
      console.warn(
        `[ota-bootstrap] Overlay codeVersion ${manifest.codeVersion} < shell ${shellVersion} — falling back to bundled`,
      );
      wipeOverlay(currentDir, 'rollback floor');
      return bundledPaths;
    }

    // Boot-time signature re-verification: bind the on-disk overlay to a
    // payload signed by the release pipeline. This defeats local tampering of
    // ~/.kai/ota/current/ and feed-bypass attacks.
    if (shouldSkipOtaSignature(app.isPackaged)) {
      console.warn('[ota-bootstrap] KAI_OTA_SKIP_SIGNATURE or dev mode — skipping overlay signature verification');
    } else {
      if (!manifest.signature || !manifest.sha512 || !manifest.filesHash) {
        console.warn('[ota-bootstrap] Overlay manifest is unsigned — refusing overlay');
        wipeOverlay(currentDir, 'unsigned manifest');
        return bundledPaths;
      }
      const sigOk = verifyOtaSignature({
        sha512: manifest.sha512,
        codeVersion: manifest.codeVersion,
        minBaseVersion: manifest.minBaseVersion,
        filesHash: manifest.filesHash,
        signature: manifest.signature,
        url: manifest.url,
        size: manifest.size,
      });
      if (!sigOk) {
        console.warn('[ota-bootstrap] Overlay signature verification failed — refusing overlay');
        wipeOverlay(currentDir, 'bad signature');
        return bundledPaths;
      }

      // The signature now vouches for manifest.filesHash. Recompute it from
      // the on-disk manifest.files map and compare — this proves the per-file
      // hash table itself has not been edited since signing. Only after this
      // check passes is the per-file re-hash loop below trustworthy.
      const manifestFiles = manifest.files ?? {};
      const actualFilesHash = computeFilesHash(manifestFiles);
      if (actualFilesHash !== manifest.filesHash) {
        console.warn('[ota-bootstrap] manifest.files hash mismatch — refusing overlay');
        wipeOverlay(currentDir, 'filesHash tampered');
        return bundledPaths;
      }
      const manifestRelPaths = Object.keys(manifestFiles);
      // The entrypoints must be present in the manifest at minimum.
      for (const rel of OTA_ENTRYPOINT_FILES) {
        if (!manifestFiles[rel]) {
          console.warn(`[ota-bootstrap] Manifest missing entry for ${rel} — refusing overlay`);
          wipeOverlay(currentDir, 'incomplete manifest');
          return bundledPaths;
        }
      }
      const currentDirResolved = resolve(currentDir);
      for (const rel of manifestRelPaths) {
        const expected = manifestFiles[rel];
        const filePath = resolve(join(currentDir, rel));
        // Containment: manifest-supplied paths must stay inside the overlay dir.
        if (!filePath.startsWith(currentDirResolved + sep)) {
          console.warn(`[ota-bootstrap] Manifest file path escapes overlay: ${rel} — refusing overlay`);
          wipeOverlay(currentDir, 'manifest path escape');
          return bundledPaths;
        }
        const actual = hashFileSync(filePath);
        if (actual !== expected.sha512) {
          console.warn(`[ota-bootstrap] File hash mismatch for ${rel} — refusing overlay`);
          wipeOverlay(currentDir, 'file tampered');
          return bundledPaths;
        }
      }
    }

    // Verify the overlay directory structure exists
    const overlayOut = join(currentDir, 'out');
    const overlayMain = join(overlayOut, 'main');
    const overlayPreload = join(overlayOut, 'preload');
    const overlayRenderer = join(overlayOut, 'renderer');

    if (!existsSync(join(overlayMain, 'index.js'))) {
      console.warn('[ota-bootstrap] Overlay main/index.js not found, falling back to bundled');
      return bundledPaths;
    }

    if (!existsSync(join(overlayPreload, 'index.mjs'))) {
      console.warn('[ota-bootstrap] Overlay preload/index.mjs not found, falling back to bundled');
      return bundledPaths;
    }

    if (!existsSync(join(overlayRenderer, 'index.html'))) {
      console.warn('[ota-bootstrap] Overlay renderer/index.html not found, falling back to bundled');
      return bundledPaths;
    }

    console.info(`[ota-bootstrap] Using OTA overlay: code v${manifest.codeVersion} (shell v${shellVersion})`);

    return {
      main: overlayMain,
      preload: overlayPreload,
      renderer: overlayRenderer,
      isOverlay: true,
      codeVersion: manifest.codeVersion,
    };
  } catch (err) {
    console.warn('[ota-bootstrap] Error resolving overlay, falling back to bundled:', err);
    return bundledPaths;
  }
}
