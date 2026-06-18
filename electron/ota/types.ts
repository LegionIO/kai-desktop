/**
 * OTA (Over-The-Air) Delta Update Types
 *
 * The OTA system ships lightweight code-only patches (~8-12MB) instead of
 * full app bundles (~150MB) when only JS/React code has changed between releases.
 */

/** Per-file integrity entry in the OTA manifest */
export interface OtaFileEntry {
  /** SHA-512 hash of the file contents */
  sha512: string;
  /** File size in bytes */
  size: number;
}

/**
 * Manifest shipped inside an OTA archive and stored at ~/.kai/ota/current/manifest.json.
 * Describes what code version this overlay provides and what shell versions it's compatible with.
 */
export interface OtaManifest {
  /** The code version this OTA delivers (e.g. "1.0.85") */
  codeVersion: string;
  /** The base/shell version this OTA was built against (e.g. "1.0.83") */
  baseVersion: string;
  /** Minimum base/shell version required to apply this OTA (e.g. "1.0.80") */
  minBaseVersion: string;
  /** Per-file SHA-512 hashes for integrity verification */
  files: Record<string, OtaFileEntry>;
  /** ISO timestamp when this OTA archive was created */
  createdAt: string;
  /**
   * SHA-512 of the archive this manifest was extracted from.
   * Persisted by the updater after a verified download so that bootstrap can
   * rebuild the signed payload on every launch. Absent in legacy overlays.
   */
  sha512?: string;
  /**
   * Deterministic SHA-256 over the sorted `files` map (see
   * signing.ts#computeFilesHash). Included in the signed payload so the
   * per-file integrity table cannot be forged on disk. Absent in legacy
   * overlays; new clients refuse to boot an overlay without it.
   */
  filesHash?: string;
  /**
   * Base64 Ed25519 signature over
   * `${sha512}\n${codeVersion}\n${minBaseVersion}\n${filesHash}`.
   * Persisted by the updater after a verified download. Absent in legacy
   * overlays; new clients refuse to boot an overlay without it.
   */
  signature?: string;
}

/**
 * Persistent metadata stored at ~/.kai/ota/meta.json.
 * Tracks crash recovery state and version info across launches.
 */
export interface OtaMeta {
  /** Number of consecutive crashes since last stable run */
  crashCount: number;
  /** The last code version that ran stably for 30+ seconds */
  lastStableVersion: string | null;
  /** The shell/base version of the installed .app bundle */
  shellVersion: string;
  /** Timestamp of last successful stable run */
  lastStableTimestamp: string | null;
}

/** Resolved file paths for the three Electron code layers */
export interface CodePaths {
  /** Directory containing the main process bundle (index.js + chunks/) */
  main: string;
  /** Directory containing the preload script (index.mjs) */
  preload: string;
  /** Directory containing renderer assets (index.html + assets/) */
  renderer: string;
  /** Whether we're running from an OTA overlay (true) or bundled code (false) */
  isOverlay: boolean;
  /** The active code version (from overlay manifest or app version) */
  codeVersion: string;
}

/** Status of the OTA updater, broadcast to the renderer */
export type OtaStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string; size: number }
  | { state: 'downloading'; version: string; percent: number; transferred: number; total: number }
  | { state: 'verifying'; version: string }
  | { state: 'ready'; version: string }
  | { state: 'applying'; version: string }
  | { state: 'applied'; version: string }
  | { state: 'rolled-back'; fromVersion: string; reason: string }
  | { state: 'error'; message: string }
  | { state: 'not-applicable'; reason: string };

/**
 * The remote OTA feed manifest (latest-ota.json), published alongside each GitHub Release.
 * Tells the app what OTA archive is available and whether it's compatible.
 */
export interface OtaFeedEntry {
  /** The code version this OTA delivers */
  codeVersion: string;
  /** Minimum shell/base version required */
  minBaseVersion: string;
  /** URL to the .tar.gz archive (relative to release assets) */
  url: string;
  /** SHA-512 hash of the entire archive file */
  sha512: string;
  /** Archive file size in bytes */
  size: number;
  /** ISO timestamp of publication */
  releaseDate: string;
  /**
   * Deterministic SHA-256 over the sorted manifest.files map (see
   * signing.ts#computeFilesHash). Additive: old clients ignore this field;
   * new clients require it as part of the signed payload.
   */
  filesHash?: string;
  /**
   * Base64 Ed25519 signature over
   * `${sha512}\n${codeVersion}\n${minBaseVersion}\n${filesHash}`.
   * Additive: old clients ignore this field; new clients refuse unsigned feeds.
   */
  signature?: string;
}

/**
 * The full OTA feed file structure (latest-ota.json)
 */
export interface OtaFeed {
  /** Latest OTA entry */
  latest: OtaFeedEntry;
}

/** Maximum consecutive crashes before rollback */
export const OTA_MAX_CRASHES = 3;

/** Seconds the app must run stably before resetting crash counter */
export const OTA_STABLE_THRESHOLD_MS = 30_000;

/** Directory name for OTA storage under the app home */
export const OTA_DIR_NAME = 'ota';

/** Subdirectory names within the OTA root */
export const OTA_CURRENT_DIR = 'current';
export const OTA_STAGING_DIR = 'staging';
export const OTA_ROLLBACK_DIR = 'rollback';
export const OTA_META_FILE = 'meta.json';
export const OTA_MANIFEST_FILE = 'manifest.json';
