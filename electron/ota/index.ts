/**
 * OTA Module — Over-The-Air Delta Updates
 *
 * Provides lightweight code-only updates (~8-12MB) instead of full app
 * bundles (~150MB) when only JS/React code has changed between releases.
 */

export { resolveCodePaths } from './bootstrap.js';
export { checkAndHandleRollback, signalAppRunning, signalGracefulQuit, manualRollback, getOtaMeta } from './rollback.js';
export {
  checkForOtaUpdate,
  downloadOtaUpdate,
  applyOtaUpdate,
  checkAndDownloadOta,
  getOtaStatus,
  isOtaReady,
  getReadyVersion,
  startOtaChecks,
  stopOtaChecks,
} from './ota-updater.js';
export type {
  OtaManifest,
  OtaMeta,
  CodePaths,
  OtaStatus,
  OtaFeed,
  OtaFeedEntry,
  OtaFileEntry,
} from './types.js';
