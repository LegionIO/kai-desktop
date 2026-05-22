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

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { valid as semverValid, gte as semverGte } from 'semver';
import type { CodePaths, OtaManifest } from './types.js';
import { OTA_DIR_NAME, OTA_CURRENT_DIR, OTA_MANIFEST_FILE } from './types.js';

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
export function resolveCodePaths(
  appSlug: string,
  shellVersion: string,
  bundledOutDir: string,
): CodePaths {
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

    console.info(
      `[ota-bootstrap] Using OTA overlay: code v${manifest.codeVersion} (shell v${shellVersion})`,
    );

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
