import { Notification, BrowserWindow } from 'electron';
import { readdirSync, readFileSync, existsSync, statSync, mkdirSync, unlinkSync } from 'fs';
import { join, resolve, sep } from 'path';
import type {
  PluginManifest,
  PluginInstance,
  PluginUIState,
  PluginRendererScript,
  PluginRendererStyle,
  PluginBannerDescriptor,
  PluginModalDescriptor,
  PluginSettingsSectionDescriptor,
  PluginPanelDescriptor,
  PluginNavigationItemDescriptor,
  PluginCommandDescriptor,
  PluginConversationDecorationDescriptor,
  PluginThreadDecorationDescriptor,
  PluginNotificationDescriptor,
  PluginActionPayload,
  PluginNavigationTarget,
  PreSendHookArgs,
  PreSendHookResult,
  PostReceiveHookArgs,
  PostReceiveHookResult,
  PreUpdateHookArgs,
  PreUpdateHooksOutcome,
  PostUpdateHookArgs,
  PostUpdateHook,
  PluginAPI,
  PluginPermission,
  PluginConsentRequest,
  PluginInferenceProvider,
  PluginCliToolContribution,
  PluginActionHandler,
} from './types.js';
import { DANGEROUS_PLUGIN_PERMISSIONS } from './types.js';
import { createPluginAPI, cleanupPluginAPI } from './plugin-api.js';
import type { AppConfig } from '../config/schema.js';
import { toPluginSafeConfig, resolvePluginConfigView, type PluginSafeConfig } from './safe-config.js';
import type { ToolDefinition } from '../tools/types.js';
import { broadcastToAllWindows } from '../utils/window-send.js';
import { safeErrorText } from '../utils/safe-error-text.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { eventBus } from '../automations/event-bus.js';
import { convertJsonSchemaToZod } from '../tools/skill-loader.js';
import { broadcastUpsert, broadcastActive } from '../ipc/conversations.js';
import type { ConversationRecord } from '../ipc/conversation-store.js';
import {
  readConversation,
  readAllConversations,
  writeConversation,
  setActiveConversationId,
} from '../ipc/conversation-store.js';
import {
  assertActivePluginRendererBudget,
  buildPluginRendererBundle,
  pluginRendererBuildBytes,
} from './renderer-build.js';
import { MarketplaceService, UnverifiedPluginError } from './marketplace-service.js';
import type { MarketplaceCatalogEntry, InstallResult } from './marketplace-service.js';
import { getBundledPluginIntegrity } from './plugin-bootstrap.js';
import {
  AUTHENTICATED_BROWSER_PERMISSION,
  arePermissionSetsEqual,
  approvalPermissionsMatch,
  deferredPermissionsTrusted,
  effectivePluginPermissions,
  hashPluginDirectory,
  hashPluginFile,
  isLegacyInferredBrowserPermissionSnapshot,
  isTransientFsError,
  pathAvailability,
  readPluginManifest,
  snapshotPluginDirectory,
} from './plugin-integrity.js';
import { checkPluginCompatibility } from './plugin-compat.js';
import { PluginProcessHost } from './process/plugin-process-host.js';
import { selectPluginHostRuntime } from './process/runtime-selection.js';
import { newDiagnosticCorrelationId, traceDiagnostic } from '../diagnostics/debug-trace.js';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Whether a newly-computed plugin UI-state snapshot differs from the last one
 * broadcast (compared by serialized JSON). When it hasn't changed, the emit is
 * skipped — a plugin re-publishing identical (potentially multi-MB) state, or a
 * no-op trigger, would otherwise re-broadcast the whole payload to every
 * window/web/CLI client for nothing. Exported for testing.
 */
export function uiStateChanged(lastJson: string, nextJson: string): boolean {
  return lastJson !== nextJson;
}

/** A plugin name is used as an on-disk path segment (plugin-settings/<name>/…)
 *  and as an identity key, so it must be a strict slug — no separators, no
 *  traversal, no leading dot. Mirrors the skills-loader name rule. */
const PLUGIN_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function isValidPluginName(name: unknown): name is string {
  return typeof name === 'string' && name !== '.' && name !== '..' && PLUGIN_NAME_RE.test(name);
}

function setNestedValue(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.').filter(Boolean);
  if (keys.some((k) => DANGEROUS_KEYS.has(k))) return;
  if (keys.length === 0) return;

  let current = target;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index];
    if (!current[key] || typeof current[key] !== 'object' || Array.isArray(current[key])) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

function normalizePluginObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

type PluginListEntry = {
  name: string;
  displayName: string;
  version: string;
  description: string;
  state: string;
  brandRequired: boolean;
  icon?: { lucide: string } | { svg: string };
  error?: string;
  permissions: PluginPermission[];
  capabilities: string[];
};

/** Compare two semver strings — returns true if catalogVersion is newer than installedVersion. */
function isNewerVersion(catalogVersion: string, installedVersion: string): boolean {
  const toNum = (v: string) => v.split('.').map(Number);
  const [cMajor = 0, cMinor = 0, cPatch = 0] = toNum(catalogVersion);
  const [iMajor = 0, iMinor = 0, iPatch = 0] = toNum(installedVersion);
  if (cMajor !== iMajor) return cMajor > iMajor;
  if (cMinor !== iMinor) return cMinor > iMinor;
  return cPatch > iPatch;
}

export class PluginManager {
  /**
   * Upper bound on a SINGLE pre-update hook. A hook that never settles (a wedged
   * elevation prompt, a stuck helper) is recorded as an overridable failure and
   * the run moves on — bounding it here (not with one aggregate timeout in the
   * caller) preserves any deliberate veto another plugin holds (R4). Matches the
   * updater's historical 5-minute pre-update budget.
   */
  static readonly PRE_UPDATE_HOOK_TIMEOUT_MS = 5 * 60 * 1000;

  private plugins: Map<string, PluginInstance> = new Map();
  private pluginAPIs: Map<string, PluginAPI> = new Map();
  /** One independently-accounted SEA or Electron utility process per live plugin. */
  private pluginProcesses: Map<string, PluginProcessHost> = new Map();
  private toolChangeCallback: ((tools: ToolDefinition[]) => void) | null = null;
  private cliToolChangeCallback: (() => void) | null = null;
  private browserAssistantRevocationCallback: (() => void) | null = null;
  private actionHandlers: Map<string, Map<string, PluginActionHandler>> = new Map();
  private notificationTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private nativeNotifications: Map<string, Notification> = new Map();
  private marketplaceService: MarketplaceService | null = null;
  /**
   * True once {@link initMarketplace} has run to completion (success OR
   * network-fetch failure that fell back to cache). Distinguishes a genuinely
   * unconfigured marketplace from one whose async startup catalog fetch simply
   * hasn't resolved yet — the renderer needs this to avoid falsely showing
   * "No marketplace configured" when opened mid-init. See getMarketplaceStatus().
   */
  private marketplaceInitialized = false;
  /**
   * Single-flight guard for catalog refreshes, KEYED by the ordered URL list.
   * Two callers with the SAME url set coalesce onto one in-flight run. Callers
   * with a DIFFERENT url set (e.g. after a mid-session branding change) must
   * NOT join that flight — but they also must not run CONCURRENTLY against the
   * same MarketplaceService (both mutate its cached catalog + reachability, and
   * a late old-set fetch could commit over the new one). So a differing key
   * CHAINS after the current flight: at most one refresh touches the service at
   * a time, and the last-committed refresh is authoritative.
   */
  private inFlightCatalogFetch: { key: string; promise: Promise<MarketplaceCatalogEntry[]> } | null = null;
  /** Tail of the serialize-different-keys chain (resolves when the last-queued refresh settles). */
  private catalogRefreshChain: Promise<unknown> = Promise.resolve();
  private catalogRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastUpdateCount = 0;
  private pendingRestart: Set<string> = new Set();
  private rendererLoadedThisSession: Set<string> = new Set();
  /** Bytes admitted for frontend snapshots whose backend activation is still
   * pending. Different plugin install locks may run concurrently. */
  private pendingRendererAssetBytes = 0;
  /** Frontends awaiting primary-renderer replacement. Exclude them from every
   * UI/asset response before slow backend teardown begins. */
  private rendererRevocations: Set<string> = new Set();
  /** Supplied by the desktop IPC layer so background marketplace updates can
   * revoke a frontend realm before changing its code or permissions. */
  private rendererReplacementHandler: ((pluginName: string) => Promise<void>) | null = null;
  private failedUpdates: Map<string, { attemptedVersion: string; runningVersion: string; error: string }> = new Map();
  private installLocks: Map<string, Promise<unknown>> = new Map();
  /** Plugins disabled for the current session only (not persisted to config). */
  private sessionDisabled: Set<string> = new Set();

  private brandRequiredPluginNamesSet: Set<string>;
  /**
   * Plugin names whose required-plugin AUTO-UPDATE must be deferred: they are
   * owed post-update cleanup by a prior attempt that hasn't reconciled yet.
   * Auto-updating (unload+reload) them at startup — which `initMarketplace` does
   * BEFORE the ledger is reconciled — would run their owed cleanup against a
   * different generation or make it unavailable (R35P1). The startup sequence
   * sets this before initMarketplace and clears it once reconciliation completes.
   */
  private deferredUpdateNames: Set<string> = new Set();
  /** When true, defer ALL required-plugin auto-updates (not just named ones).
   *  Used when the ledger can't tell us WHICH plugins are owed cleanup — a legacy
   *  marker (owed = "all active") or a corrupt/unreadable ledger — so we must
   *  conservatively hold every auto-update until reconciliation resolves (R35P1). */
  private deferAllUpdates = false;

  /** Whether an app-update FREEZE is currently active (`beginUpdateFreeze`). Kept
   *  SEPARATE from `deferAllUpdates`/`deferredUpdateNames` (which track GENUINE owed
   *  cleanup): the freeze must BLOCK lifecycle ops, but it must NOT make a plugin
   *  look like it "owes cleanup" — otherwise the strict-compat / integrity-source
   *  bypasses (meant only for genuinely-owed OLD generations) would wrongly apply to
   *  an in-flight install racing the drain, activating an incompatible plugin
   *  (R28P28). */
  private updateFreezeActive = false;

  /** Set by the most recent `loadAll` discovery pass: true if a plugin directory that
   *  `readdir` LISTED was then OMITTED because reading/parsing it threw (a transient
   *  statSync/manifest-read I/O failure — R38P1), as opposed to a deterministic
   *  non-plugin skip (not a directory, no manifest.json, invalid/mismatched name). A
   *  legacy post-update reconcile consults this: an omitted plugin may have owed
   *  cleanup that the "run all active" batch silently skipped, so the legacy marker
   *  must be retained (not dropped) until a launch discovers the full set. */
  private lastDiscoveryIncomplete = false;

  /** Set the plugin names whose auto-update is deferred until the caller clears
   *  it (post-update ledger reconciliation, R35P1). `all:true` defers EVERY
   *  required-plugin auto-update regardless of name (unknown owed set). */
  setDeferredUpdateNames(names: Iterable<string>, opts?: { all?: boolean }): void {
    this.deferredUpdateNames = new Set(names);
    this.deferAllUpdates = opts?.all === true;
  }

  clearDeferredUpdateNames(): void {
    this.deferredUpdateNames = new Set();
    this.deferAllUpdates = false;
  }

  /** Callback the updater/startup wires in to RE-RUN a specific plugin's owed
   *  post-update reconciliation once it becomes active LATE — e.g. after the user
   *  approves consent for an owed plugin that startup reconciliation had to SKIP as
   *  inactive (R30P2). Without it, approval loads the plugin but its owed cleanup
   *  (e.g. privilege revocation) never runs and the install block persists until
   *  another restart. Optional; a no-op default keeps PluginManager usable stand-alone. */
  private reconcileOwedForPlugin: (pluginName: string) => void | Promise<void> = () => {};
  setOwedCleanupReconciler(fn: (pluginName: string) => void | Promise<void>): void {
    this.reconcileOwedForPlugin = fn;
  }

  /** Snapshot of the deferral state captured by `beginUpdateFreeze`, restored by
   *  `endUpdateFreeze`. `null` when no freeze is active. */
  private updateFreezeSnapshot: { names: Set<string>; all: boolean } | null = null;

  /** FREEZE all plugin-generation replacement for the duration of an app-update
   *  attempt (R28P1). Sets `deferAllUpdates` so the periodic required-plugin
   *  refresh finds nothing eligible AND every explicit lifecycle op
   *  (disable/uninstall/kill/install) that consults `isUpdateDeferred` is refused —
   *  BOTH at entry and again inside its install-lock (via `assertNotFrozen`), so an
   *  op that passed its entry check while QUEUED still bails once it acquires the
   *  lock under the freeze. It then DRAINS any lifecycle op ALREADY running (holding
   *  an install lock) so a replacement in progress finishes before the updater
   *  samples plugins — closing the window where a swap/unload could invalidate a
   *  participant's captured cleanup between `stillFresh()` and quit. Idempotent: a
   *  second begin without an intervening end keeps the ORIGINAL snapshot and just
   *  re-drains.
   *
   *  BOUNDED by `timeoutMs` (monotonic): a lifecycle op holding an install lock can
   *  hang indefinitely, and an unbounded `Promise.allSettled` would leave
   *  `deferAllUpdates` (and the caller's `installInProgress`) stuck forever (R28P11).
   *  On timeout this THROWS so the caller aborts the update and lifts the freeze;
   *  the freeze snapshot is left in place for the caller's `endUpdateFreeze()`. */
  async beginUpdateFreeze(timeoutMs = 15_000): Promise<void> {
    // NOTE: the freeze uses its OWN `updateFreezeActive` flag, NOT `deferAllUpdates`
    // — so it blocks lifecycle ops WITHOUT making plugins look like they owe cleanup
    // (which would wrongly trigger the strict-compat / integrity bypasses, R28P28).
    // The snapshot still captures the genuine deferral so endUpdateFreeze restores it.
    if (!this.updateFreezeSnapshot) {
      this.updateFreezeSnapshot = { names: new Set(this.deferredUpdateNames), all: this.deferAllUpdates };
    }
    this.updateFreezeActive = true;
    // Drain lifecycle ops already in flight. New/queued ops can't start a
    // replacement now (deferAllUpdates + the in-lock assertNotFrozen recheck), so
    // once the current holders settle no generation swap is in progress. Bound the
    // wait on a MONOTONIC clock so a genuinely hung lock can't wedge the freeze.
    const deadline = performance.now() + timeoutMs;
    while (this.installLocks.size > 0) {
      if (performance.now() >= deadline) {
        throw new Error('Timed out draining in-flight plugin lifecycle operations before update freeze');
      }
      // Race the in-flight locks against a short timer so a hung lock doesn't block
      // the deadline check; re-loop to re-check size + deadline.
      const remaining = deadline - performance.now();
      await Promise.race([
        Promise.allSettled([...this.installLocks.values()]),
        new Promise((r) => setTimeout(r, Math.max(1, Math.min(100, remaining)))),
      ]);
    }
    // Refuse the freeze if a plugin update is UNRESOLVED and AWAITING A LIVE CONSENT
    // PROMPT whose ROLLBACK metadata lives ONLY in memory (R28P16b / R36P2). Such an
    // install released its install lock (so the drain above didn't see it); letting
    // the app quit now would lose the in-memory rollback stash — a subsequent denial
    // couldn't restore the prior generation. The guard must be the INTERSECTION of a
    // live prompt AND a rollback stash:
    //   • A pending consent with NO rollback (startup discovery, or a FIRST-TIME
    //     marketplace install) has no prior generation to preserve — the prompt is
    //     simply re-derived from disk after relaunch, so blocking the app update for
    //     it would force the user to resolve an unrelated consent prompt before
    //     updating Kai, for no safety benefit (R36P2).
    //   • A rollback stash with NO live prompt is the DISABLED-plugin update case
    //     (resolved on next enable); blocking every app update on that — with nothing
    //     for the user to resolve — would wedge updates for the session (R28P27). It
    //     is a lesser concern (its generation isn't running) and is cleared on
    //     uninstall.
    // Only when BOTH hold is there a running, unapproved generation with in-memory-
    // only rollback that a quit would strand — AND that rollback must actually
    // PRESERVE a prior generation. A FIRST-TIME marketplace install requiring consent
    // creates a `pendingConsentRollback` entry with `backupDir` UNDEFINED (there is no
    // prior generation to restore); blocking the app-update freeze on that would force
    // the user to resolve an unrelated first-install prompt before updating Kai, for
    // no safety benefit — a quit loses nothing recoverable (R49P2). So require a real
    // backup (backupDir, or a prior installed/approval record) before blocking.
    for (const name of this.pendingConsent.keys()) {
      const rollback = this.pendingConsentRollback.get(name);
      if (rollback && (rollback.backupDir || rollback.priorInstalledRecord || rollback.priorApproval)) {
        throw new Error('A plugin update is awaiting consent; resolve it before updating the app');
      }
    }
  }

  /** Throw if an app-update freeze is active — used INSIDE the install lock by the
   *  explicit lifecycle ops so a QUEUED op that passed its entry check before the
   *  freeze still refuses to replace a generation once it acquires the lock
   *  (R28P1). */
  private assertNotFrozen(pluginName: string): void {
    if (this.updateFreezeActive || this.deferAllUpdates || this.deferredUpdateNames.has(pluginName)) {
      throw new Error(`Plugin "${pluginName}" is finishing a previous update. Please try again in a moment.`);
    }
  }

  /** Throw ONLY if a transient app-update FREEZE is active — NOT merely because the
   *  plugin is deferred (owes cleanup). Used by CONSENT resolution
   *  (approve/deny): a plugin that owes post-update cleanup but reached startup
   *  consent (approval missing/mismatched) must be able to resolve consent, because
   *  approving is exactly how it LOADS and runs its owed cleanup hook — and denying
   *  is how it rolls back. Gating consent on `isUpdateDeferred` (freeze OR deferred)
   *  would DEADLOCK (R28P46): the plugin can't load → cleanup never runs → the
   *  deferral never clears → consent stays unresolvable → the debt is discarded
   *  after the give-up cap. Only the ACTUAL in-progress app-update freeze blocks
   *  consent (its generation swaps must not race the updater's sampled set). */
  private assertNoActiveFreeze(pluginName: string): void {
    if (this.updateFreezeActive) {
      throw new Error(`Plugin "${pluginName}" is finishing a previous update. Please try again in a moment.`);
    }
  }

  /** END the app-update freeze, RESTORING the pre-freeze deferral state. Callers
   *  that need to RETAIN specific plugins as deferred (a rollback that left
   *  cleanup owed) must call `deferUpdates(...)` AFTER this, so those names are
   *  re-added on top of the restored snapshot rather than clobbered by it. No-op
   *  if no freeze is active. */
  endUpdateFreeze(): void {
    this.updateFreezeActive = false;
    if (!this.updateFreezeSnapshot) return;
    this.deferredUpdateNames = this.updateFreezeSnapshot.names;
    this.deferAllUpdates = this.updateFreezeSnapshot.all;
    this.updateFreezeSnapshot = null;
  }

  /** UpdateHookRunner.freezePluginUpdates — alias of `beginUpdateFreeze` (async:
   *  it drains in-flight lifecycle ops before resolving). */
  freezePluginUpdates(): Promise<void> {
    return this.beginUpdateFreeze();
  }

  /** UpdateHookRunner.unfreezePluginUpdates — alias of `endUpdateFreeze`. */
  unfreezePluginUpdates(): void {
    this.endUpdateFreeze();
  }

  /** ADD names to the deferred set without disturbing the existing deferral (or
   *  the `deferAllUpdates` flag). Called by the updater when a rollback/teardown
   *  RETAINS cleanup debt for specific plugins mid-session, so a periodic refresh
   *  or explicit lifecycle op can't replace that generation before the user
   *  relaunches and the next-launch reconciler runs the owed cleanup (R6P2/R7). */
  addDeferredUpdateNames(names: Iterable<string>): void {
    for (const n of names) this.deferredUpdateNames.add(n);
  }

  /** UpdateHookRunner.deferUpdates — alias of addDeferredUpdateNames used by the
   *  auto-updater to defer plugins whose rollback debt it just retained (R7). */
  deferUpdates(names: readonly string[]): void {
    this.addDeferredUpdateNames(names);
  }

  /** Whether replacing this plugin's generation is currently deferred because it
   *  (or, under `deferAllUpdates`, any plugin) owes un-reconciled post-update
   *  cleanup. Both the automatic required-plugin refresh AND explicit user
   *  installs/updates consult this so neither replaces a generation mid-cleanup
   *  (R5P2). */
  isUpdateDeferred(pluginName: string): boolean {
    // Includes the transient FREEZE: while an app update is in progress, replacing
    // ANY generation is refused, not just genuinely-owed ones.
    return this.updateFreezeActive || this.deferAllUpdates || this.deferredUpdateNames.has(pluginName);
  }

  /** Whether this plugin GENUINELY owes un-reconciled post-update cleanup (per the
   *  ledger-seeded deferral), as opposed to merely being blocked by the transient
   *  app-update freeze. This — NOT `isUpdateDeferred` — gates the strict-compat and
   *  integrity-source BYPASSES for a preserved OLD generation: those must apply ONLY
   *  to a real owed generation, never to an unrelated install that happens to race
   *  the freeze drain (R28P28). */
  private ownsGenuineCleanupDebt(pluginName: string): boolean {
    return this.deferAllUpdates || this.deferredUpdateNames.has(pluginName);
  }

  /**
   * UI-state broadcast coalescing + dedup. broadcastUIState() is called from
   * many triggers (plugin load, config change, and — frequently — plugin
   * publishedState updates via onUIStateChanged). Rebuilding + broadcasting the
   * FULL snapshot on every call is wasteful: the snapshot can be large (a plugin
   * that publishes big state), and successive calls are often byte-identical or
   * arrive in bursts. Debounce a burst into one emit, and skip the emit entirely
   * when the serialized snapshot hasn't changed since the last broadcast.
   */
  private uiStateBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBroadcastUIStateJson = '';

  constructor(
    private pluginsDir: string,
    private appHome: string,
    private getConfig: () => AppConfig,
    private setConfig: (path: string, value: unknown) => void,
    private brandRequiredPluginNames: string[],
    private revokePrimaryRendererAuthority: () => void,
  ) {
    this.brandRequiredPluginNamesSet = new Set(brandRequiredPluginNames);
  }

  /* ── Discovery ── */

  private discoverPlugins(opts?: { throwOnReadError?: boolean }): Array<{ manifest: PluginManifest; dir: string }> {
    // Reset the incompleteness flag for THIS pass; only the loadAll path (which passes
    // `throwOnReadError`) records per-entry read failures into it (R38P1).
    if (opts?.throwOnReadError) this.lastDiscoveryIncomplete = false;
    // Classify the plugins-dir existence: a transient stat error is NOT "absent"
    // (R39P1). On the faithful-discovery path propagate it (like a readdir failure);
    // elsewhere keep the lenient empty result. Only genuine ENOENT returns [].
    const dirState = pathAvailability(this.pluginsDir);
    if (dirState === 'error') {
      if (opts?.throwOnReadError) {
        throw new Error(`Plugins directory could not be read: ${this.pluginsDir}`);
      }
      return [];
    }
    if (dirState === 'absent') return [];

    const results: Array<{ manifest: PluginManifest; dir: string }> = [];
    let entries: string[];

    try {
      entries = readdirSync(this.pluginsDir);
    } catch (err) {
      // A TRANSIENT directory-read failure (EMFILE/EIO/EACCES/EBUSY…) is NOT the same
      // as an empty plugins directory. Silently returning [] here makes the whole
      // plugin set look empty, which for the startup legacy post-update reconcile is
      // catastrophic: with no active/pending/errored/loading plugins, the "run all
      // active" batch reports allSucceeded and the legacy marker is dropped, so owed
      // cleanup (e.g. privilege revocation) is permanently lost (R37P1). Callers that
      // need a faithful full listing (loadAll) pass `throwOnReadError` so the failure
      // propagates and aborts loading (main.ts then blocks installs and preserves the
      // ledger). Single-plugin lookups keep the lenient [] (a missing dir just means
      // "not found").
      if (opts?.throwOnReadError) throw err;
      return [];
    }

    for (const entry of entries) {
      if (entry.startsWith('.') || entry.endsWith('.prev')) continue;
      const pluginDir = join(this.pluginsDir, entry);
      try {
        if (!statSync(pluginDir).isDirectory()) continue;
      } catch (err) {
        // `readdir` listed this entry but `statSync` (which follows symlinks) threw.
        // Distinguish TRANSIENT I/O (retryable → discovery incomplete → block installs
        // so a possibly-owed plugin isn't lost, R38P1) from DETERMINISTIC debris — a
        // dangling symlink (ENOENT) or a symlink loop (ELOOP) fails identically every
        // launch, so flagging it would PERMANENTLY wedge all app updates with no UI
        // recovery (R41P1). Only a transient error flags incompleteness; deterministic
        // debris is skipped + surfaced.
        if (opts?.throwOnReadError && isTransientFsError(err)) this.lastDiscoveryIncomplete = true;
        console.warn(`[PluginManager] Failed to stat plugin entry "${entry}":`, err);
        continue;
      }

      const manifestPath = join(pluginDir, 'plugin.json');
      // Classify the manifest path with the errno in hand (R41P1): ENOENT (incl. a
      // dangling symlink target) = "not a plugin directory" → deterministic skip; a
      // symlink loop (ELOOP) or other DETERMINISTIC error is likewise skipped without
      // blocking; only a TRANSIENT read failure marks discovery incomplete (the
      // manifest may really be there). A bare `pathAvailability` would collapse the
      // errno, so stat directly here.
      let manifestPresent: boolean;
      try {
        statSync(manifestPath);
        manifestPresent = true;
      } catch (err) {
        manifestPresent = false;
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          if (opts?.throwOnReadError && isTransientFsError(err)) this.lastDiscoveryIncomplete = true;
          console.warn(`[PluginManager] Failed to stat plugin manifest at ${manifestPath}:`, err);
        }
      }
      if (!manifestPresent) continue;

      try {
        const manifest = readPluginManifest(pluginDir, entry);
        manifest.permissions = effectivePluginPermissions(pluginDir, manifest.permissions);
        // The plugin name is used as an on-disk path segment (plugin-settings/
        // <name>/) and as an identity key. Reject a name that isn't a strict slug
        // or that doesn't match its directory — a crafted name like "../../x"
        // would otherwise escape the plugin-settings namespace (reachable via
        // renderer IPC get/set), and a name != dir lets a plugin impersonate
        // another.
        if (!isValidPluginName(manifest.name)) {
          console.warn(`[PluginManager] Skipping plugin in "${entry}": invalid manifest name "${manifest.name}"`);
          continue;
        }
        if (manifest.name !== entry) {
          console.warn(
            `[PluginManager] Skipping plugin in "${entry}": manifest name "${manifest.name}" does not match its directory`,
          );
          continue;
        }
        results.push({ manifest, dir: pluginDir });
      } catch (err) {
        // The manifest EXISTS but couldn't be read/parsed/validated. Distinguish the
        // two cases (R40P1#structured):
        //   • TRANSIENT I/O (EIO/EACCES/EMFILE/EBUSY/ENFILE/EAGAIN…) — a retry can
        //     clear it, and the plugin may owe cleanup → flag discovery incomplete so
        //     installs block until a clean launch reads it.
        //   • DETERMINISTIC defect (malformed JSON, size/symlink/name limit) — a retry
        //     will NEVER succeed, so flagging it would WEDGE all app updates forever
        //     with no in-app recovery (the plugin isn't in plugin:list). Do NOT flag;
        //     just skip + surface the warning. A genuinely-broken local plugin must not
        //     hold the whole app's updates hostage.
        if (opts?.throwOnReadError && isTransientFsError(err)) this.lastDiscoveryIncomplete = true;
        console.warn(`[PluginManager] Failed to read plugin manifest at ${manifestPath}:`, err);
      }
    }

    // Sort: requiredPlugins first (in their configured order), then the rest alphabetically
    results.sort((a, b) => {
      const aIdx = this.brandRequiredPluginNames.indexOf(a.manifest.name);
      const bIdx = this.brandRequiredPluginNames.indexOf(b.manifest.name);
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      if (aIdx !== -1) return -1;
      if (bIdx !== -1) return 1;
      return a.manifest.name.localeCompare(b.manifest.name);
    });
    return results;
  }

  /* ── Loading ── */

  private getPluginApprovals(): AppConfig['pluginApprovals'] {
    return this.getConfig().pluginApprovals ?? {};
  }

  private isPluginApproved(pluginName: string, fileHash: string, permissions: readonly string[]): boolean {
    const approval = this.getPluginApprovals()[pluginName];
    if (!approval || approval.hash !== fileHash) return false;
    return approvalPermissionsMatch(approval.permissions, permissions);
  }

  private persistPluginApproval(pluginName: string, fileHash: string, permissions: readonly string[]): void {
    this.setConfig('pluginApprovals', {
      ...this.getPluginApprovals(),
      [pluginName]: {
        hash: fileHash,
        permissions: [...permissions],
        approvedAt: new Date().toISOString(),
      },
    });
  }

  /** Permissions that require explicit user consent via modal. */
  /** Plugins waiting for user consent. Maps pluginName → pending load info. */
  private pendingConsent: Map<string, { manifest: PluginManifest; fileHash: string }> = new Map();
  private pendingConsentRollback: Map<
    string,
    { attemptedVersion: string } & Pick<InstallResult, 'backupDir' | 'priorInstalledRecord' | 'priorApproval'>
  > = new Map();

  private hasDangerousPermissions(manifest: PluginManifest): boolean {
    return manifest.permissions.some((p) => DANGEROUS_PLUGIN_PERMISSIONS.has(p));
  }

  private buildConsentRequest(manifest: PluginManifest, fileHash: string): PluginConsentRequest {
    const permissions = manifest.permissions ?? [];
    return {
      pluginName: manifest.name,
      displayName: manifest.displayName ?? manifest.name,
      permissions,
      dangerousPermissions: permissions.filter((p) => DANGEROUS_PLUGIN_PERMISSIONS.has(p)),
      execScope: manifest.execScope,
      fileHash,
    };
  }

  private migrateLegacyRequiredBrowserPermission(manifest: PluginManifest, fileHash: string, pluginDir: string): void {
    if (!this.marketplaceService || !this.brandRequiredPluginNamesSet.has(manifest.name)) return;
    if (!existsSync(join(pluginDir, 'frontend.js'))) return;
    const declaredPermissions = readPluginManifest(pluginDir, manifest.name).permissions;
    if (declaredPermissions.includes(AUTHENTICATED_BROWSER_PERMISSION)) return;

    const config = this.getConfig();
    const installed = config.marketplace?.installedPlugins?.[manifest.name];
    const approval = config.pluginApprovals?.[manifest.name];
    if (!installed?.fileHash || installed.fileHash !== fileHash || installed.version !== manifest.version) return;

    const installedCurrent = arePermissionSetsEqual(installed.permissions, manifest.permissions);
    const installedLegacy = isLegacyInferredBrowserPermissionSnapshot(installed.permissions, manifest.permissions);
    if (!installedCurrent && !installedLegacy) return;
    if (approval?.hash && approval.hash !== fileHash) return;
    const approvalCurrent =
      !!approval?.permissions && arePermissionSetsEqual(approval.permissions, manifest.permissions);
    const approvalLegacy = isLegacyInferredBrowserPermissionSnapshot(approval?.permissions, manifest.permissions);
    if (approval?.permissions && !approvalCurrent && !approvalLegacy) return;
    if (!installedLegacy && approvalCurrent) return;

    const catalogEntry = this.marketplaceService.getCachedCatalog()?.find((entry) => entry.name === manifest.name);
    if (catalogEntry) {
      if (catalogEntry.version !== manifest.version) return;
      const expectedHash = this.getMarketplaceExpectedFileHash(catalogEntry);
      if (expectedHash && expectedHash !== fileHash) return;
    }

    this.setConfig('marketplace.installedPlugins', {
      ...(config.marketplace?.installedPlugins ?? {}),
      [manifest.name]: { ...installed, permissions: [...manifest.permissions] },
    });
    console.info(`[PluginManager] Upgraded install metadata for required plugin "${manifest.name}"`);
  }

  private ensurePluginApproved(manifest: PluginManifest, fileHash: string, pluginDir: string): boolean {
    if (this.brandRequiredPluginNamesSet.has(manifest.name)) {
      this.migrateLegacyRequiredBrowserPermission(manifest, fileHash, pluginDir);
      if (!this.isRequiredPluginIntegrityTrusted(manifest, fileHash)) {
        console.error(`[PluginManager] Required plugin "${manifest.name}" failed integrity verification`);
        return false;
      }
      if (!this.isPluginApproved(manifest.name, fileHash, manifest.permissions)) {
        if (manifest.permissions.includes(AUTHENTICATED_BROWSER_PERMISSION)) {
          this.pendingConsent.set(manifest.name, { manifest, fileHash });
          broadcastToAllWindows('plugin:consent-required', this.buildConsentRequest(manifest, fileHash));
          console.info(
            `[PluginManager] Required plugin "${manifest.name}" needs consent for authenticated Browser access`,
          );
          return false;
        }
        this.persistPluginApproval(manifest.name, fileHash, manifest.permissions);
      }
      return true;
    }

    // All non-brand-required plugins require explicit user consent
    if (!this.isPluginApproved(manifest.name, fileHash, manifest.permissions)) {
      // Store pending consent and notify renderer
      this.pendingConsent.set(manifest.name, { manifest, fileHash });
      broadcastToAllWindows('plugin:consent-required', this.buildConsentRequest(manifest, fileHash));
      console.info(
        `[PluginManager] Plugin "${manifest.name}" requires user consent for: ${manifest.permissions.join(', ')}`,
      );
      return false; // Block loading until user consents
    }
    return true;
  }

  /** Called by IPC when user approves a dangerous plugin. `expectedFileHash` (the
   *  hash the CLIENT was shown) guards against a STALE cross-request decision
   *  (R28P55): with multiple clients, request R1 can be resolved and a rollback /
   *  new install can create R2 for the SAME plugin name with a DIFFERENT hash +
   *  permissions; a client still holding R1 must not have its decision applied to
   *  R2 (which could approve permissions it never saw). We validate the live pending
   *  entry's hash matches inside the lock; on mismatch we no-op so the client
   *  re-syncs and re-prompts against R2. */
  async approveAndReload(pluginName: string, expectedFileHash?: string): Promise<boolean> {
    const pending = this.pendingConsent.get(pluginName);
    if (!pending) return false;

    // Serialize with disable/enable and marketplace ops for the same plugin so an
    // in-flight disable can't interleave with this approval reload and leave the
    // plugin active after the user disabled it.
    return this.withInstallLock(pluginName, async () => {
      // Re-check inside the lock: approval LOADS/activates a generation, which must
      // not happen during an ACTIVE app-update freeze (it could introduce a plugin
      // whose veto/post-update hook isn't in the committed ledger, R28P12). But a
      // plugin that merely OWES cleanup (deferred) MUST still be approvable — that's
      // how it loads and runs its owed cleanup; blocking it here would deadlock
      // (R28P46). So gate on the active freeze only, not the deferral.
      this.assertNoActiveFreeze(pluginName);
      // Re-check: a concurrent disable/deny may have cleared the pending consent
      // while we waited for the lock.
      const stillPending = this.pendingConsent.get(pluginName);
      if (!stillPending) return false;
      // Stale cross-request guard (R28P55): the live request must be the SAME one the
      // client decided on. If a different generation now holds the prompt, ignore
      // this stale approval — the client re-syncs and re-prompts.
      if (expectedFileHash !== undefined && stillPending.fileHash !== expectedFileHash) {
        return false;
      }

      this.persistPluginApproval(pluginName, stillPending.fileHash, stillPending.manifest.permissions);
      this.pendingConsent.delete(pluginName);

      // Re-discover the plugin directory
      const discovered = this.discoverPlugins();
      const pluginInfo = discovered.find((p) => p.manifest.name === pluginName);
      if (!pluginInfo) {
        // AWAIT the rollback INSIDE the lock (R28P43): it unloads/restores/reloads
        // the prior generation, so detaching it (void) would release the install
        // lock while a generation swap is still in flight — an app-update freeze
        // drain could then finish mid-replacement and fail freshness. Holding the
        // lock through it keeps the swap atomic w.r.t. the freeze + other lifecycle
        // ops. A throw is contained so approve still returns false cleanly.
        try {
          await this.resolvePendingConsentRollback(pluginName, false, 'Plugin not found after approval');
        } catch (err) {
          console.error(`[plugins] consent rollback for "${pluginName}" failed:`, err);
        }
        return false;
      }

      // Load the plugin now that it's approved (loadPlugin honors the disabled
      // guard, so a plugin disabled meanwhile stays a disabled stub).
      await this.loadPlugin(pluginInfo.manifest, pluginInfo.dir);
      const instance = this.plugins.get(pluginName);
      await this.resolvePendingConsentRollback(pluginName, instance?.state === 'active', instance?.error);
      // If this plugin OWES un-reconciled post-update cleanup and just became ACTIVE
      // via approval, startup reconciliation already SKIPPED it (it was inactive
      // then). Re-run its owed cleanup NOW so it isn't stranded and the install block
      // clears without another restart (R30P2). Detached (best-effort) so approval
      // still returns promptly; the reconciler is idempotent + serial.
      if (instance?.state === 'active' && this.ownsGenuineCleanupDebt(pluginName)) {
        try {
          void Promise.resolve(this.reconcileOwedForPlugin(pluginName)).catch((err) =>
            console.error(`[plugins] post-approval owed-cleanup reconcile for "${pluginName}" failed:`, err),
          );
        } catch (err) {
          console.error(`[plugins] post-approval owed-cleanup reconcile for "${pluginName}" threw:`, err);
        }
      }
      return true;
    });
  }

  /** Called by IPC when user denies a dangerous plugin. ASYNC + fully serialized:
   *  ALL consent-state mutation AND the rollback-vs-no-rollback DECISION happen
   *  INSIDE the install lock, AFTER the freeze recheck (R28P17/R28P20). Deciding the
   *  branch inside the lock closes a TOCTOU where a same-plugin marketplace update
   *  queued ahead populates `pendingConsentRollback` only after we'd snapshotted it
   *  as empty — which would take the no-rollback branch and strand the backup +
   *  denied generation. Rejects (throws) if frozen so the caller keeps the prompt
   *  up and retries. */
  async denyPlugin(pluginName: string, expectedFileHash?: string): Promise<void> {
    await this.withInstallLock(pluginName, async () => {
      // Gate on the ACTIVE freeze only, not the deferral: a denial of a plugin that
      // owes cleanup must still be resolvable so its rollback can run — blocking it
      // on `isUpdateDeferred` would deadlock the consent prompt (R28P46). Its
      // generation swap during an actual freeze is still refused.
      this.assertNoActiveFreeze(pluginName);
      // STALE-request guard (R28P53): if `pendingConsent` no longer holds this
      // plugin, a PRIOR queued deny/approve for the SAME prompt already resolved it
      // (two clients denying the same prompt, or a deny queued behind an approve).
      // Proceeding would consume a non-existent request and — via the no-rollback
      // branch below — mark the freshly restored/approved generation as `error`,
      // corrupting a plugin that's now valid. Ignore the stale request (no-op).
      const current = this.pendingConsent.get(pluginName);
      if (!current) {
        return;
      }
      // Stale CROSS-request guard (R28P55): the live request must be the SAME one the
      // client decided on. A different generation now holding the prompt (rollback /
      // new install created R2 with a different hash) means this decision was for a
      // request the user no longer sees — ignore it; the client re-syncs.
      if (expectedFileHash !== undefined && current.fileHash !== expectedFileHash) {
        return;
      }
      // Re-read the rollback state now that we hold the lock: an update that was
      // queued ahead of us may have just populated it (R28P20).
      const hasRollback = this.pendingConsentRollback.has(pluginName);
      // From HERE the consent state is CONSUMED (pendingConsent deleted). A failure
      // in the rollback below must NOT surface as a retryable "freeze refusal": the
      // prompt's underlying request is already gone, so keeping the modal up (and
      // letting a retry no-op) would strand the rejected generation (R28P50). We
      // therefore SWALLOW a post-consumption rollback error here (logged; the failed
      // rollback is itself surfaced via setFailedUpdate inside resolvePendingConsentRollback)
      // so denyPlugin RESOLVES — the modal correctly drops the stale prompt. Only the
      // PRE-mutation `assertNoActiveFreeze` throw above propagates as retryable.
      this.pendingConsent.delete(pluginName);
      if (hasRollback) {
        // Roll back the installed generation atomically under this same lock.
        try {
          await this.resolvePendingConsentRollback(pluginName, false, 'Permission denied by user');
        } catch (err) {
          console.error(
            `[plugins] consent-denial rollback for "${pluginName}" failed (consent already consumed):`,
            err,
          );
        }
      } else {
        // Plain consent denial — no generation to roll back.
        const instance = this.plugins.get(pluginName);
        if (instance) {
          instance.state = 'error';
          instance.error = 'Permission denied by user';
          this.broadcastUIState();
        }
      }
    });
  }

  private async resolvePendingConsentRollback(pluginName: string, activated: boolean, error?: string): Promise<void> {
    const stash = this.pendingConsentRollback.get(pluginName);
    if (!stash) return;
    this.pendingConsentRollback.delete(pluginName);

    if (activated || !stash.backupDir) {
      if (stash.backupDir) this.marketplaceService?.discardBackup(stash.backupDir);
      this.setFailedUpdate(pluginName, null);
      return;
    }

    await this.unloadPlugin(pluginName);
    this.marketplaceService?.rollbackInstall(pluginName, stash.backupDir, stash);
    const restored = this.discoverPlugins().find((d) => d.manifest.name === pluginName);
    if (restored) await this.loadPlugin(restored.manifest, restored.dir);

    const runningVersion =
      this.plugins.get(pluginName)?.manifest.version ?? stash.priorInstalledRecord?.version ?? 'unknown';
    this.setFailedUpdate(pluginName, {
      attemptedVersion: stash.attemptedVersion,
      runningVersion,
      error: error ?? 'Update was not approved',
    });
    // The rejected generation never exposed renderer assets: loadPlugin stops
    // at the consent gate before assigning rendererBuild. An active frontend
    // update already replaced the renderer before installing, while a disabled
    // or backend-only plugin had no old frontend in this renderer generation.
    // The restored build can therefore load normally without a restart banner.
    this.clearPendingRestart(pluginName);
    this.broadcastUpdateCount();
  }

  /** Get list of plugins pending consent. */
  getPendingConsent(): PluginConsentRequest[] {
    return Array.from(this.pendingConsent.values()).map((info) =>
      this.buildConsentRequest(info.manifest, info.fileHash),
    );
  }

  /** True if any plugin is currently awaiting consent (held inactive until the user
   *  approves). Such a plugin is NOT in the active set, so a "run all active" legacy
   *  post-update batch silently omits it — the startup reconciler uses this to avoid
   *  dropping a legacy attempt whose cleanup for a consent-pending plugin hasn't run
   *  yet (R33P1). */
  hasPendingConsent(): boolean {
    return this.pendingConsent.size > 0;
  }

  /** True if any discovered plugin is in an UNRESOLVED activation state — `error`
   *  (activation failed this launch, e.g. after an update) or `loading` (still
   *  settling). Such a plugin is not in the active set, so a "run all active" legacy
   *  post-update batch omits it even though it may have performed privileged setup
   *  before failing and still owes cleanup. The startup reconciler uses this (with
   *  `hasPendingConsent`) to avoid dropping a legacy marker while such a plugin's
   *  cleanup could not run (R34P1). `disabled` is EXCLUDED: it's a deliberate user
   *  opt-out and was never part of the "all active" batch scope. */
  hasUnresolvedActivation(): boolean {
    for (const instance of this.plugins.values()) {
      if (instance.state === 'error' || instance.state === 'loading') return true;
    }
    return false;
  }

  /** True if the most recent `loadAll` discovery OMITTED a listed plugin directory
   *  because reading/parsing it threw (R38P1) — a transient statSync/manifest-read
   *  failure, not a deterministic non-plugin skip. An omitted plugin never enters the
   *  active set, so a "run all active" legacy batch can't run its (possibly-owed)
   *  cleanup; the startup reconciler uses this to retain the legacy marker until a
   *  launch discovers the full set (bounded by the give-up cap). */
  hadIncompleteDiscovery(): boolean {
    return this.lastDiscoveryIncomplete;
  }

  private isRequiredPluginIntegrityTrusted(manifest: PluginManifest, fileHash: string): boolean {
    // A plugin that owes un-reconciled post-update cleanup is DEFERRED: bootstrap
    // deliberately kept its OLD generation on disk so the reconciler can run its
    // post-update hook against matching code (R28P1). That old generation will NOT
    // match a NEWER catalog entry / bundled resource, so validating it against the
    // new source would reject the load — its cleanup hook would never register, the
    // ledger would block installs, and the debt would eventually be discarded
    // (R28P6). For a deferred plugin we therefore trust the PREVIOUSLY-PERSISTED
    // installed record (hash + version + permissions the user already approved) and
    // SKIP comparison against the newer source. The newer generation is validated
    // normally once reconciliation clears the deferral and a later launch installs it.
    // Gate the source-comparison bypass on GENUINE owed cleanup, NOT the transient
    // freeze (R28P28): an unrelated install racing the freeze drain must not be
    // trusted against a stale record.
    const deferred = this.ownsGenuineCleanupDebt(manifest.name);
    if (this.marketplaceService) {
      const installedInfo = this.getConfig().marketplace?.installedPlugins?.[manifest.name];
      // A DEFERRED bundled required plugin records its approval in `pluginApprovals`,
      // NOT `marketplace.installedPlugins` — and a release can INTRODUCE marketplace
      // URLs (making `marketplaceService` truthy) AFTER that bundled plugin already
      // owed cleanup, so no `installedInfo` exists (R33P2). Rejecting here would leave
      // the owed generation unloadable, its cleanup hook unregistered, and the debt
      // abandoned at the give-up cap. So for a deferred generation with no marketplace
      // install record, fall back to the same bundled/`pluginApprovals` trust the
      // no-marketplace path uses below.
      if (deferred && !installedInfo?.fileHash) {
        return this.isDeferredBundledApprovalTrusted(manifest, fileHash);
      }
      if (!installedInfo?.fileHash || installedInfo.fileHash !== fileHash) return false;
      if (installedInfo.version !== manifest.version) return false;
      // Exact-match is the norm. For a DEFERRED generation, ALSO accept the single
      // rollout migration where the persisted snapshot predates the host-inferred
      // authenticated-Browser permission and the manifest adds exactly that one
      // (R31P2). Rejecting it would leave the owed plugin unloadable — its cleanup
      // hook never registers, installs stay blocked, and the debt is discarded at
      // the give-up cap. The hash+version already match the approved generation, so
      // this is the same trusted code; and because the added permission IS the
      // authenticated-Browser one, `ensurePluginApproved` still gates activation
      // behind a fresh consent prompt — integrity tolerance never bypasses consent.
      const permsOk = deferred
        ? deferredPermissionsTrusted(installedInfo.permissions, manifest.permissions, 'exact')
        : !!installedInfo.permissions && arePermissionSetsEqual(installedInfo.permissions, manifest.permissions);
      if (!permsOk) return false;

      if (!deferred) {
        const entry = this.marketplaceService.getCachedCatalog()?.find((plugin) => plugin.name === manifest.name);
        if (entry && entry.version !== manifest.version) return false;
        const expectedFileHash = entry ? this.getMarketplaceExpectedFileHash(entry) : undefined;
        if (expectedFileHash && expectedFileHash !== fileHash) return false;
      }

      return true;
    }

    // Bundled (no marketplace): a deferred plugin's on-disk generation won't match
    // the newer bundled resource. Trust the persisted `pluginApprovals` record for
    // the deferred generation (R28P6).
    if (deferred) {
      return this.isDeferredBundledApprovalTrusted(manifest, fileHash);
    }
    const bundledIntegrity = getBundledPluginIntegrity(manifest.name);
    return (
      bundledIntegrity?.fileHash === fileHash &&
      bundledIntegrity.version === manifest.version &&
      arePermissionSetsEqual(bundledIntegrity.permissions, manifest.permissions)
    );
  }

  /**
   * Integrity trust for a DEFERRED (owed-cleanup) plugin backed by a `pluginApprovals`
   * record rather than a marketplace install (bundled required plugins, or a plugin
   * whose marketplace record predates a later marketplace-URL rollout — R33P2). The
   * stored hash uniquely identifies the approved generation; we only SKIP comparison
   * against the newer bundled/catalog resource, not the hash itself.
   *
   * Permission-snapshot handling mirrors the marketplace branch, PLUS the legacy
   * hash-ONLY approval that predates permission snapshots entirely (`permissions`
   * undefined — R33P3): a hash match proves it's the approved code, so trust it for
   * INTEGRITY and let consent gate activation. `ensurePluginApproved` re-prompts
   * whenever the manifest carries `browser:authenticated-session` (the only permission
   * the host infers), so this never activates un-consented Browser access — it just
   * lets the preserved generation LOAD far enough to reach the consent gate and
   * register its cleanup hook. A modern approval WITH a snapshot still goes through
   * `deferredPermissionsTrusted` (exact match OR the narrow inferred-Browser delta).
   */
  private isDeferredBundledApprovalTrusted(manifest: PluginManifest, fileHash: string): boolean {
    const approval = this.getConfig().pluginApprovals?.[manifest.name];
    if (!approval || approval.hash !== fileHash) return false;
    // Legacy hash-only approval (no permission snapshot): hash match is sufficient
    // for integrity; consent re-prompts for any inferred Browser permission (R33P3).
    if (!approval.permissions) return true;
    return deferredPermissionsTrusted(approval.permissions, manifest.permissions, 'approval');
  }

  private getMarketplaceExpectedFileHash(entry: MarketplaceCatalogEntry): string | undefined {
    return entry.fileHash ?? entry.hash;
  }

  private validatePluginConfig(manifest: PluginManifest, input: unknown): Record<string, unknown> {
    const normalized = normalizePluginObject(input);
    if (!manifest.configSchema) {
      return normalized;
    }

    try {
      const validator = convertJsonSchemaToZod(manifest.configSchema);
      const parsed = validator.safeParse(normalized);
      if (parsed.success) {
        return normalizePluginObject(parsed.data);
      }

      const defaults = validator.safeParse({});
      if (defaults.success) {
        console.warn(`[PluginManager] Resetting invalid config for plugin "${manifest.name}" to schema defaults`);
        return normalizePluginObject(defaults.data);
      }

      console.warn(`[PluginManager] Plugin "${manifest.name}" config schema validation failed; preserving raw config`);
      return normalized;
    } catch (err) {
      console.warn(`[PluginManager] Failed to validate config for plugin "${manifest.name}":`, err);
      return normalized;
    }
  }

  private ensurePluginConfigNormalized(pluginName: string): Record<string, unknown> {
    const instance = this.plugins.get(pluginName);
    if (!instance) return {};

    const config = this.getConfig();
    const plugins = (config as Record<string, unknown>).plugins as Record<string, unknown> | undefined;
    const raw = plugins?.[pluginName];
    const validated = this.validatePluginConfig(instance.manifest, raw);
    const current = normalizePluginObject(raw);
    if (JSON.stringify(current) !== JSON.stringify(validated)) {
      this.setConfig(`plugins.${pluginName}`, validated);
    }
    return validated;
  }

  async loadAll(): Promise<void> {
    // Throw on a directory-read failure rather than treating it as an empty plugin
    // set (R37P1): loading zero plugins here would let the startup legacy reconcile
    // conclude nothing is owed and drop the marker. A throw aborts loading; main.ts's
    // loader catch then blocks installs and leaves the ledger intact for a retry.
    const discovered = this.discoverPlugins({ throwOnReadError: true });
    console.info(`[PluginManager] Discovered ${discovered.length} plugins`);

    // loadPlugin() itself skips persistently-disabled plugins (registering a
    // 'disabled' stub), so this loop stays simple and that guard is the single
    // source of truth across all load paths.
    for (const { manifest, dir } of discovered) {
      const existing = this.plugins.get(manifest.name);
      if (existing) {
        // Already loaded by an EARLIER path (e.g. initMarketplace's required-plugin
        // auto-install, which runs before loadAll). If that path left an `error` stub
        // from a TRANSIENT failure, this faithful pass must still mark discovery
        // incomplete so installs block — otherwise loadAll would silently skip it and
        // an app update could bypass the plugin's pre-update veto (R51P1).
        if (existing.transientLoadFailure) this.lastDiscoveryIncomplete = true;
        continue;
      }
      // Faithful startup pass: a transient activation failure marks discovery
      // incomplete → installs block (R43P1).
      await this.loadPlugin(manifest, dir, { faithful: true });
    }

    this.broadcastUIState();
  }

  private createPluginInstance(manifest: PluginManifest, dir: string, state: PluginInstance['state']): PluginInstance {
    return {
      manifest,
      dir,
      fileHash: '',
      state,
      module: null,
      registeredTools: [],
      preSendHooks: [],
      postReceiveHooks: [],
      preUpdateHooks: [],
      postUpdateHooks: [],
      uiBanners: [],
      uiModals: [],
      uiSettingsSections: [],
      uiPanels: [],
      uiNavigationItems: [],
      uiCommands: [],
      conversationDecorations: [],
      threadDecorations: [],
      publishedState: {},
      notifications: [],
      configChangeListeners: [],
      rendererBuild: null,
      inferenceProvider: null,
      contributedCliTools: [],
      declaredEvents: [],
      declaredActions: [],
      eventUnsubscribers: [],
      agentHookUnsubscribers: [],
    };
  }

  /** Names of plugins the user has persistently disabled (config-backed). */
  private getPersistentlyDisabled(): Set<string> {
    return new Set(this.getConfig().pluginSystem?.disabledPlugins ?? []);
  }

  /** True while a plugin is loading or active — i.e. its API may legitimately fire. */
  private isPluginLive(pluginName: string): boolean {
    const state = this.plugins.get(pluginName)?.state;
    return state === 'active' || state === 'loading';
  }

  /**
   * True only when `instance` is still the current activation generation for its
   * plugin AND that generation is live. A stale callback captured by a previous
   * activation (before a disable/enable cycle replaced the instance) fails this
   * check even if a fresh instance is now live under the same name.
   */
  private isCurrentInstance(instance: PluginInstance): boolean {
    const current = this.plugins.get(instance.manifest.name);
    if (current !== instance) return false;
    // 'loading'/'active' are normal live states. Also allow privileged calls
    // while the instance is running its own teardown (deactivate/cleanup), even
    // if its state is 'error' from a partially-failed activation — otherwise
    // teardown can't release resources like an HTTP server.
    return current.state === 'active' || current.state === 'loading' || current.tearingDown === true;
  }

  /** Clear both persistent and session disabled flags for a plugin. */
  private clearDisabledState(pluginName: string): void {
    this.sessionDisabled.delete(pluginName);
    const persisted = this.getPersistentlyDisabled();
    if (persisted.delete(pluginName)) {
      this.setConfig('pluginSystem.disabledPlugins', [...persisted]);
    }
  }

  private async loadPlugin(manifest: PluginManifest, dir: string, opts?: { faithful?: boolean }): Promise<void> {
    // `faithful` = this load is part of the startup loadAll faithful pass, where a
    // TRANSIENT activation failure means the active set is incomplete and installs
    // must block (R43P1). A single mid-session reload (restore/enable) does NOT set
    // that session-wide flag — it would wrongly wedge installs with no loadAll to
    // clear it. Default false.
    const faithful = opts?.faithful === true;
    const pluginCorrelationId = newDiagnosticCorrelationId(`plugin-${manifest.name}`);
    traceDiagnostic({
      scope: 'plugin',
      event: 'plugin.load-start',
      correlationId: pluginCorrelationId,
      pluginName: manifest.name,
      fields: { version: manifest.version },
    });
    // Honor disabled plugins in every load path (startup, marketplace
    // update/reinstall swaps, etc.) so a disabled plugin can never be silently
    // reactivated. This covers both persistent disables (config-backed) and
    // session-only disables (in-memory). Required plugins ignore disables and
    // always load.
    const isDisabled = this.getPersistentlyDisabled().has(manifest.name) || this.sessionDisabled.has(manifest.name);
    if (isDisabled && !this.brandRequiredPluginNamesSet.has(manifest.name)) {
      this.plugins.set(manifest.name, this.createPluginInstance(manifest, dir, 'disabled'));
      this.broadcastUIState();
      this.notifyToolsChanged();
      traceDiagnostic({
        scope: 'plugin',
        event: 'plugin.load-skipped',
        correlationId: pluginCorrelationId,
        pluginName: manifest.name,
        fields: { reason: 'disabled' },
      });
      console.info(`[PluginManager] Plugin "${manifest.name}" is disabled — skipping load`);
      return;
    }

    const instance: PluginInstance = this.createPluginInstance(manifest, dir, 'loading');
    let rendererReservationBytes = 0;
    const releaseRendererReservation = (): void => {
      if (rendererReservationBytes === 0) return;
      this.pendingRendererAssetBytes = Math.max(0, this.pendingRendererAssetBytes - rendererReservationBytes);
      rendererReservationBytes = 0;
    };

    this.plugins.set(manifest.name, instance);

    try {
      // Capture the renderer bytes before backend activation. A plugin backend
      // is unrestricted code and may mutate its own install directory; it must
      // not be able to create or replace frontend.js after consent and thereby
      // gain the primary renderer's authenticated Browser bridge.
      const approvedSnapshot = snapshotPluginDirectory(dir);
      instance.fileHash = approvedSnapshot.fileHash;
      if (
        approvedSnapshot.files.has('frontend.js') &&
        !manifest.permissions.includes(AUTHENTICATED_BROWSER_PERMISSION)
      ) {
        manifest.permissions = [...manifest.permissions, AUTHENTICATED_BROWSER_PERMISSION];
      }
      if (!this.ensurePluginApproved(manifest, instance.fileHash, dir)) {
        const awaitingConsent = this.pendingConsent.has(manifest.name);
        instance.state = 'error';
        instance.error = awaitingConsent
          ? 'Plugin permission approval is required before it can be loaded.'
          : this.brandRequiredPluginNamesSet.has(manifest.name)
            ? 'Required plugin integrity verification failed. Reinstall or update the plugin from a trusted source.'
            : 'Plugin permission approval is required before it can be loaded.';
        this.broadcastUIState();
        this.notifyToolsChanged();
        traceDiagnostic({
          scope: 'plugin',
          event: 'plugin.load-rejected',
          level: 'warn',
          correlationId: pluginCorrelationId,
          pluginName: manifest.name,
          fields: { reason: awaitingConsent ? 'approval-required' : 'integrity-verification-failed' },
        });
        return;
      }

      const approvedRendererBuild = approvedSnapshot.files.has('frontend.js')
        ? buildPluginRendererBundle({
            pluginName: manifest.name,
            pluginDir: dir,
            rendererPath: 'frontend.js',
            snapshot: approvedSnapshot,
          })
        : null;
      this.ensurePluginConfigNormalized(manifest.name);

      // Check plugin compatibility constraints (engines.kai + capabilities)
      const compat = checkPluginCompatibility(manifest);
      if (!compat.compatible) {
        const mode = this.getConfig().pluginSystem?.compatibilityMode ?? 'warn';
        // A DEFERRED plugin owes un-reconciled post-update cleanup: bootstrap kept
        // its OLD generation on disk precisely so its post-update hook can run
        // against matching code. That old generation's `engines.kai` range may
        // EXCLUDE the newly-bumped host — but rejecting it under strict mode would
        // mean its cleanup hook never registers, stranding privileged setup (e.g.
        // temporary elevation) and eventually discarding the debt (R28P26). So a
        // deferred plugin loads DESPITE strict-mode incompatibility (treated like
        // warn mode: banner + load). It can't be replaced while deferred, and once
        // reconciliation clears the debt a later launch installs the compatible new
        // generation and re-applies strict mode normally.
        if (mode === 'strict' && !this.ownsGenuineCleanupDebt(manifest.name)) {
          instance.state = 'error';
          instance.error = `Incompatible: ${compat.errors.join('; ')}`;
          console.warn(`[PluginManager] Plugin "${manifest.name}" blocked (strict mode): ${compat.errors.join('; ')}`);
          this.broadcastUIState();
          this.notifyToolsChanged();
          traceDiagnostic({
            scope: 'plugin',
            event: 'plugin.load-rejected',
            level: 'warn',
            correlationId: pluginCorrelationId,
            pluginName: manifest.name,
            fields: { reason: 'incompatible-strict', errors: compat.errors },
          });
          return;
        }
        // warn mode (or a deferred plugin under strict): store warning, continue loading
        instance.compatWarning = compat;
        console.warn(`[PluginManager] Plugin "${manifest.name}" compatibility warning: ${compat.errors.join('; ')}`);
      }

      // Load backend entry point from backend.js. Classify existence errno-aware
      // (R43P1): a genuine ENOENT means the plugin really has no backend → deterministic
      // "missing backend" error. A TRANSIENT read failure must NOT be collapsed to
      // "missing" (that would skip the backend + its pre-update veto and mis-mark the
      // plugin); flag discovery incomplete so installs block for the session, and mark
      // the instance error for a next-launch retry.
      const backendPath = join(dir, 'backend.js');
      const backendState = pathAvailability(backendPath);
      if (backendState !== 'present') {
        const transient = backendState === 'error';
        console.warn(
          `[PluginManager] Plugin "${manifest.name}" backend.js ${transient ? 'unreadable (transient)' : 'not found'} - skipping`,
        );
        instance.state = 'error';
        instance.error = transient
          ? `Plugin backend could not be read (will retry): ${backendPath}`
          : `Plugin backend not found: ${backendPath}`;
        if (transient) instance.transientLoadFailure = true; // R51P1: loadAll honors it even if a prior path made this stub
        if (transient && faithful) this.lastDiscoveryIncomplete = true;
        this.broadcastUIState();
        this.notifyToolsChanged();
        traceDiagnostic({
          scope: 'plugin',
          event: 'plugin.load-rejected',
          level: 'warn',
          correlationId: pluginCorrelationId,
          pluginName: manifest.name,
          fields: { reason: transient ? 'backend-unreadable' : 'missing-backend' },
        });
        return;
      }

      const api = createPluginAPI(instance, {
        appHome: this.appHome,
        isLive: () => this.isCurrentInstance(instance),
        getConfig: () => this.getConfig(),
        setConfig: (path, value) => {
          // Block persistent config writes from a stale activation generation.
          if (!this.isCurrentInstance(instance)) return;
          this.setConfig(path, value);
        },
        getPluginConfig: () => this.getPluginConfig(manifest.name),
        setPluginConfig: (path, value) => {
          if (!this.isCurrentInstance(instance)) return;
          this.setPluginConfig(manifest.name, path, value);
        },
        getPluginState: () => ({ ...instance.publishedState }),
        replacePluginState: (next) => {
          if (!this.isCurrentInstance(instance)) return;
          instance.publishedState = normalizePluginObject(next);
          this.broadcastUIState();
        },
        setPluginState: (path, value) => {
          if (!this.isCurrentInstance(instance)) return;
          const next = { ...instance.publishedState };
          setNestedValue(next, path, value);
          instance.publishedState = next;
          this.broadcastUIState();
        },
        emitPluginEvent: (eventName, data) => {
          // Drop events from a stale activation generation (e.g. a timer that
          // survived a disable/enable cycle) or from a plugin that is currently
          // tearing down — a deactivate()-time emit could otherwise re-enter
          // the same plugin via an automation `plugin-action` rule while its
          // resources are being released.
          if (!this.isCurrentInstance(instance) || instance.tearingDown) return;
          eventBus.emit(`plugin.${manifest.name}`, eventName, data);
        },
        subscribeBus: (key, handler) => {
          if (!this.isCurrentInstance(instance) || instance.tearingDown) return () => {};
          return eventBus.subscribe((e) => {
            if (!this.isCurrentInstance(instance) || instance.tearingDown) return;
            if (key === '*' || e.key === key) handler(e);
          });
        },
        onEventsDeclared: () => {
          if (!this.isCurrentInstance(instance) || instance.tearingDown) return;
          eventBus.registerSource({
            source: `plugin.${manifest.name}`,
            displayName: manifest.displayName,
            events: [...instance.declaredEvents],
            actions: [...instance.declaredActions],
          });
        },
        onUIStateChanged: () => this.broadcastUIState(),
        onToolsChanged: () => this.notifyToolsChanged(),
        onCliToolsChanged: () => this.notifyCliToolsChanged(),
        onInferenceProviderChanging: (provider) => this.revokeBrowserAssistantAccessForInstance(instance, provider),
        registerActionHandler: (targetId, handler) => {
          // Ignore registrations from a stale activation generation so old async
          // code can't write into the current generation's action map.
          if (!this.isCurrentInstance(instance)) return;
          this.registerActionHandler(manifest.name, targetId, handler);
        },
        showNotification: (descriptor) => {
          if (!this.isCurrentInstance(instance)) return;
          this.showPluginNotification(manifest.name, descriptor);
        },
        dismissNotification: (id) => {
          if (!this.isCurrentInstance(instance)) return;
          this.dismissPluginNotification(manifest.name, id);
        },
        openNavigationTarget: (target) => {
          if (!this.isCurrentInstance(instance)) return;
          this.broadcastNavigationRequest(manifest.name, target);
        },
      });
      this.pluginAPIs.set(manifest.name, api);

      // Clear hook arrays before activate to prevent duplicates on reload (issue #36)
      instance.preSendHooks = [];
      instance.postReceiveHooks = [];
      instance.preUpdateHooks = [];
      instance.postUpdateHooks = [];
      instance.configChangeListeners = [];
      for (const off of instance.agentHookUnsubscribers) {
        try {
          off();
        } catch {}
      }
      instance.agentHookUnsubscribers = [];

      const runtimeSelection = selectPluginHostRuntime(manifest, dir, backendPath);
      console.info(`[PluginManager] ${manifest.name}: ${runtimeSelection.runtime} (${runtimeSelection.reason})`);
      // `instance.fileHash` is the hash of the WHOLE plugin directory (approval /
      // trust). The isolated runtime performs a byte-level TOCTOU check against
      // backend.js specifically, so pass its own SHA-256 — comparing backend
      // bytes to the directory hash makes every normal multi-file plugin fail
      // with "backend changed after integrity verification" (exposed by SEA).
      const backendHash = hashPluginFile(backendPath);
      // Bind that byte hash to the directory snapshot that was actually approved.
      // If any plugin file changed between the initial approval hash and this
      // backend read, abort instead of blessing the changed bytes with a fresh
      // backend hash. The child independently checks backend.js again against
      // backendHash, closing the remaining manager→runtime TOCTOU window.
      const verifiedDirectoryHash = hashPluginDirectory(dir);
      if (verifiedDirectoryHash !== instance.fileHash) {
        throw new Error(`Plugin "${manifest.name}" changed after integrity verification`);
      }
      if (approvedRendererBuild) {
        assertActivePluginRendererBudget(
          [...this.plugins.values()]
            .filter((candidate) => candidate !== instance)
            .flatMap((candidate) => (candidate.rendererBuild ? [candidate.rendererBuild] : [])),
          approvedRendererBuild,
          this.pendingRendererAssetBytes,
        );
        rendererReservationBytes = pluginRendererBuildBytes(approvedRendererBuild);
        this.pendingRendererAssetBytes += rendererReservationBytes;
      }
      const processHost = new PluginProcessHost({
        manifest,
        pluginDir: dir,
        backendPath,
        backendHash,
        api,
        utilityEntryPath: join(import.meta.dirname, 'plugin-host.js'),
        syncWorkerPath: join(import.meta.dirname, 'plugin-sync-worker.js'),
        runtime: runtimeSelection.runtime,
        seaHostPath: runtimeSelection.seaHostPath,
        runtimeReason: runtimeSelection.reason,
        onUnexpectedExit: (details) => this.handleUnexpectedPluginExit(instance, details),
      });
      this.pluginProcesses.set(manifest.name, processHost);
      await processHost.activate();

      if (approvedRendererBuild) {
        releaseRendererReservation();
        instance.rendererBuild = approvedRendererBuild;
        this.rendererLoadedThisSession.add(manifest.name);
      }

      instance.state = 'active';
      instance.error = undefined;
      traceDiagnostic({
        scope: 'plugin',
        event: 'plugin.load-complete',
        correlationId: pluginCorrelationId,
        pluginName: manifest.name,
        fields: { runtime: runtimeSelection.runtime, reason: runtimeSelection.reason },
      });

      // Show compatibility warning banner if loaded in warn mode
      if (instance.compatWarning) {
        instance.uiBanners.push({
          id: `compat-warning-${manifest.name}`,
          pluginName: manifest.name,
          text: `This plugin may be incompatible: ${instance.compatWarning.errors.join('; ')}`,
          variant: 'warning',
          dismissible: true,
          visible: true,
        });
      }

      this.broadcastUIState();
      this.notifyToolsChanged();
      console.info(`[PluginManager] Plugin "${manifest.name}" activated`);
    } catch (err) {
      releaseRendererReservation();
      let browserRevocationFailure: unknown = null;
      try {
        this.revokeBrowserAssistantAccessForInstance(instance);
      } catch (error) {
        browserRevocationFailure = error;
        instance.tearingDown = true;
      }
      traceDiagnostic({
        scope: 'plugin',
        event: 'plugin.load-failed',
        level: 'error',
        correlationId: pluginCorrelationId,
        pluginName: manifest.name,
        fields: { error: err },
      });
      instance.state = 'error';
      instance.error = err instanceof Error ? err.message : String(err);
      for (const off of instance.eventUnsubscribers) {
        try {
          off();
        } catch {}
      }
      instance.eventUnsubscribers = [];
      for (const off of instance.agentHookUnsubscribers) {
        try {
          off();
        } catch {}
      }
      instance.agentHookUnsubscribers = [];
      instance.declaredEvents = [];
      instance.declaredActions = [];
      eventBus.unregisterSource(`plugin.${manifest.name}`);
      // Activation may have already started API-managed resources (e.g. an HTTP
      // server) before throwing. Clearing subscriptions alone leaves those live
      // until app exit — run the same API cleanup unloadPlugin() uses so a failed
      // activation can't leak resources.
      try {
        const api = this.pluginAPIs.get(manifest.name);
        if (api) await cleanupPluginAPI(api);
      } catch (cleanupErr) {
        console.error(
          `[PluginManager] Error cleaning up API after failed activation of "${manifest.name}":`,
          cleanupErr,
        );
      }
      const processHost = this.pluginProcesses.get(manifest.name);
      if (processHost) {
        await processHost.stop(true);
        this.pluginProcesses.delete(manifest.name);
      }
      this.broadcastUIState();
      this.notifyToolsChanged();
      console.error(`[PluginManager] Failed to load plugin "${manifest.name}":`, err);
      // A TRANSIENT activation failure (snapshotPluginDirectory / backend hashing hits
      // EIO/EACCES/…) leaves the plugin in `error` state but is retryable next launch.
      // The plugin is now absent from the active set, so an app update run now could
      // bypass its pre-update veto (R43P1) — the same risk as incomplete DISCOVERY.
      // Record it as discovery incompleteness so the install-block check (R40P1) trips
      // for the session. A DETERMINISTIC activation error (bad code, incompatible API)
      // is NOT flagged — it fails identically every launch and must not permanently
      // wedge updates (the plugin's `error` row surfaces it instead).
      const transientLoad = isTransientFsError(err);
      // Mark the FACT of a transient failure on the instance regardless of `faithful`,
      // so loadAll's faithful pass can honor it even when an EARLIER non-faithful path
      // (e.g. initMarketplace's required-plugin auto-install) produced this error stub
      // and loadAll would otherwise skip it as "already loaded" (R51P1).
      if (transientLoad) instance.transientLoadFailure = true;
      if (transientLoad && faithful) this.lastDiscoveryIncomplete = true;
      if (browserRevocationFailure) throw browserRevocationFailure;
    }
  }

  /**
   * A crash, fatal V8 error, or explicit process.exit() is contained to the
   * owning plugin. Remove every main-side proxy it registered, keep the
   * instance as an error row for the UI, and leave the other plugin processes
   * untouched.
   */
  private async handleUnexpectedPluginExit(
    instance: PluginInstance,
    details: { code: number; error?: string },
  ): Promise<void> {
    if (!this.isCurrentInstance(instance) || instance.tearingDown) return;
    const pluginName = instance.manifest.name;
    const rendererReplacementRequired = this.rendererUnloadRequired(pluginName);
    try {
      this.beginRendererUnload(pluginName);
    } catch (error) {
      // The crashed provider is already blocked by rendererRevocations (for a
      // frontend) or tearingDown (for a backend-only provider). Continue
      // resource cleanup, but retain the revocation failure for diagnostics.
      instance.tearingDown = true;
      console.error(`[PluginManager] Error revoking Browser access for crashed plugin "${pluginName}":`, error);
    }
    let rendererReplacement: Promise<boolean> | null = null;
    if (rendererReplacementRequired) {
      const replaceRenderer = this.rendererReplacementHandler;
      if (!replaceRenderer) {
        console.error(
          `[PluginManager] Cannot revoke crashed frontend plugin "${pluginName}" because no renderer replacement handler is registered.`,
        );
      } else {
        try {
          // Start revocation before any asynchronous API cleanup. A crashed
          // backend must not leave its frontend realm using the authenticated
          // Browser bridge while teardown waits on unrelated resources.
          rendererReplacement = replaceRenderer(pluginName).then(
            () => true,
            (error) => {
              console.error(`[PluginManager] Error replacing renderer for crashed plugin "${pluginName}":`, error);
              return false;
            },
          );
        } catch (error) {
          console.error(`[PluginManager] Error replacing renderer for crashed plugin "${pluginName}":`, error);
        }
      }
    }
    if (!rendererReplacementRequired) {
      try {
        this.revokeBrowserAssistantAccessForInstance(instance);
      } catch (error) {
        instance.tearingDown = true;
        console.error(`[PluginManager] Error revoking Browser access for crashed plugin "${pluginName}":`, error);
      }
    }
    instance.state = 'error';
    instance.error = details.error ?? `Plugin process exited unexpectedly (code ${details.code})`;
    instance.registeredTools = [];
    instance.preSendHooks = [];
    instance.postReceiveHooks = [];
    instance.preUpdateHooks = [];
    instance.postUpdateHooks = [];
    instance.configChangeListeners = [];
    instance.inferenceProvider = null;
    instance.contributedCliTools = [];
    instance.declaredEvents = [];
    instance.declaredActions = [];
    instance.uiBanners = [];
    instance.uiModals = [];
    instance.uiSettingsSections = [];
    instance.uiPanels = [];
    instance.uiNavigationItems = [];
    instance.uiCommands = [];
    instance.conversationDecorations = [];
    instance.threadDecorations = [];
    instance.notifications = [];
    instance.publishedState = {};
    for (const off of instance.eventUnsubscribers.splice(0)) {
      try {
        off();
      } catch {}
    }
    for (const off of instance.agentHookUnsubscribers.splice(0)) {
      try {
        off();
      } catch {}
    }
    eventBus.unregisterSource(`plugin.${pluginName}`);
    this.actionHandlers.delete(pluginName);
    for (const [key, timer] of this.notificationTimers.entries()) {
      if (!key.startsWith(`${pluginName}:`)) continue;
      clearTimeout(timer);
      this.notificationTimers.delete(key);
    }
    for (const [key, notification] of this.nativeNotifications.entries()) {
      if (!key.startsWith(`${pluginName}:`)) continue;
      try {
        notification.close();
      } catch {
        // Best-effort cleanup for a process that is already failing.
      }
      this.nativeNotifications.delete(key);
    }
    try {
      const api = this.pluginAPIs.get(pluginName);
      if (api) await cleanupPluginAPI(api);
    } catch (error) {
      console.error(`[PluginManager] Error cleaning up crashed plugin "${pluginName}":`, error);
    }
    if (await rendererReplacement) {
      // The replacement destroyed the only renderer realm that could consume
      // this immutable snapshot. The errored instance remains visible in the UI,
      // but retaining its assets would leak memory and keep counting against the
      // process-wide frontend budget until a later explicit unload.
      instance.rendererBuild = null;
      this.acknowledgeRendererUnload(pluginName);
    }
    this.broadcastUIState();
    this.notifyToolsChanged();
    this.notifyCliToolsChanged();
  }

  /* ── Unloading ── */

  async unloadAll(): Promise<void> {
    // Stop periodic catalog refresh
    if (this.catalogRefreshTimer) {
      clearInterval(this.catalogRefreshTimer);
      this.catalogRefreshTimer = null;
    }
    // Cancel any pending debounced UI-state broadcast so it can't fire after teardown.
    if (this.uiStateBroadcastTimer) {
      clearTimeout(this.uiStateBroadcastTimer);
      this.uiStateBroadcastTimer = null;
    }

    // Unload in reverse of load order: non-required plugins first (reverse alpha), then required plugins in reverse order
    const sorted = [...this.plugins.entries()].sort(([, a], [, b]) => {
      const aIdx = this.brandRequiredPluginNames.indexOf(a.manifest.name);
      const bIdx = this.brandRequiredPluginNames.indexOf(b.manifest.name);
      if (aIdx !== -1 && bIdx !== -1) return bIdx - aIdx;
      if (aIdx !== -1) return 1;
      if (bIdx !== -1) return -1;
      return b.manifest.name.localeCompare(a.manifest.name);
    });

    for (const [name, instance] of sorted) {
      instance.tearingDown = true;
      this.revokeBrowserAssistantAccessForInstance(instance);
      try {
        await this.pluginProcesses.get(name)?.deactivate();
      } catch (err) {
        console.error(`[PluginManager] Error deactivating plugin "${name}":`, err);
      }
      try {
        const api = this.pluginAPIs.get(name);
        if (api) {
          await cleanupPluginAPI(api);
        }
      } catch (err) {
        console.error(`[PluginManager] Error cleaning up plugin API for "${name}":`, err);
      }
      instance.tearingDown = false;
      this.pluginProcesses.delete(name);
    }

    for (const timer of this.notificationTimers.values()) {
      clearTimeout(timer);
    }

    this.plugins.clear();
    this.pluginAPIs.clear();
    this.pluginProcesses.clear();
    this.actionHandlers.clear();
    this.notificationTimers.clear();
    this.notifyToolsChanged();
  }

  private async unloadPlugin(pluginName: string): Promise<void> {
    const instance = this.plugins.get(pluginName);
    if (!instance) return;

    // Revoke before deactivate(): a backend process may take its full timeout
    // to acknowledge teardown while an already-running turn still holds tool
    // definitions bound from this provider.
    instance.tearingDown = true;
    this.revokeBrowserAssistantAccessForInstance(instance);
    try {
      await this.pluginProcesses.get(pluginName)?.deactivate();
    } catch (err) {
      console.error(`[PluginManager] Error deactivating plugin "${pluginName}":`, err);
    }
    this.pluginProcesses.delete(pluginName);
    // Always run API cleanup (e.g. close HTTP servers) even if deactivate() threw,
    // so a partially-activated/errored plugin can't leak resources.
    try {
      const api = this.pluginAPIs.get(pluginName);
      if (api) {
        await cleanupPluginAPI(api);
      }
    } catch (err) {
      console.error(`[PluginManager] Error cleaning up plugin API for "${pluginName}":`, err);
    }
    instance.tearingDown = false;

    // Clear hook arrays to prevent dangling references from firing (issue #36)
    instance.preSendHooks = [];
    instance.postReceiveHooks = [];
    instance.preUpdateHooks = [];
    instance.postUpdateHooks = [];
    instance.configChangeListeners = [];

    for (const off of instance.eventUnsubscribers) {
      try {
        off();
      } catch {}
    }
    instance.eventUnsubscribers = [];
    for (const off of instance.agentHookUnsubscribers) {
      try {
        off();
      } catch {}
    }
    instance.agentHookUnsubscribers = [];
    instance.declaredEvents = [];
    instance.declaredActions = [];
    eventBus.unregisterSource(`plugin.${pluginName}`);

    this.actionHandlers.delete(pluginName);

    // Clean up inference provider
    if (instance.inferenceProvider) {
      console.info(`[PluginManager] Clearing inference provider from "${pluginName}"`);
      instance.inferenceProvider = null;
    }

    for (const [key, timer] of this.notificationTimers.entries()) {
      if (key.startsWith(`${pluginName}:`)) {
        clearTimeout(timer);
        this.notificationTimers.delete(key);
      }
    }

    // Close and drop any native OS notifications for this plugin. Their click
    // handler sends 'plugin:navigate-direct'; leaving them alive would let a
    // disabled/unloaded plugin still drive navigation from a stale notification.
    for (const [key, notification] of this.nativeNotifications.entries()) {
      if (key.startsWith(`${pluginName}:`)) {
        try {
          notification.close();
        } catch {
          /* best-effort */
        }
        this.nativeNotifications.delete(key);
      }
    }

    this.plugins.delete(pluginName);
    this.pluginAPIs.delete(pluginName);
  }

  /* ── Enable / Disable ── */

  /**
   * Disable a non-required plugin: tear down its backend (tools, hooks, IPC
   * action handlers, timers, inference provider) immediately, then leave a
   * `disabled` stub so it still appears in the UI.
   *
   * `persist: true` records the plugin in `pluginSystem.disabledPlugins` so it
   * stays disabled across restarts. `persist: false` disables it only for the
   * running session — the next app launch re-enables it.
   *
   * The renderer half of a plugin cannot be hot-unloaded (renderer modules are
   * URL-cached), so if a frontend bundle already shipped this session we flag a
   * pending restart to fully clear it.
   */
  async disablePlugin(pluginName: string, opts: { persist: boolean }): Promise<void> {
    if (this.brandRequiredPluginNamesSet.has(pluginName)) {
      throw new Error(`Plugin "${pluginName}" is required and cannot be disabled`);
    }

    // Refuse while the plugin owes un-reconciled post-update cleanup: disabling
    // unloads its process, so the startup reconciler could no longer run its owed
    // cleanup in-process (R6P1). Clears once reconciliation completes.
    if (this.isUpdateDeferred(pluginName)) {
      throw new Error(`Plugin "${pluginName}" is finishing a previous update. Please try again in a moment.`);
    }

    // Serialize with marketplace install/update/uninstall for the same plugin so
    // two unload/load sequences can't interleave and leave duplicate side effects
    // or a transiently-missing instance.
    await this.withInstallLock(pluginName, () => {
      // Re-check the freeze INSIDE the lock but BEFORE the renderer replacement: an
      // app-update may have started while this op was queued (past its entry
      // check). Checking here avoids a needless full renderer reload for a request
      // that will bail anyway (R28P9); the reload happens inside
      // withRendererReplacementForUpdate below.
      this.assertNotFrozen(pluginName);
      return this.withRendererReplacementForUpdate(pluginName, async () => {
        const existing = this.plugins.get(pluginName);
        if (!existing) {
          throw new Error(`Unknown plugin "${pluginName}"`);
        }

        // A plugin in 'loading' state has an in-flight loadPlugin()/activate()
        // promise that unloadPlugin() cannot cancel — tearing it down now would race
        // the activation and could leave handlers/timers registered after the stub
        // is installed. Reject; the caller can retry once it settles.
        if (existing.state === 'loading') {
          throw new Error(`Plugin "${pluginName}" is still loading — try again once it finishes`);
        }

        // A plugin awaiting permission consent is driven by a blocking consent modal
        // (pendingConsent / pendingConsentRollback). Disabling it here would leave
        // that modal stranded and a later approve/deny could reload or roll back a
        // plugin the user disabled. Make the user resolve consent first.
        if (this.pendingConsent.has(pluginName) || this.pendingConsentRollback.has(pluginName)) {
          throw new Error(`Plugin "${pluginName}" is awaiting permission approval — approve or deny it first`);
        }

        const { manifest, dir } = existing;
        const hadRenderer = this.rendererLoadedThisSession.has(pluginName);

        await this.unloadPlugin(pluginName);

        // Keep a stub so the plugin remains visible (and re-enablable) in the UI.
        this.plugins.set(pluginName, this.createPluginInstance(manifest, dir, 'disabled'));

        if (opts.persist) {
          // A persistent disable supersedes any prior session-only disable.
          this.sessionDisabled.delete(pluginName);
          const next = this.getPersistentlyDisabled();
          next.add(pluginName);
          this.setConfig('pluginSystem.disabledPlugins', [...next]);
        } else {
          // Session-only: tracked in memory so mid-session reload paths (marketplace
          // update, consent approval) keep it disabled until the next app launch.
          this.sessionDisabled.add(pluginName);
        }

        if (hadRenderer) {
          this.markPendingRestart(pluginName);
        }

        this.broadcastUIState();
        this.notifyToolsChanged();
        this.notifyCliToolsChanged();
        console.info(`[PluginManager] Plugin "${pluginName}" disabled (persist=${opts.persist})`);
      });
    });
  }

  /** Re-enable a previously disabled plugin and load it now. */
  async enablePlugin(pluginName: string): Promise<void> {
    // Required plugins are never disablable, so there's nothing to enable.
    if (this.brandRequiredPluginNamesSet.has(pluginName)) {
      throw new Error(`Plugin "${pluginName}" is required and is always enabled`);
    }
    // Only act on a plugin that is actually disabled — guard against stray
    // IPC/web-bridge calls for already-active or unknown plugins, which would
    // otherwise trigger an unintended hot-unload/reload.
    const current = this.plugins.get(pluginName);
    const isDisabled =
      current?.state === 'disabled' ||
      this.getPersistentlyDisabled().has(pluginName) ||
      this.sessionDisabled.has(pluginName);
    if (!isDisabled) {
      return;
    }

    // Refuse only while an ACTIVE app-update FREEZE is in effect (R43P2) — enabling
    // loads/activates the generation, which during the post-quitAndInstall window
    // could introduce a plugin whose veto/post-update hook is absent from the
    // committed ledger. But gate on the freeze ONLY, not the deferral: a plugin that
    // was DISABLED while it still owed post-update cleanup returns as a disabled stub
    // that startup can't run — enabling is the ONLY in-app path to load it and run
    // that owed hook, so blocking on `isUpdateDeferred` (freeze OR deferred) would
    // DEADLOCK exactly like the consent path did before R28P46: cleanup never runs,
    // the deferral never clears, and the ledger discards the debt at the give-up cap
    // (possibly leaving privileged setup active). Checked here (entry) and again
    // inside the lock (queued op).
    this.assertNoActiveFreeze(pluginName);

    // Serialize with marketplace lifecycle ops for the same plugin (see disablePlugin).
    await this.withInstallLock(pluginName, async () => {
      // Re-check the freeze inside the lock: an app-update may have started while
      // this enable was queued (R28P12).
      this.assertNoActiveFreeze(pluginName);
      // Multiple enable requests can all observe the disabled stub while they
      // wait behind another lifecycle operation. Re-check after acquiring the
      // lock so a queued duplicate cannot unload the generation just activated
      // by the preceding request.
      const lockedCurrent = this.plugins.get(pluginName);
      const stillDisabled =
        lockedCurrent?.state === 'disabled' ||
        this.getPersistentlyDisabled().has(pluginName) ||
        this.sessionDisabled.has(pluginName);
      if (!stillDisabled) return;

      this.clearDisabledState(pluginName);

      // If this plugin's frontend bundle already shipped earlier this session, the
      // renderer has it URL-cached and can't be re-imported without a restart, so
      // the backend can hot-reload now but a restart is still needed for the
      // frontend. Otherwise it's safe to clear the restart flag entirely.
      const rendererStale = this.rendererLoadedThisSession.has(pluginName);
      if (!rendererStale) {
        this.clearPendingRestart(pluginName);
      }

      // Tear down any existing instance through the proper unload path. A disabled
      // stub has no live module/timers so this is a no-op for it, but if enable is
      // somehow called over a live instance (web bridge, duplicate request) this
      // ensures deactivate()/API cleanup run before we reload.
      if (this.plugins.has(pluginName)) {
        await this.unloadPlugin(pluginName);
      }

      const found = this.discoverPlugins().find((d) => d.manifest.name === pluginName);
      if (!found) {
        throw new Error(`Plugin "${pluginName}" not found on disk`);
      }

      await this.loadPlugin(found.manifest, found.dir);

      // If this plugin was updated while disabled, swapToInstalledPlugin deferred
      // the rollback decision to now: validate the freshly-loaded version and roll
      // back to the stashed previous version if it failed consent/activation.
      if (this.pendingConsentRollback.has(pluginName) && !this.pendingConsent.has(pluginName)) {
        const reloaded = this.plugins.get(pluginName);
        await this.resolvePendingConsentRollback(pluginName, reloaded?.state === 'active', reloaded?.error);
      }

      // If this plugin OWED un-reconciled post-update cleanup and just became ACTIVE
      // via enable, startup reconciliation SKIPPED it (it was a disabled stub then).
      // Run its owed cleanup NOW so it isn't stranded and the install block clears
      // without another restart — same path as post-approval (R30P2/R43P2). Detached +
      // idempotent + serial.
      const enabledInstance = this.plugins.get(pluginName);
      if (enabledInstance?.state === 'active' && this.ownsGenuineCleanupDebt(pluginName)) {
        try {
          void Promise.resolve(this.reconcileOwedForPlugin(pluginName)).catch((err) =>
            console.error(`[plugins] post-enable owed-cleanup reconcile for "${pluginName}" failed:`, err),
          );
        } catch (err) {
          console.error(`[plugins] post-enable owed-cleanup reconcile for "${pluginName}" threw:`, err);
        }
      }

      if (rendererStale) {
        this.markPendingRestart(pluginName);
      }

      this.broadcastUIState();
      this.notifyToolsChanged();
      this.notifyCliToolsChanged();
      console.info(`[PluginManager] Plugin "${pluginName}" enabled`);
    });
  }

  /* ── Permissions / Queries ── */

  hasPermission(pluginName: string, permission: PluginPermission): boolean {
    return this.plugins.get(pluginName)?.manifest.permissions.includes(permission) ?? false;
  }

  /** Authorize host capabilities for the plugin that owns an inference
   * provider. Provider names are display strings and are not an identity; use
   * the registered object identity so one plugin cannot impersonate another. */
  inferenceProviderHasPermission(provider: PluginInferenceProvider, permission: PluginPermission): boolean {
    for (const instance of this.plugins.values()) {
      if (
        instance.state !== 'active' ||
        instance.tearingDown ||
        this.rendererRevocations.has(instance.manifest.name) ||
        instance.inferenceProvider !== provider
      )
        continue;
      return instance.manifest.permissions.includes(permission);
    }
    return false;
  }

  getPluginCount(): number {
    return this.plugins.size;
  }

  listPlugins(): PluginListEntry[] {
    return [...this.plugins.values()].map((instance) => ({
      name: instance.manifest.name,
      displayName: instance.manifest.displayName,
      version: instance.manifest.version,
      description: instance.manifest.description,
      state: instance.state,
      brandRequired: this.brandRequiredPluginNamesSet.has(instance.manifest.name),
      icon: instance.manifest.icon,
      error: instance.error,
      permissions: [...instance.manifest.permissions],
      capabilities: [...(instance.manifest.capabilities ?? [])],
    }));
  }

  getPluginInstance(pluginName: string): PluginInstance | null {
    return this.plugins.get(pluginName) ?? null;
  }

  async pausePlugin(pluginName: string): Promise<void> {
    // Refuse to pause while an app-update freeze is active or the plugin owes
    // cleanup (R28P37): pausing rejects the plugin's pending AND future callbacks
    // while leaving the instance 'active', so an in-flight pre/post-update hook's
    // cleanup could fail WITHOUT the generation-freshness check noticing (it only
    // watches unload/reload), leaving setup stranded and installs blocked for the
    // launch even after Resume. Entry check + in-lock recheck, mirroring the other
    // lifecycle ops. Resume stays available (it can only RE-enable a paused plugin).
    if (this.isUpdateDeferred(pluginName)) {
      throw new Error(`Plugin "${pluginName}" is finishing a previous update. Please try again in a moment.`);
    }
    await this.withInstallLock(pluginName, async () => {
      this.assertNotFrozen(pluginName);
      const instance = this.plugins.get(pluginName);
      const host = this.pluginProcesses.get(pluginName);
      if (!instance || instance.state !== 'active' || !host) {
        throw new Error(`Plugin "${pluginName}" is not active`);
      }
      host.pause();
    });
  }

  async resumePlugin(pluginName: string): Promise<void> {
    await this.withInstallLock(pluginName, async () => {
      const instance = this.plugins.get(pluginName);
      const host = this.pluginProcesses.get(pluginName);
      if (!instance || instance.state !== 'active' || !host) {
        throw new Error(`Plugin "${pluginName}" is not active`);
      }
      host.resume();
    });
  }

  async killPlugin(pluginName: string): Promise<void> {
    // Killing the process removes the in-process cleanup code the startup
    // reconciler needs, so refuse while the plugin owes un-reconciled post-update
    // cleanup (R6P1). Clears once reconciliation completes.
    if (this.isUpdateDeferred(pluginName)) {
      throw new Error(`Plugin "${pluginName}" is finishing a previous update. Please try again in a moment.`);
    }
    await this.withInstallLock(pluginName, async () => {
      // Re-check the freeze INSIDE the lock (R28P1): a queued kill must not tear
      // down a participant's process after an app-update began.
      this.assertNotFrozen(pluginName);
      const host = this.pluginProcesses.get(pluginName);
      if (!host) throw new Error(`Plugin "${pluginName}" has no running process`);
      await host.kill();
    });
  }

  private pluginSettingsPath(pluginName: string): string {
    // Defense-in-depth: discovery already rejects non-slug names, but this path
    // is derived from a name that also flows in via IPC — refuse anything that
    // isn't a strict slug so it can never escape the plugin-settings namespace.
    if (!isValidPluginName(pluginName)) {
      throw new Error(`Invalid plugin name: ${JSON.stringify(pluginName)}`);
    }
    const base = join(this.appHome, 'plugin-settings');
    const full = join(base, pluginName, 'settings.json');
    if (!resolve(full).startsWith(resolve(base) + sep)) {
      throw new Error(`Invalid plugin name: ${JSON.stringify(pluginName)}`);
    }
    return full;
  }

  getPluginConfig(pluginName: string): Record<string, unknown> {
    const instance = this.plugins.get(pluginName);
    if (!instance) return {};
    const settingsPath = this.pluginSettingsPath(pluginName);

    // Migrate from legacy in-plugin-dir settings.json if the new location doesn't exist yet
    if (!existsSync(settingsPath)) {
      const legacyPath = join(instance.dir, 'settings.json');
      if (existsSync(legacyPath)) {
        try {
          const legacyData = readFileSync(legacyPath, 'utf-8');
          const dir = join(this.appHome, 'plugin-settings', pluginName);
          mkdirSync(dir, { recursive: true });
          atomicWriteFileSync(settingsPath, legacyData);
          try {
            unlinkSync(legacyPath);
          } catch {
            /* best-effort cleanup */
          }
          console.info(`[PluginManager] Migrated settings for "${pluginName}" from plugin dir to ${settingsPath}`);
        } catch (err) {
          console.warn(`[PluginManager] Failed to migrate legacy settings for "${pluginName}":`, err);
        }
      }
    }

    try {
      if (existsSync(settingsPath)) {
        const raw = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        return this.validatePluginConfig(instance.manifest, raw);
      }
    } catch {
      // ignore malformed settings
    }
    return this.validatePluginConfig(instance.manifest, {});
  }

  resolveRendererAssetRequest(pluginName: string, assetPath: string): { data: Uint8Array; contentType: string } | null {
    const instance = this.plugins.get(pluginName);
    if (!instance || instance.state !== 'active' || !instance.rendererBuild || this.rendererRevocations.has(pluginName))
      return null;

    const data = instance.rendererBuild.assets.get(assetPath);
    if (!data) return null;

    return { data, contentType: instance.rendererBuild.mimeTypes[assetPath] ?? 'application/octet-stream' };
  }

  setPluginConfig(pluginName: string, path: string, value: unknown): void {
    const instance = this.plugins.get(pluginName);
    if (!instance) {
      throw new Error(`Unknown plugin "${pluginName}"`);
    }

    const next = this.getPluginConfig(pluginName);
    setNestedValue(next, path, value);
    const validated = this.validatePluginConfig(instance.manifest, next);
    const settingsPath = this.pluginSettingsPath(pluginName);
    const dir = join(this.appHome, 'plugin-settings', pluginName);
    mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(settingsPath, JSON.stringify(validated, null, 2));
    this.broadcastUIState();

    // Keep the isolated utility's synchronous config.getPluginData() mirror
    // canonical for writes originating from either the plugin or the renderer.
    this.pluginProcesses.get(pluginName)?.notifyPluginConfigChanged(validated);

    // Fire the plugin's own config-change listeners so api.config.onChanged
    // callbacks are triggered when plugin settings change (not just app config).
    // Plugins receive the redacted PluginSafeConfig unless they declared
    // 'config:read-secrets'; this mirrors api.config.get()'s behaviour and
    // prevents on-change broadcasts from leaking credentials to plugins that
    // never asked for them.
    const payload = resolvePluginConfigView(this.getConfig(), instance.manifest.permissions);
    for (const listener of instance.configChangeListeners) {
      try {
        listener(payload);
      } catch (err) {
        console.error(`[PluginManager] Error in plugin "${pluginName}" config listener:`, err);
      }
    }
  }

  /* ── Config Change Forwarding ── */

  onConfigChanged(config: AppConfig): void {
    // Compute the redacted view lazily and cache it so we don't run the
    // redactor once per plugin. Plugins that declared 'config:read-secrets'
    // receive the raw AppConfig; everyone else receives the same shared
    // PluginSafeConfig instance. Hook bodies treat the argument as
    // read-only — they cannot mutate the redacted view back into the
    // source because toPluginSafeConfig deep-clones.
    let safeConfig: PluginSafeConfig | null = null;
    const viewFor = (instance: PluginInstance): AppConfig | PluginSafeConfig => {
      if (instance.manifest.permissions.includes('config:read-secrets')) {
        return config;
      }
      if (!safeConfig) safeConfig = toPluginSafeConfig(config);
      return safeConfig;
    };

    for (const [name, instance] of this.plugins) {
      if (instance.state !== 'active') continue;

      const payload = viewFor(instance);

      try {
        this.pluginProcesses.get(name)?.notifyConfigChanged(payload);
      } catch (err) {
        console.error(`[PluginManager] Error in plugin "${name}" onConfigChanged:`, err);
      }

      for (const listener of instance.configChangeListeners) {
        try {
          listener(payload);
        } catch (err) {
          console.error(`[PluginManager] Error in plugin "${name}" config listener:`, err);
        }
      }
    }

    this.broadcastUIState();
  }

  /* ── Tool Aggregation ── */

  getAllPluginTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const instance of this.plugins.values()) {
      if (instance.state !== 'active') continue;
      tools.push(...instance.registeredTools);
    }
    return tools;
  }

  onToolsChanged(callback: (tools: ToolDefinition[]) => void): void {
    this.toolChangeCallback = callback;
    callback(this.getAllPluginTools());
  }

  private notifyToolsChanged(): void {
    this.toolChangeCallback?.(this.getAllPluginTools());
  }

  onCliToolsChanged(callback: () => void): void {
    this.cliToolChangeCallback = callback;
  }

  setBrowserAssistantRevocationHandler(callback: () => void): void {
    this.browserAssistantRevocationCallback = callback;
  }

  private revokeBrowserAssistantAccessForInstance(
    instance: PluginInstance,
    provider: PluginInferenceProvider | null = instance.inferenceProvider,
  ): void {
    if (!provider || !instance.manifest.permissions.includes(AUTHENTICATED_BROWSER_PERMISSION)) {
      return;
    }
    const revoke = this.browserAssistantRevocationCallback;
    if (!revoke) throw new Error('Browser assistant access could not be revoked because no handler is registered.');
    try {
      revoke();
    } catch (error) {
      throw new Error('Browser assistant access could not be revoked.', { cause: error });
    }
  }

  private notifyCliToolsChanged(): void {
    this.cliToolChangeCallback?.();
  }

  /* ── Message Hooks ── */

  /* ── Inference Provider ── */

  /**
   * Get an inference provider, optionally filtered by context.
   *
   * When `context` is provided, only returns a provider from a plugin whose
   * contributed runtimes include the resolved runtimeId, OR whose runtime IDs
   * match the model's provider key prefix. This prevents a plugin inference
   * provider from hijacking requests meant for other configured providers.
   *
   * When `context` is omitted, returns the first available provider (legacy behavior).
   */
  getInferenceProvider(context?: { runtimeId?: string; modelProviderKey?: string }): PluginInferenceProvider | null {
    for (const instance of this.plugins.values()) {
      if (instance.state !== 'active' || instance.tearingDown || this.rendererRevocations.has(instance.manifest.name))
        continue;
      if (!instance.inferenceProvider || !instance.inferenceProvider.isAvailable()) continue;

      // If no context provided, return first available (legacy behavior)
      if (!context) {
        return instance.inferenceProvider;
      }

      // Match by model provider key — the provider key conventionally includes
      // the plugin/provider name, so e.g. "legionio_sonnet" matches an inference
      // provider named "Legion" or "legionio". Only activate when no explicit
      // runtime has been chosen, to respect user overrides.
      const hasExplicitRuntime = context.runtimeId && context.runtimeId !== 'auto';
      if (!hasExplicitRuntime && context.modelProviderKey) {
        const providerName = instance.inferenceProvider.name.toLowerCase().replace(/\s+/g, '');
        if (context.modelProviderKey.startsWith(providerName)) {
          return instance.inferenceProvider;
        }
      }
    }
    return null;
  }

  /* ── Plugin CLI Tool Contributions ── */

  getPluginCliTools(): PluginCliToolContribution[] {
    const result: PluginCliToolContribution[] = [];
    for (const instance of this.plugins.values()) {
      if (instance.state !== 'active') continue;
      result.push(...instance.contributedCliTools);
    }
    return result;
  }

  /** True if any active plugin has registered a pre-send hook. Lets callers skip
   *  per-message work (e.g. stale-token-count invalidation) when no hook can
   *  possibly have modified the outgoing messages. */
  hasPreSendHooks(): boolean {
    for (const instance of this.plugins.values()) {
      if (instance.state === 'active' && instance.preSendHooks.length > 0) return true;
    }
    return false;
  }

  async runPreSendHooks(args: Omit<PreSendHookArgs, 'config'> & { config: AppConfig }): Promise<PreSendHookResult> {
    let result: PreSendHookResult = {
      messages: args.messages,
      systemPrompt: args.systemPrompt,
    };

    // Build a redacted view of the config so credential-bearing fields
    // (provider API keys, AWS secrets, MCP env, web server password, TLS
    // key path, etc.) never reach plugin hook code. Compute once per call
    // and reuse across all active hooks.
    const safeConfig = toPluginSafeConfig(args.config);

    for (const instance of this.plugins.values()) {
      if (instance.state !== 'active') continue;
      for (const hook of instance.preSendHooks) {
        try {
          const hookResult = await hook({
            messages: result.messages,
            modelKey: args.modelKey,
            config: safeConfig,
            systemPrompt: result.systemPrompt,
          });
          result = {
            messages: hookResult.messages ?? result.messages,
            systemPrompt: hookResult.systemPrompt ?? result.systemPrompt,
            abort: hookResult.abort,
            abortReason: hookResult.abortReason,
          };
          if (result.abort) return result;
        } catch (err) {
          console.error(`[PluginManager] Pre-send hook error in "${instance.manifest.name}":`, err);
        }
      }
    }

    return result;
  }

  async runPostReceiveHooks(
    args: Omit<PostReceiveHookArgs, 'config'> & { config: AppConfig },
  ): Promise<PostReceiveHookResult> {
    let result: PostReceiveHookResult = { response: args.response };

    const safeConfig = toPluginSafeConfig(args.config);

    for (const instance of this.plugins.values()) {
      if (instance.state !== 'active') continue;
      for (const hook of instance.postReceiveHooks) {
        try {
          result = await hook({
            messages: args.messages,
            response: result.response,
            config: safeConfig,
          });
        } catch (err) {
          console.error(`[PluginManager] Post-receive hook error in "${instance.manifest.name}":`, err);
        }
      }
    }

    return result;
  }

  /* ── Lifecycle Hooks ── */

  /**
   * Run EVERY active plugin's pre-update hooks and collapse the results.
   *
   * Correctness properties (see the R3/R4 reviews):
   *  - A failure in one plugin's hook must NOT skip a later plugin's hooks — a
   *    later plugin may hold a deliberate veto or required setup. So we run all
   *    of them and aggregate, rather than returning at the first non-clean one.
   *  - A deliberate `{ abort: true }` from ANY plugin is a hard block that wins
   *    over any failure — "Proceed anyway" must never bypass a real veto.
   *  - A *thrown* hook, or a returned `{ failed: true }` abort, is an overridable
   *    failure. Correctness does not depend on a plugin setting `failed`: a throw
   *    is classified as a failure regardless.
   *  - A HANG is bounded PER HOOK (R4): a single hook that never settles is
   *    recorded as an (overridable) failure and the loop moves on, so a hung hook
   *    can't discard another hook's veto. An aggregate timeout in the caller
   *    would have thrown away an already-recorded block and wrongly offered
   *    "Proceed anyway".
   */
  async runPreUpdateHooks(args: Omit<PreUpdateHookArgs, 'signal'>): Promise<PreUpdateHooksOutcome> {
    let block: { reason: string } | null = null; // first deliberate {abort:true}
    let failure: { reason: string } | null = null; // first overridable failure

    // Snapshot the PLAN up front: the active plugins and a COPY of each one's
    // pre-update hook array. Iterating the live `instance.preUpdateHooks` while
    // awaiting is unsafe — a hook that calls `registerPreUpdateHook` appends to
    // that same array, so a self-registering hook would grow the loop forever and
    // (with no outer timer) latch `installInProgress` permanently (R8P2). A
    // snapshot bounds the loop to the hooks present when the attempt began.
    const plan = [...this.plugins.values()]
      .filter((instance) => instance.state === 'active')
      .map((instance) => ({
        instance,
        preHooks: [...instance.preUpdateHooks],
        // BASELINE post-hooks captured NOW, before any pre-hook awaits. A
        // concurrent unload can clear `instance.postUpdateHooks` in the gap
        // between a pre-hook resolving and our after-the-fact snapshot; without a
        // baseline the participant capture would see [] → rollback falsely
        // "succeeds" → no cleanup-debt marker → privileged setup left active
        // (R30P2). We union this baseline with whatever exists after the pre-hooks
        // (to also include hooks registered DURING setup, R8P2).
        baselinePostHooks: [...instance.postUpdateHooks],
      }));

    // Per participating plugin: a SNAPSHOT of its post-update hooks (copied) plus
    // its name — NOT the mutable PluginInstance. Rolling back by name would
    // re-enumerate `this.plugins`, and holding the instance is no better: the
    // unload/disable/crash paths MUTATE the same instance (`postUpdateHooks = []`)
    // during the up-to-5m window, so a captured reference would yield empty hooks
    // (R7P2/R8P1). We snapshot AFTER a plugin's pre-hooks run so post-hooks it
    // registers during setup are included in its rollback (R8P2). Deduped by
    // instance identity.
    const participants: Array<{ name: string; postHooks: PostUpdateHook[]; instance: PluginInstance }> = [];
    const seen = new Set<PluginInstance>();
    // Identity of the active plugin generation the plan was built from. If this
    // set changes during the (up to 5m) hook window — a plugin enabled/disabled,
    // or replaced by a marketplace update — the plan is stale: a NEW generation's
    // veto/elevation hook was never evaluated. `stillCurrent` skips replaced
    // entries but can't run a replacement that isn't in the plan, so we fail
    // closed rather than install past an un-run hook (R11P1).
    const planInstances = new Set(plan.map((p) => p.instance));
    // Snapshot each plan instance's pre-update-hook COUNT. A plugin can call
    // registerPreUpdateHook DURING our await window (a hook registered by another
    // of its hooks, or by async plugin code), appending to the LIVE
    // `instance.preUpdateHooks` array — which our per-plugin `preHooks` SNAPSHOT
    // does NOT include. That late hook could hold a deliberate veto we'd never
    // evaluate. `stillFresh` compares these counts and fails closed if any grew, so
    // the point-of-no-return check refuses to install past an un-run pre-hook
    // (R28P24). The user retries; the next attempt's plan includes the new hook.
    const planPreHookCounts = new Map(plan.map((p) => [p.instance, p.instance.preUpdateHooks.length] as const));

    // A plan entry is safe to invoke only while its captured instance is STILL
    // the current, active, non-tearing-down registration for its name. Checked
    // before EVERY hook (not once per plugin): a plugin can unload/reload while
    // its own first hook awaits, and its later snapshotted hooks must then be
    // skipped rather than run against a stale/torn-down generation (R10P2).
    const stillCurrent = (instance: PluginInstance): boolean =>
      this.plugins.get(instance.manifest.name) === instance && instance.state === 'active' && !instance.tearingDown;

    // Controllers for hooks that COMPLETED cleanly (their signal wasn't already
    // aborted on timeout/throw). The API promises `signal` fires when the update
    // is otherwise cancelled, so on any non-proceed outcome we abort these too —
    // an earlier successful hook may have started signal-observing work that must
    // stop when a later hook blocks or the user cancels (R12P1).
    const liveControllers: AbortController[] = [];
    // Names of plugins whose pre-update hook TIMED OUT: the hook is still running
    // (abort is advisory — a trusted hook may ignore it) and could perform
    // privileged setup AFTER the timeout. rollback() reports these as `failed` so
    // the caller keeps their cleanup owed even on a "clean" cancel, rather than
    // clearing debt for setup that may still be applied (R6P1).
    const timedOutPlugins = new Set<string>();
    // Plugins whose pre-update hook FAILED (threw or returned `failed:true`) after
    // possibly performing partial privileged setup. Even if such a plugin never
    // registered a post-update hook, its cleanup debt MUST be retained: it may have
    // elevated/staged something before failing (R28P18). Rollback forces these into
    // its `failed` set so the ledger keeps owing them (a hookless success would
    // otherwise erase the debt). Timed-out plugins are tracked separately above.
    const failedParticipants = new Set<string>();
    // Set when a plugin's remaining hooks were SKIPPED after one of its hooks
    // failed. We can't know whether a skipped hook held a deliberate veto, so we
    // must fail closed rather than let the failure be overridable (R12P1 —
    // resolves the R11 break-vs-veto tension conservatively).
    let skippedAfterFailure = false;

    scan: for (const { instance, preHooks, baselinePostHooks } of plan) {
      if (!stillCurrent(instance)) continue;
      let participated = false;
      // Cumulatively capture post-hooks this plugin has registered, snapshotting
      // the live array RIGHT AFTER each pre-hook resolves. Reading only the final
      // live array (as the end-of-plugin snapshot does) can LOSE a post-hook that
      // an early pre-hook registered if a later pre-hook's await lets a concurrent
      // unload clear `instance.postUpdateHooks` before we snapshot (R35P1). By
      // merging synchronously after each hook — with no await between the hook
      // returning and this capture — a registration is recorded before any unload
      // can run. Seeded with the plan-time baseline (R30P2).
      const capturedPostHooks: PostUpdateHook[] = [...baselinePostHooks];
      const mergePostHooks = (from: readonly PostUpdateHook[]) => {
        for (const h of from) if (!capturedPostHooks.includes(h)) capturedPostHooks.push(h);
      };
      for (let hookIndex = 0; hookIndex < preHooks.length; hookIndex++) {
        const hook = preHooks[hookIndex];
        if (!stillCurrent(instance)) break; // reloaded/torn down mid-plugin → stop invoking its stale hooks
        participated = true;
        // Hold the LIVE post-hook array object BEFORE invoking the hook. Plugins
        // register via `instance.postUpdateHooks.push(hook)` (mutates this object),
        // while unload/disable/crash REASSIGNS `instance.postUpdateHooks = []` (a
        // new object). Reading from this held reference after the hook resolves
        // therefore still sees a cleanup the hook registered even if a concurrent
        // unload swapped the instance's array out mid-hook (R35P1) — the very race
        // that reading `instance.postUpdateHooks` post-await would lose.
        const liveArrayBeforeHook = instance.postUpdateHooks;
        // Per-hook AbortController: aborted on timeout so a well-behaved hook can
        // stop privileged/long-running work instead of being silently abandoned.
        // Propagates to utility-process plugins via the wire transport's native
        // AbortSignal marshalling.
        const controller = new AbortController();
        const hookArgs: PreUpdateHookArgs = { ...args, signal: controller.signal };
        const outcome = await PluginManager.runHookWithTimeout(() => hook(hookArgs));
        const hadMoreHooks = hookIndex < preHooks.length - 1;
        // Capture any post-hook this hook registered BEFORE branching on the
        // outcome: a supported hook can register its cleanup then throw or hang
        // (timeout). Doing this only on the clean-pass branch would lose that
        // cleanup from the rollback snapshot, so rollback would falsely "succeed"
        // and leave privileged setup active (R35P1). Merge from BOTH the array we
        // held before the hook (survives a concurrent-unload reassignment) and the
        // instance's current array (in case it wasn't reassigned) — a hook's
        // registration is captured whether or not an unload swapped the array.
        mergePostHooks(liveArrayBeforeHook);
        mergePostHooks(instance.postUpdateHooks);

        if (outcome.kind === 'timeout') {
          const minutes = Math.round(PluginManager.PRE_UPDATE_HOOK_TIMEOUT_MS / 60000);
          console.error(
            `[PluginManager] Pre-update hook in "${instance.manifest.name}" timed out after ${minutes}m — aborting it and treating as failure.`,
          );
          // Signal the hook to stop, then move on. A hook that ignores the signal
          // is a plugin bug (plugins are trusted), but aborting bounds the damage
          // and prevents overlapping work on retry.
          controller.abort(new DOMException('Pre-update hook timed out', 'TimeoutError'));
          // A hook may register its cleanup from an abort listener (fires
          // synchronously on .abort()) rather than before returning. Re-merge
          // AFTER the abort so that late registration is still captured for
          // rollback (R35P1) — otherwise a timed-out hook's cleanup is lost.
          mergePostHooks(liveArrayBeforeHook);
          mergePostHooks(instance.postUpdateHooks);
          // The hook is still running (abort is advisory) — it may still perform
          // privileged setup. Mark it so rollback reports it as `failed` and its
          // cleanup debt is retained even on a clean cancel (R6P1).
          timedOutPlugins.add(instance.manifest.name);
          failure ??= {
            reason: `Hook "${instance.manifest.name}" timed out after ${minutes} minute${minutes === 1 ? '' : 's'}.`,
          };
          if (hadMoreHooks) skippedAfterFailure = true; // a skipped later hook could hold a veto
          break; // stop THIS plugin's remaining hooks (they may depend on the failed one); other plugins still run
        }
        if (outcome.kind === 'threw') {
          // safeErrorText never throws (a plugin can throw an object whose
          // toString throws) — a bare `${err}` here could escape.
          console.error(`[PluginManager] Pre-update hook error in "${instance.manifest.name}":`, outcome.error);
          // Abort the signal (symmetric with the timeout branch): a hook can
          // reject while leaving async work in flight, and for utility plugins the
          // abort must fire before the remote controller is released on settle.
          controller.abort(new DOMException('Pre-update hook failed', 'AbortError'));
          // Re-merge after abort for the same reason as the timeout branch: an
          // abort-listener cleanup registration must still be captured (R35P1).
          mergePostHooks(liveArrayBeforeHook);
          mergePostHooks(instance.postUpdateHooks);
          failure ??= { reason: `Hook "${instance.manifest.name}" failed: ${safeErrorText(outcome.error)}` };
          failedParticipants.add(instance.manifest.name); // retain debt even if hookless (R28P18)
          if (hadMoreHooks) skippedAfterFailure = true; // a skipped later hook could hold a veto
          break; // stop THIS plugin's remaining hooks; other plugins still run for veto aggregation
        }

        // Hook completed: keep its controller so we can abort it if the overall
        // attempt is later cancelled/blocked.
        liveControllers.push(controller);

        const result = outcome.value;
        if (!result?.abort && !result?.failed) continue; // clean pass
        const reason = result.abortReason ?? `Plugin "${instance.manifest.name}" blocked the update`;
        if (result.failed) {
          // Operational failure the plugin opted into as overridable. NOTE: a
          // plugin that catches its own operational error and returns a bare
          // `{ abort: true }` (no `failed`) is classified as a deliberate block
          // below — it MUST set `failed: true` to be overridable. (See the
          // PreUpdateHookResult docs; the Privileges elevation hook needs this.)
          //
          // Treat this exactly like a thrown/timed-out failure (R12P2): stop this
          // plugin's remaining hooks, and if any were skipped, a later one could
          // hold a veto → fail closed. Otherwise a returned `{ failed: true }`
          // would let later same-plugin hooks run and stay overridable.
          failure ??= { reason };
          failedParticipants.add(instance.manifest.name); // retain debt even if hookless (R28P18)
          if (hadMoreHooks) skippedAfterFailure = true;
          break;
        } else {
          // Deliberate policy block — highest precedence and terminal: nothing a
          // later hook returns can change the outcome, and running more hooks
          // would only run needless side-effecting setup (that we'd then have to
          // roll back) and could add another per-hook timeout of delay. Stop now.
          block = { reason };
          // Capture this plugin's post-hooks before stopping — its (partial)
          // setup still needs rollback.
          if (participated && !seen.has(instance)) {
            seen.add(instance);
            participants.push({ name: instance.manifest.name, postHooks: [...capturedPostHooks], instance });
          }
          break scan;
        }
      }
      // Record this plugin's participation using the CUMULATIVE post-hook capture
      // (baseline ∪ everything registered synchronously after each pre-hook), so a
      // hook registered early then hidden by a later-await unload is still rolled
      // back (R35P1). A final merge picks up anything the last completed hook added.
      if (participated && !seen.has(instance)) {
        seen.add(instance);
        mergePostHooks(instance.postUpdateHooks);
        participants.push({ name: instance.manifest.name, postHooks: [...capturedPostHooks], instance });
      }
    }

    // Build the rollback thunk over the SNAPSHOT of participating plugins'
    // post-update hooks, so neither a re-enumeration nor a concurrent reload (which
    // would clear the live instance's hooks) can misdirect or empty it. It also
    // aborts the signals of hooks that are STILL RUNNING (or in-process) — the
    // non-proceed paths run rollback (R12P1). A returned out-of-process hook's
    // signal is already released by the transport, so its abort is a no-op there
    // (that returned-hook case is the documented best-effort limit).
    const captured = participants.slice();
    // Abort still-live hook signals, on the CANCEL/BLOCK paths only. This lets a
    // running (or in-process) hook observe `abort` and revoke its setup. On the
    // COMMIT path we do NOT touch these signals: `quitAndInstall` terminates every
    // plugin process (freeing child controllers via exit), and aborting on a
    // successful install would wrongly trigger a hook's revoke-on-cancel (R15P1).
    const abortLiveHooks = () => {
      for (const c of liveControllers) {
        if (!c.signal.aborted) c.abort(new DOMException('Update attempt cancelled', 'AbortError'));
      }
    };
    const rollback = async (opts?: {
      onPluginDone?: (name: string) => void | Promise<void>;
    }): Promise<{ failed: string[] }> => {
      abortLiveHooks();
      const failed: string[] = [];
      for (const p of captured) {
        // Attempt EVERY participant's cleanup even if an earlier one failed, and
        // report which plugins' cleanup did NOT complete. The caller marks the
        // SUCCEEDED participants done in the ledger and re-owes only the failed
        // ones — so a successfully-cleaned plugin's (possibly non-idempotent)
        // hook is never rerun on the next launch (R35P1, per-plugin guarantee).
        // Previously this threw all-or-nothing, which re-owed even the plugins
        // that cleaned up fine (R29P2 kept the coarse marker; the ledger refines
        // it to per-plugin). `onPluginDone` fires after EACH success so the caller
        // can persist completion incrementally — a crash mid-batch then can't
        // re-run an already-cleaned plugin.
        // A TIMED-OUT plugin: we STILL attempt its captured cleanup here (it may
        // have registered a post-hook / applied setup before timing out, so the
        // cleanup must at least run — skipping it entirely would leave elevation
        // active, R28P7). But its pre-update hook may STILL be running and apply
        // further privileged setup after this rollback, so we RETAIN it as failed
        // regardless of the cleanup's outcome, and NEVER call onPluginDone for it —
        // checkpointing it done would let the committed-install teardown clear its
        // ledger debt before we re-add it to `failed` (R6P2). So: run the cleanup,
        // ignore its result for the done/failed decision when timed out.
        // A TIMED-OUT plugin OR one whose pre-hook FAILED (threw / returned
        // failed:true) is RETAINED as failed regardless of the cleanup's outcome
        // (R28P7/R28P18): its pre-hook may have applied partial privileged setup —
        // possibly WITHOUT registering a post-hook — so its debt must survive even a
        // trivially-"successful" empty cleanup. We still ATTEMPT the cleanup, and
        // NEVER call onPluginDone for it (checkpointing done would let a teardown
        // clear its debt before we re-add it to `failed`, R6P2).
        // Re-merge the participant's CURRENT live post-hooks with its snapshot
        // (R28P30): a plugin can register a post-update hook AFTER its own pre-hook
        // returned — e.g. asynchronously while a LATER plugin's pre-hook/dialog is
        // still awaiting — which the participant snapshot taken at that time missed.
        // Only merge when the live instance is STILL the SAME, ACTIVE generation we
        // captured. Identity alone is NOT enough (R28P33): a crash/teardown can keep
        // the same instance object but flip it to state 'error'/tearingDown and CLEAR
        // its postUpdateHooks — so re-reading would see an empty list, run "nothing"
        // successfully, and clear the debt for cleanup that never ran. If the
        // instance is no longer active/non-tearing-down, we CANNOT trust its live
        // hooks: fall back to the SNAPSHOT and RETAIN the participant as failed so
        // its debt survives (a late registration we didn't snapshot may be lost, but
        // retaining is safe — the next launch reconciles).
        const live = this.plugins.get(p.name);
        const sameLiveGeneration = live === p.instance && live.state === 'active' && !live.tearingDown;
        const effectivePostHooks = [...p.postHooks];
        if (sameLiveGeneration) {
          for (const h of p.instance.postUpdateHooks) {
            if (!effectivePostHooks.includes(h)) effectivePostHooks.push(h);
          }
        }
        // A participant whose captured instance is no longer the live active
        // generation is retained as failed: we can't be sure we ran its complete,
        // possibly-late-registered cleanup (R28P33).
        const staleGeneration = live !== p.instance || live.state !== 'active' || live.tearingDown;
        const retainAnyway = timedOutPlugins.has(p.name) || failedParticipants.has(p.name) || staleGeneration;
        const cleanupOk = await this.runPostHooks(p.name, effectivePostHooks, {
          version: args.version,
          success: false,
        });
        const ok = !retainAnyway && cleanupOk;
        if (ok) {
          if (opts?.onPluginDone) {
            try {
              await opts.onPluginDone(p.name);
            } catch (e) {
              console.error(`[PluginManager] rollback onPluginDone("${p.name}") threw:`, e);
            }
          }
        } else {
          failed.push(p.name);
        }
      }
      // Also report any timed-out OR failed plugin that never became a participant
      // (deduped against the loop above), so it is owed even if it isn't in
      // `captured` (a pre-hook that failed before registering anything, R28P18).
      for (const name of timedOutPlugins) if (!failed.includes(name)) failed.push(name);
      for (const name of failedParticipants) if (!failed.includes(name)) failed.push(name);
      return { failed };
    };
    // Names of plugins whose pre-update hooks participated. The committed-failure
    // teardown notifies participants via `rollback()` (snapshot-based) and then
    // notifies the REMAINING active plugins (post-only) by excluding these — so no
    // plugin's post-update hook is invoked twice (R33P1).
    const participantNames = captured.map((p) => p.name);
    // Subset of participants that actually CAPTURED at least one post-update hook.
    // The updater records these (∪ post-only) as `owed` — a participant with NO
    // post hook has no cleanup and must NOT be owed, or reconciliation (which
    // refuses to clear a hookless plugin) would keep the attempt forever (R35P1).
    // Sourced from the capture (not the live array) so a hook registered during a
    // pre-hook then hidden by a concurrent unload is still counted.
    const postHookParticipantNames = captured.filter((p) => p.postHooks.length > 0).map((p) => p.name);

    // True while the active plugin generation still matches the plan. The caller
    // rechecks this right before installing, because the override dialog can be
    // open long enough for a plugin to activate after our own check (R12P1).
    // A plugin in the `loading` state counts as a generation change too (R17P1):
    // it's mid-activation and about to register a pre-update hook we never
    // evaluated, so proceeding would skip its potential veto/setup. Any loading
    // plugin (whether or not it was in the plan) makes the outcome non-fresh.
    const activeSetMatchesPlan = (): boolean => {
      const anyLoading = [...this.plugins.values()].some((i) => i.state === 'loading' && !i.tearingDown);
      if (anyLoading) return false;
      const active = [...this.plugins.values()].filter((i) => i.state === 'active' && !i.tearingDown);
      if (active.length !== planInstances.size || !active.every((i) => planInstances.has(i))) return false;
      // Also fail closed if any plan instance registered a NEW pre-update hook
      // during the update window (its live count exceeds the snapshot) — that hook
      // was never evaluated and could veto (R28P24).
      for (const [inst, count] of planPreHookCounts) {
        if (inst.preUpdateHooks.length !== count) return false;
      }
      return true;
    };
    const stillFresh = activeSetMatchesPlan;
    // Fields common to every outcome — avoids drift across the return sites.
    const common = {
      rollback,
      stillFresh,
      participantNames,
      postHookParticipantNames,
      timedOutParticipantNames: [...timedOutPlugins],
      // Plugins whose pre-hook FAILED (threw/failed:true): owed at commit even if
      // hookless, because they may have applied partial setup (R28P18).
      failedParticipantNames: [...failedParticipants],
    };

    // Precedence: a deliberate block wins (already terminal above). Next, fail
    // closed if the active plugin generation changed since we snapshotted the
    // plan — a newly-active instance may hold an un-evaluated veto/setup hook, so
    // installing could skip it. This MUST outrank `overridable`: otherwise a hook
    // failure plus a plugin swap would let the user "Proceed anyway" past the
    // un-evaluated generation (R11P2). Not overridable; the user simply retries
    // and the next attempt builds a fresh plan.
    if (block) return { decision: 'blocked', reason: block.reason, ...common };

    if (!activeSetMatchesPlan()) {
      console.warn('[PluginManager] Active plugin set changed during pre-update hooks — failing closed.');
      return {
        decision: 'blocked',
        reason: 'The set of installed plugins changed during the update check. Please try installing again.',
        ...common,
      };
    }

    // A plugin's later hooks were skipped after one of its hooks failed. A skipped
    // hook could have held a deliberate veto, so the failure must NOT be
    // overridable — fail closed (R12P1). (When nothing was skipped, a failure is
    // the plugin's own overridable operational error.)
    if (skippedAfterFailure && failure) {
      return {
        decision: 'blocked',
        reason: `${failure.reason} Some update checks could not complete, so the update was paused for safety.`,
        ...common,
      };
    }

    if (failure) return { decision: 'overridable', reason: failure.reason, ...common };
    return { decision: 'proceed', ...common };
  }

  /**
   * Names of every currently-active plugin that has at least one post-update
   * hook — i.e. everyone owed a post-update notification after an install. The
   * updater records this set (unioned with pre-update participants) as an
   * attempt's `owed` at commit time, so BOTH participants AND post-only plugins
   * (those that registered only `registerPostUpdateHook`) are reconciled after a
   * successful update (R35P1 — otherwise post-only plugins would silently never
   * be notified, regressing the prior all-active behaviour).
   */
  getPostUpdatePluginNames(): string[] {
    return [...this.plugins.values()]
      .filter((instance) => instance.state === 'active' && instance.postUpdateHooks.length > 0)
      .map((instance) => instance.manifest.name);
  }

  /**
   * Names of active plugins that have a pre-update hook — i.e. every plugin that
   * COULD perform privileged setup during the update. The updater records these
   * as a PROVISIONAL owed set BEFORE running any pre-update hook, so a crash
   * between "hook granted admin" and the commit still leaves a ledger entry to run
   * the revoke next launch (R5P2/R6P1). Deliberately keyed on the PRE-update hook,
   * not on already having a post-update hook: a hook commonly registers its
   * cleanup DURING its pre-update run, so requiring a post-hook at snapshot time
   * would miss exactly the plugin that just elevated. Refined to the true owed set
   * at commit; reconciled to the failed set on cancel.
   */
  getSetupCapablePluginNames(): string[] {
    return [...this.plugins.values()]
      .filter((instance) => instance.state === 'active' && instance.preUpdateHooks.length > 0)
      .map((instance) => instance.manifest.name);
  }

  /**
   * Run post-update hooks for all currently-active plugins. Used AFTER a real
   * relaunch (success may be true or false) where re-enumeration is correct — by
   * then the surviving plugin set is exactly who should see the result. For
   * rollback of an in-flight cancelled attempt use the pre-hook result's
   * `rollback` thunk instead (it targets the exact participating generation via a
   * hook snapshot taken before any reload could clear them).
   */
  async runPostUpdateHooks(
    args: Omit<PostUpdateHookArgs, 'signal'>,
    opts?: {
      excludeNames?: readonly string[];
      onlyNames?: readonly string[];
      /** Invoked after EACH plugin whose hook succeeds, before the next runs, so a
       *  caller can persist per-plugin completion incrementally — if the process
       *  crashes mid-batch, the plugins already done aren't re-run next launch
       *  (R35P1). Awaited; a throw is swallowed (logged) so one plugin's bookkeeping
       *  failure can't abort the rest of the batch. */
      onPluginDone?: (name: string) => void | Promise<void>;
    },
  ): Promise<{ allSucceeded: boolean; succeededNames: string[]; attemptedNames: string[] }> {
    // Snapshot the plan up front (active plugins + a COPY of each post-hook
    // array), same rationale as runPreUpdateHooks: iterating the live map/arrays
    // across awaits lets a self-registering post-hook grow the loop indefinitely
    // and a mid-run reload introduce a new generation (R9P2). Returns whether ALL
    // hooks succeeded, the exact set of plugins whose cleanup COMPLETED, and the
    // set that was ATTEMPTED — so a caller (the failed-install teardown / startup
    // reconciler) can clear per-plugin owed state AND record newly-discovered
    // owed plugins (post-only ones whose notify failed) in the ledger, retrying
    // only the ones that did NOT finish (R35P1). `excludeNames` skips plugins
    // already notified elsewhere (the committed-failure teardown notifies
    // participants via the rollback thunk, then calls this with participants
    // excluded so no plugin is notified twice — R33P1). `onlyNames` restricts the
    // run to a specific set — the startup reconciler passes exactly the plugins a
    // ledger attempt still owes, so no unrelated active plugin is notified for an
    // attempt it never participated in (R35P1). `onPluginDone` fires per-plugin so
    // the reconciler can persist completion incrementally (crash-safety).
    const exclude = opts?.excludeNames ? new Set(opts.excludeNames) : null;
    const only = opts?.onlyNames ? new Set(opts.onlyNames) : null;
    const plan = [...this.plugins.values()]
      .filter(
        (instance) =>
          instance.state === 'active' &&
          // A plugin with NO post-update hook has no cleanup to run; it must NOT be
          // counted as "done" for an owed attempt (doing so would clear the debt
          // without any cleanup actually running, permanently stranding privileged
          // pre-update setup if the plugin simply hasn't re-registered its hook yet
          // this launch). Excluding it here keeps it owed for a future launch when
          // its hook is present (R35P1).
          instance.postUpdateHooks.length > 0 &&
          !(exclude && exclude.has(instance.manifest.name)) &&
          !(only && !only.has(instance.manifest.name)),
      )
      .map((instance) => ({ name: instance.manifest.name, postHooks: [...instance.postUpdateHooks] }));
    let allSucceeded = true;
    const succeededNames: string[] = [];
    const attemptedNames = plan.map((p) => p.name);
    for (const { name, postHooks } of plan) {
      if (await this.runPostHooks(name, postHooks, args)) {
        succeededNames.push(name);
        if (opts?.onPluginDone) {
          try {
            await opts.onPluginDone(name);
          } catch (e) {
            console.error(`[PluginManager] onPluginDone("${name}") threw:`, e);
          }
        }
      } else {
        allSucceeded = false;
      }
    }
    // Any plugin the caller explicitly OWED (`onlyNames`) that we could NOT attempt
    // — missing, inactive, or hookless this launch — must count as NOT succeeded
    // (R28P8). It stays owed on the ledger; if `allSucceeded` stayed true the
    // startup reconciler would neither clear it (no cleanup ran) NOR bump the retry
    // cap, leaving the attempt owed forever and BLOCKING all future app-update
    // installs indefinitely. Reporting incomplete lets the caller spend a retry so
    // the give-up cap is eventually reached.
    if (only) {
      const attemptedSet = new Set(attemptedNames);
      for (const owedName of only) {
        if (!attemptedSet.has(owedName)) {
          allSucceeded = false;
          break;
        }
      }
    }
    return { allSucceeded, succeededNames, attemptedNames };
  }

  /**
   * Invoke a set of post-update hooks, each time-bounded + abortable. Attempts
   * ALL hooks (a failing one doesn't skip the rest), then reports whether they
   * all succeeded. Callers that gate recovery state on cleanup completion (the
   * updater keeps its recovery marker unless cleanup fully succeeded, R29P2) need
   * this signal — swallowing failures silently would make failed privilege
   * cleanup look done and never be retried. A "process gone" skip counts as NOT
   * succeeded (cleanup genuinely didn't run).
   */
  private async runPostHooks(
    pluginName: string,
    hooks: readonly PostUpdateHook[],
    args: Omit<PostUpdateHookArgs, 'signal'>,
  ): Promise<boolean> {
    let allSucceeded = true;
    for (const hook of hooks) {
      // Bound each post-update (rollback / cleanup) hook the same way as
      // pre-update hooks, and give it an AbortSignal so a timed-out cleanup can
      // stop rather than overlap a later retry's setup. A timed-out or throwing
      // hook is logged and does NOT abort the remaining hooks, but is reported.
      const controller = new AbortController();
      const hookArgs: PostUpdateHookArgs = { ...args, signal: controller.signal };
      const outcome = await PluginManager.runHookWithTimeout(() => hook(hookArgs));
      if (outcome.kind === 'timeout') {
        controller.abort(new DOMException('Post-update hook timed out', 'TimeoutError'));
        console.error(
          `[PluginManager] Post-update hook in "${pluginName}" timed out — aborting it and skipping (best-effort).`,
        );
        allSucceeded = false;
      } else if (outcome.kind === 'threw') {
        // A dead/torn-down utility process rejects callback invocations (e.g.
        // "Plugin process is not running/paused"). If the plugin was unloaded
        // between its pre-update setup and this rollback, its cleanup code no
        // longer exists to run — an inherent limit of in-process rollback. Emit a
        // clear, distinct warning rather than an opaque error so this case is
        // diagnosable; the plugin's own next-launch post-update reconciliation is
        // the backstop.
        const msg = safeErrorText(outcome.error);
        if (/plugin process is (?:not running|paused|disposed)/i.test(msg)) {
          console.warn(
            `[PluginManager] Post-update hook for "${pluginName}" skipped — its plugin process is gone (unloaded/reloaded mid-update); cleanup could not run in-process.`,
          );
        } else {
          console.error(`[PluginManager] Post-update hook error in "${pluginName}":`, outcome.error);
        }
        allSucceeded = false;
      }
    }
    return allSucceeded;
  }

  /**
   * Race a single hook invocation against the per-hook timeout. Never throws:
   * returns a discriminated outcome so callers apply their own policy. On
   * timeout the passed AbortController (if any) is the caller's to abort — this
   * helper only bounds the wait, it does not own cancellation.
   */
  private static async runHookWithTimeout<T>(
    invoke: () => T | Promise<T>,
  ): Promise<{ kind: 'value'; value: T } | { kind: 'timeout' } | { kind: 'threw'; error: unknown }> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const TIMED_OUT = Symbol('hook-timeout');
    try {
      const raced = await Promise.race([
        Promise.resolve(invoke()),
        new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), PluginManager.PRE_UPDATE_HOOK_TIMEOUT_MS);
        }),
      ]);
      return raced === TIMED_OUT ? { kind: 'timeout' } : { kind: 'value', value: raced as T };
    } catch (error) {
      return { kind: 'threw', error };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /* ── UI State ── */

  getUIState(): PluginUIState {
    const banners: PluginBannerDescriptor[] = [];
    const modals: PluginModalDescriptor[] = [];
    const settingsSections: PluginSettingsSectionDescriptor[] = [];
    const panels: PluginPanelDescriptor[] = [];
    const navigationItems: PluginNavigationItemDescriptor[] = [];
    const commands: PluginCommandDescriptor[] = [];
    const conversationDecorations: PluginConversationDecorationDescriptor[] = [];
    const threadDecorations: PluginThreadDecorationDescriptor[] = [];
    const rendererScripts: PluginRendererScript[] = [];
    const rendererStyles: PluginRendererStyle[] = [];
    const pluginConfigs: Record<string, Record<string, unknown>> = {};
    const pluginStates: Record<string, Record<string, unknown>> = {};
    const pluginStatuses: Record<string, PluginInstance['state']> = {};
    const pluginErrors: Record<string, string | undefined> = {};
    const notifications: PluginNotificationDescriptor[] = [];
    let requiredPluginsReady = true;

    for (const instance of this.plugins.values()) {
      pluginConfigs[instance.manifest.name] = this.getPluginConfig(instance.manifest.name);
      pluginStates[instance.manifest.name] = { ...instance.publishedState };
      pluginStatuses[instance.manifest.name] = instance.state;
      pluginErrors[instance.manifest.name] = instance.error;
      const isActive = instance.state === 'active';
      const shouldExposeUi =
        !this.rendererRevocations.has(instance.manifest.name) &&
        (instance.state === 'loading' || instance.state === 'active');

      if (!isActive && this.brandRequiredPluginNamesSet.has(instance.manifest.name)) {
        requiredPluginsReady = false;
      }

      if (!shouldExposeUi) {
        continue;
      }

      banners.push(...instance.uiBanners);
      modals.push(...instance.uiModals);
      settingsSections.push(...instance.uiSettingsSections);
      panels.push(...instance.uiPanels);
      navigationItems.push(...instance.uiNavigationItems);
      commands.push(...instance.uiCommands);
      conversationDecorations.push(...instance.conversationDecorations);
      threadDecorations.push(...instance.threadDecorations);
      notifications.push(...instance.notifications.filter((notification) => notification.visible));

      if (instance.rendererBuild) {
        rendererScripts.push(...instance.rendererBuild.scripts);
        rendererStyles.push(...instance.rendererBuild.styles);
      }

      if (this.brandRequiredPluginNamesSet.has(instance.manifest.name)) {
        const hasBlockingModal = instance.uiModals.some((modal) => modal.visible && !modal.closeable);
        if (hasBlockingModal) {
          requiredPluginsReady = false;
        }
      }
    }

    settingsSections.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    panels.sort((a, b) => a.title.localeCompare(b.title));
    navigationItems.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    commands.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

    for (const requiredName of this.brandRequiredPluginNames) {
      if (!this.plugins.has(requiredName)) {
        requiredPluginsReady = false;
        break;
      }
    }

    return {
      banners,
      modals,
      settingsSections,
      panels,
      navigationItems,
      commands,
      conversationDecorations,
      threadDecorations,
      rendererScripts,
      rendererStyles,
      pluginConfigs,
      pluginStates,
      pluginStatuses,
      pluginErrors,
      notifications,
      requiredPluginsReady,
      brandRequiredPluginNames: [...this.brandRequiredPluginNames],
      contributedCliTools: this.getPluginCliTools().map((tool) => {
        // Find which plugin contributed this tool
        for (const instance of this.plugins.values()) {
          if (instance.contributedCliTools.some((t) => t.name === tool.name)) {
            return { ...tool, pluginName: instance.manifest.name };
          }
        }
        return { ...tool, pluginName: 'unknown' };
      }),
    };
  }

  private broadcastUIState(): void {
    // Coalesce bursts (e.g. several plugins publishing state in the same tick, or
    // a plugin updating state rapidly) into a single emit on the next tick.
    if (this.uiStateBroadcastTimer) return;
    this.uiStateBroadcastTimer = setTimeout(() => {
      this.uiStateBroadcastTimer = null;
      this.flushUIStateBroadcast();
    }, 50);
  }

  /** Build + broadcast the UI-state snapshot once (invoked by the debounce
   *  timer). Serializes once, and skips the emit when the snapshot is unchanged. */
  private flushUIStateBroadcast(): void {
    if (this.uiStateBroadcastTimer) {
      clearTimeout(this.uiStateBroadcastTimer);
      this.uiStateBroadcastTimer = null;
    }
    const state = this.getUIState();
    let json: string;
    try {
      json = JSON.stringify(state);
    } catch {
      // Unserializable snapshot — fall back to broadcasting the object directly
      // (broadcastToAllWindows guards its own serialization) and skip dedup.
      broadcastToAllWindows('plugin:ui-state-changed', state);
      return;
    }
    // Dedup: skip re-broadcasting a byte-identical snapshot. A plugin that
    // re-publishes the same (possibly large) state, or a trigger that didn't
    // actually change anything, would otherwise re-send the whole payload to
    // every window/web/CLI client for nothing.
    if (!uiStateChanged(this.lastBroadcastUIStateJson, json)) return;
    this.lastBroadcastUIStateJson = json;
    broadcastToAllWindows('plugin:ui-state-changed', state);
  }

  /* ── Actions (renderer → main) ── */

  registerActionHandler(pluginName: string, targetId: string, handler: PluginActionHandler): void {
    // Refuse late registrations from a disabled/unloaded plugin's stale async
    // code — otherwise it could repopulate actionHandlers after unloadPlugin()
    // cleared them and keep executing backend logic via the IPC action endpoints.
    if (!this.isPluginLive(pluginName)) return;
    let pluginHandlers = this.actionHandlers.get(pluginName);
    if (!pluginHandlers) {
      pluginHandlers = new Map();
      this.actionHandlers.set(pluginName, pluginHandlers);
    }
    pluginHandlers.set(targetId, handler);
  }

  async handleAction(payload: PluginActionPayload): Promise<unknown> {
    // Don't dispatch actions to a plugin that isn't live (disabled/unloaded). The
    // renderer can't be hot-unloaded, so its UI may still post actions.
    if (!this.isPluginLive(payload.pluginName)) {
      return { error: 'Plugin is not active' };
    }
    const pluginHandlers = this.actionHandlers.get(payload.pluginName);
    let handler = pluginHandlers?.get(payload.targetId);
    // Settings-view dispatch now targets `settings:${id}` (the plugin's own
    // chosen id, matching how panels already worked) instead of the fixed
    // `settings:SettingsView` literal every plugin used to have to hardcode.
    // Older plugins built against the previous convention still register at
    // the literal string, so fall back to it rather than silently breaking
    // them.
    if (!handler && payload.targetId !== 'settings:SettingsView' && payload.targetId.startsWith('settings:')) {
      handler = pluginHandlers?.get('settings:SettingsView');
    }
    if (!handler) {
      console.warn(`[PluginManager] No action handler for ${payload.pluginName}:${payload.targetId}`);
      return { error: 'No handler registered' };
    }
    return handler(payload.action, payload.data);
  }

  sendModalCallback(pluginName: string, modalId: string, data: unknown): void {
    broadcastToAllWindows('plugin:modal-callback', { pluginName, modalId, data });
  }

  /* ── Notifications / Navigation ── */

  private notificationTimerKey(pluginName: string, id: string): string {
    return `${pluginName}:${id}`;
  }

  private clearNotificationTimer(pluginName: string, id: string): void {
    const key = this.notificationTimerKey(pluginName, id);
    const timer = this.notificationTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.notificationTimers.delete(key);
    }
  }

  private broadcastNavigationRequest(pluginName: string, target: PluginNavigationTarget): void {
    // A timer/promise captured inside the plugin before it was disabled/unloaded
    // could still call api.navigation.open() afterward. Drop it unless the plugin
    // is still live ('active', or 'loading' during activate()).
    if (!this.isPluginLive(pluginName)) return;
    broadcastToAllWindows('plugin:navigation-request', { pluginName, target });
  }

  showPluginNotification(
    pluginName: string,
    descriptor: Omit<PluginNotificationDescriptor, 'pluginName' | 'visible'>,
  ): void {
    const instance = this.plugins.get(pluginName);
    // Ignore late calls from a disabled/unloaded plugin's lingering timers — only
    // a live plugin ('active', or 'loading' during activate()) may raise notifications.
    if (!instance || !this.isPluginLive(pluginName)) return;

    const full: PluginNotificationDescriptor = {
      ...descriptor,
      pluginName,
      visible: true,
    };
    const existingIndex = instance.notifications.findIndex((notification) => notification.id === descriptor.id);
    if (existingIndex >= 0) {
      instance.notifications[existingIndex] = full;
    } else {
      instance.notifications.push(full);
    }

    this.clearNotificationTimer(pluginName, descriptor.id);
    if (typeof descriptor.autoDismissMs === 'number' && descriptor.autoDismissMs > 0) {
      const key = this.notificationTimerKey(pluginName, descriptor.id);
      const timer = setTimeout(() => {
        this.dismissPluginNotification(pluginName, descriptor.id);
      }, descriptor.autoDismissMs);
      this.notificationTimers.set(key, timer);
    }

    if (descriptor.native && Notification.isSupported()) {
      const notifKey = `${pluginName}:${descriptor.id}`;
      const nativeNotification = new Notification({
        title: descriptor.title,
        body: descriptor.body ?? '',
      });

      // Store reference to prevent garbage collection before user clicks
      this.nativeNotifications.set(notifKey, nativeNotification);

      const cleanup = () => {
        this.nativeNotifications.delete(notifKey);
      };

      if (descriptor.target) {
        nativeNotification.on('click', () => {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.show();
              win.focus();
              // Send directly to the renderer to trigger DOM custom event
              win.webContents.send('plugin:navigate-direct', { pluginName, target: descriptor.target });
            }
          }
          cleanup();
        });
      }

      nativeNotification.on('close', cleanup);

      nativeNotification.show();
    }

    this.broadcastUIState();
  }

  dismissPluginNotification(pluginName: string, id: string): void {
    const instance = this.plugins.get(pluginName);
    if (!instance) return;

    const existingIndex = instance.notifications.findIndex((notification) => notification.id === id);
    if (existingIndex < 0) return;

    instance.notifications[existingIndex] = {
      ...instance.notifications[existingIndex],
      visible: false,
    };
    this.clearNotificationTimer(pluginName, id);
    this.broadcastUIState();
  }

  /* ── Marketplace ── */

  /** Result of marketplace startup init. `marketplaceBootstrapIncomplete` is true when
   *  a configured catalog was UNREACHABLE (fetch failed, no usable cache) AND a
   *  brand-REQUIRED plugin is consequently not installed/active — so its pre-update
   *  veto would be absent. The caller must then block app installs for the session
   *  (mirrors bundledBootstrapIncomplete), else an update could bypass that required
   *  plugin's hook (R52P1). A reachable catalog, or a required plugin that IS present,
   *  is not incomplete. */
  async initMarketplace(marketplaceUrls: string[]): Promise<{ marketplaceBootstrapIncomplete: boolean }> {
    let marketplaceBootstrapIncomplete = false;
    try {
      if (marketplaceUrls.length === 0) {
        // Nothing to fetch — there is no configured marketplace. init is
        // still "done" so the renderer stops waiting and shows the (correct)
        // unconfigured empty state rather than a perpetual spinner.
        return { marketplaceBootstrapIncomplete: false };
      }

      this.marketplaceService = new MarketplaceService(
        this.pluginsDir,
        this.appHome,
        this.getConfig,
        this.setConfig,
        this.brandRequiredPluginNamesSet,
      );

      let fetchFailed = false;
      try {
        // Full refresh (fetch + required-plugin auto-install) under the
        // single-flight guard so a concurrent renderer/periodic refresh joins
        // this one instead of racing it.
        const catalog = await this.refreshCatalogSingleFlight(marketplaceUrls);
        console.info(`[Marketplace] Fetched ${catalog.length} plugins from ${marketplaceUrls.length} marketplace(s)`);
      } catch (err) {
        console.warn('[Marketplace] Catalog fetch failed, using cache if available:', err);
        fetchFailed = true;
      }

      // If the catalog was UNREACHABLE and a brand-required plugin is therefore not
      // present/active on disk, the required-plugin auto-install couldn't run — its
      // pre-update veto would be missing at an app update. Flag incomplete so the
      // caller blocks installs (R52P1). If the required plugin IS present (installed
      // earlier / from cache), a failed fetch is harmless. Checked against the
      // just-refreshed on-disk set via discovery.
      if (fetchFailed && this.brandRequiredPluginNames.length > 0) {
        const present = new Set(this.discoverPlugins().map((d) => d.manifest.name));
        for (const required of this.brandRequiredPluginNames) {
          if (!present.has(required)) {
            marketplaceBootstrapIncomplete = true;
            console.warn(
              `[Marketplace] Required plugin "${required}" is not installed and the catalog was unreachable — blocking installs so an update can't bypass its pre-update veto.`,
            );
            break;
          }
        }
      }
      return { marketplaceBootstrapIncomplete };
    } catch (err) {
      // An UNEXPECTED throw out of init leaves the required-plugin set unconfirmed →
      // block installs conservatively (R52P1).
      console.error('[Marketplace] initMarketplace threw unexpectedly — blocking installs conservatively:', err);
      return { marketplaceBootstrapIncomplete: true };
    } finally {
      // Always signal renderers that startup init has settled — even on an
      // unexpected throw — so a marketplace view opened mid-init can reload
      // and leave its loading state instead of spinning forever.
      this.marketplaceInitialized = true;
      this.broadcastMarketplaceReady();
    }
  }

  private broadcastMarketplaceReady(): void {
    broadcastToAllWindows('plugin:marketplace-ready', this.getMarketplaceStatus());
  }

  /**
   * Run the FULL catalog refresh (fetch + required-plugin auto-install) under a
   * single-flight guard: if a refresh is already in progress, await it rather
   * than starting a competing one. Covering auto-install (not just fetch) is
   * essential — auto-install eligibility is decided BEFORE the per-plugin
   * install lock is taken, so two overlapping refreshes could each decide the
   * same plugin needs (re)installing and both proceed. One authoritative
   * refresh at a time makes the cached catalog, reachability, and installs
   * consistent across startup, renderer-triggered, and periodic refreshes.
   */
  private refreshCatalogSingleFlight(urls: string[]): Promise<MarketplaceCatalogEntry[]> {
    // Same url set as the in-flight refresh → coalesce onto it.
    const key = JSON.stringify(urls);
    if (this.inFlightCatalogFetch && this.inFlightCatalogFetch.key === key) {
      return this.inFlightCatalogFetch.promise;
    }
    if (!this.marketplaceService) return Promise.resolve([]);

    // Different (or first) url set → CHAIN after whatever is currently queued so
    // only one refresh mutates the MarketplaceService at a time. This prevents a
    // late old-set fetch from committing over a newer set and stops an
    // A→B→A sequence from running A twice concurrently.
    const runAfterChain = this.catalogRefreshChain.then(async () => {
      const service = this.marketplaceService;
      if (!service) return [];
      const catalog = await service.fetchCatalog(urls);
      if (this.brandRequiredPluginNames.length > 0) {
        // Skip auto-updating any required plugin that is DEFERRED because it owes
        // post-update cleanup not yet reconciled — replacing its generation now
        // could strand or misdirect that cleanup (R35P1). It auto-updates on a
        // later refresh once reconciliation clears the deferral. When the owed set
        // is UNKNOWN (legacy marker = "all active", or a corrupt ledger),
        // `deferAllUpdates` holds EVERY required-plugin update until reconcile.
        const eligible = this.deferAllUpdates
          ? new Set<string>()
          : new Set([...this.brandRequiredPluginNamesSet].filter((n) => !this.deferredUpdateNames.has(n)));
        const updated =
          eligible.size > 0
            ? await service.autoInstallRequired(eligible, catalog, {
                serialize: <T>(name: string, fn: () => Promise<T>): Promise<T> =>
                  this.withInstallLock(name, async (): Promise<T> => {
                    // RE-CHECK the deferral INSIDE the lock but BEFORE any renderer
                    // replacement (R9P1): `eligible` was computed before the lock; a
                    // rollback's `deferUpdates` could have deferred this plugin while
                    // we were queued. Skip cleanly if so — the install closure's
                    // result is only pushed to `installed`, which we then omit.
                    if (this.isUpdateDeferred(name)) {
                      console.info(`[PluginManager] Skipping auto-update of "${name}" — deferred mid-refresh (R9P1).`);
                      return undefined as T;
                    }
                    return this.withRendererReplacementForUpdate(name, fn);
                  }),
                afterInstall: async (name, result) => {
                  await this.swapToInstalledPlugin(name, result.version, result);
                },
              })
            : [];
        if (updated.length > 0) this.broadcastUpdateCount();
      }
      return catalog;
    });

    const promise = runAfterChain.finally(() => {
      if (this.inFlightCatalogFetch?.promise === promise) this.inFlightCatalogFetch = null;
    });
    // Advance the chain tail (swallow errors so one failed refresh doesn't wedge
    // the chain for every subsequent caller).
    this.catalogRefreshChain = promise.catch(() => {});
    this.inFlightCatalogFetch = { key, promise };
    return promise;
  }

  /**
   * Report marketplace availability so the renderer can distinguish the states
   * that all previously surfaced as an empty catalog:
   *   - `configured=false`                        → no marketplace URLs for this brand
   *   - `configured=true, ready=false`            → startup catalog fetch still in flight
   *   - `configured=true, ready=true, reachable=false` → fetch failed / all URLs
   *                                                 unreachable (and no cache)
   *   - `configured=true, ready=true, reachable=true`  → endpoint healthy; a
   *                                                 catalogSize of 0 is a VALID
   *                                                 empty catalog, not a failure
   *
   * `reachable` reflects the actual fetch outcome (did any configured URL
   * respond with a valid catalog), NOT catalogSize — a reachable endpoint may
   * legitimately return zero plugins.
   */
  getMarketplaceStatus(): { configured: boolean; ready: boolean; reachable: boolean; catalogSize: number } {
    const configured = this.getMarketplaceUrls().length > 0;
    // null (fetch never settled) counts as not-reachable. When unconfigured,
    // "reachable" is meaningless — report false; the renderer gates on
    // `configured` first.
    const reachable = configured ? this.marketplaceService?.wasLastFetchReachable() === true : false;
    return {
      configured,
      ready: this.marketplaceInitialized,
      reachable,
      catalogSize: this.marketplaceService?.getCachedCatalog()?.length ?? 0,
    };
  }

  /**
   * Atomic catalog + status read. Both are derived from the same in-memory
   * snapshot with NO await in between, so a concurrent fetch commit can't pair
   * an old catalog with new status (or vice-versa) the way two separate IPC
   * round-trips can. Renderers should prefer this over calling
   * getMarketplaceCatalog() and getMarketplaceStatus() separately.
   */
  getMarketplaceSnapshot(): {
    catalog: MarketplaceCatalogEntry[];
    status: { configured: boolean; ready: boolean; reachable: boolean; catalogSize: number };
  } {
    const catalog = this.getMarketplaceCatalog();
    const status = this.getMarketplaceStatus();
    return { catalog, status };
  }

  private async withInstallLock<T>(pluginName: string, fn: () => Promise<T>): Promise<T> {
    while (this.installLocks.has(pluginName)) {
      try {
        await this.installLocks.get(pluginName);
      } catch {
        /* ignore */
      }
    }
    const p = fn();
    this.installLocks.set(pluginName, p);
    try {
      return await p;
    } finally {
      if (this.installLocks.get(pluginName) === p) this.installLocks.delete(pluginName);
    }
  }

  getMarketplaceCatalog(): MarketplaceCatalogEntry[] {
    if (!this.marketplaceService) return [];

    const catalog = this.marketplaceService.getCachedCatalog() ?? [];

    // Annotate with current load status from PluginManager
    return catalog.map((entry) => {
      const installed =
        this.plugins.has(entry.name) || this.marketplaceService!.getInstalledPluginNames().includes(entry.name);

      // installedVersion may be absent when a plugin was installed manually (not via
      // marketplace) or when the cache predates version tracking.  Fall back to the
      // live manifest version so the Updates tab can detect newer catalog versions.
      const installedVersion =
        entry.installedVersion ??
        (installed ? (this.plugins.get(entry.name)?.manifest.version ?? undefined) : undefined);

      return { ...entry, installed, installedVersion };
    });
  }

  /* ── Plugin Update Detection ── */

  /**
   * Count how many installed plugins have a newer version available in the marketplace catalog.
   */
  getAvailableUpdateCount(): number {
    const catalog = this.marketplaceService?.getCachedCatalog() ?? [];
    let count = 0;
    for (const entry of catalog) {
      const instance = this.plugins.get(entry.name);
      if (instance && isNewerVersion(entry.version, instance.manifest.version)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Start periodic catalog refresh (every 4 hours) and broadcast update count.
   * Call after loadAll() and initMarketplace() have completed.
   */
  startCatalogRefresh(): void {
    // Initial broadcast
    this.broadcastUpdateCount();

    // Periodic refresh every 4 hours (same cadence as app auto-updater)
    const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
    this.catalogRefreshTimer = setInterval(() => {
      this.refreshMarketplace()
        .then(() => this.broadcastUpdateCount())
        .catch((err) => {
          console.warn('[PluginManager] Periodic catalog refresh failed:', err);
        });
    }, REFRESH_INTERVAL_MS);
  }

  private broadcastUpdateCount(): void {
    const count = this.getAvailableUpdateCount();
    if (count !== this.lastUpdateCount) {
      this.lastUpdateCount = count;
      broadcastToAllWindows('plugin:updates-available', { count });
    }
  }

  getPendingRestart(): string[] {
    return [...this.pendingRestart];
  }

  /** A frontend plugin shares the primary renderer's authenticated Browser
   * bridge. Disabling/uninstalling it must therefore replace that renderer,
   * rather than merely waiting for an optional later app restart. */
  rendererUnloadRequired(pluginName: string): boolean {
    return this.rendererLoadedThisSession.has(pluginName);
  }

  setRendererReplacementHandler(handler: (pluginName: string) => Promise<void>): void {
    this.rendererReplacementHandler = handler;
  }

  /** Mark the frontend unavailable synchronously, before IPC waits on renderer
   * replacement or plugin process/API teardown. */
  beginRendererUnload(pluginName: string): boolean {
    const required = this.rendererUnloadRequired(pluginName);
    if (required) {
      this.rendererRevocations.add(pluginName);
      this.broadcastUIState();
      // Revoke the authenticated primary-renderer bridge synchronously. This
      // callback is constructor-required, so a missing async replacement
      // handler can reject the lifecycle operation without leaving the old
      // plugin realm able to drive Browser IPC.
      try {
        this.revokePrimaryRendererAuthority();
      } catch (error) {
        // Replacement below is the second fail-closed path. Do not let broken
        // revocation bookkeeping abort before Chromium is reloaded/crashed.
        console.error(`[PluginManager] Error revoking primary renderer for "${pluginName}":`, error);
      }
      const instance = this.plugins.get(pluginName);
      if (instance) {
        try {
          this.revokeBrowserAssistantAccessForInstance(instance);
        } catch (error) {
          // rendererRevocations already removes the provider from future
          // selection, and replacement tears down any retained frontend realm.
          console.error(`[PluginManager] Error revoking Browser assistant access for "${pluginName}":`, error);
        }
      }
    }
    return required;
  }

  /** Roll back a pre-reload frontend revocation when disable/uninstall fails
   * and the same plugin generation is still live. The replacement renderer can
   * safely load the plugin again from the restored UI-state broadcast. */
  cancelRendererUnload(pluginName: string): boolean {
    if (!this.rendererRevocations.has(pluginName)) return false;
    const instance = this.plugins.get(pluginName);
    if (!instance || (instance.state !== 'active' && instance.state !== 'loading')) return false;
    this.rendererRevocations.delete(pluginName);
    this.broadcastUIState();
    return true;
  }

  acknowledgeRendererUnload(pluginName: string): void {
    const instance = this.plugins.get(pluginName);
    if (!this.rendererRevocations.has(pluginName) && instance && instance.state !== 'disabled') return;
    const replacementWillLoad = instance?.state === 'active' && !!instance.rendererBuild;
    this.rendererLoadedThisSession.delete(pluginName);
    this.rendererRevocations.delete(pluginName);
    this.clearPendingRestart(pluginName);
    // An update may already have activated its replacement frontend while the
    // revocation was held. Publish it only after the old renderer realm is gone.
    this.broadcastUIState();
    if (replacementWillLoad) this.rendererLoadedThisSession.add(pluginName);
  }

  /** Replace a privileged frontend realm before an update mutates plugin bytes,
   * approvals, or permissions. Background required-plugin refreshes use this
   * wrapper too, not only renderer-initiated marketplace IPC. */
  private async withRendererReplacementForUpdate<T>(pluginName: string, operation: () => Promise<T>): Promise<T> {
    const required = this.beginRendererUnload(pluginName);
    if (!required) return operation();
    if (!this.rendererReplacementHandler) {
      throw new Error(`Cannot update frontend plugin "${pluginName}" before its renderer is replaced.`);
    }

    let rendererReplaced = false;
    try {
      await this.rendererReplacementHandler(pluginName);
      rendererReplaced = true;
      return await operation();
    } finally {
      // Once replacement succeeds, the old realm is gone even when installation
      // later fails. Re-expose whichever generation is active to the fresh
      // renderer. A failed replacement stays revoked: its crash/navigation may
      // still be in flight, so restoring UI state here could re-enable the old
      // privileged realm before renderer death is confirmed.
      if (rendererReplaced) this.acknowledgeRendererUnload(pluginName);
    }
  }

  private markPendingRestart(pluginName: string): void {
    if (this.pendingRestart.has(pluginName)) return;
    this.pendingRestart.add(pluginName);
    broadcastToAllWindows('plugin:pending-restart-changed', { plugins: this.getPendingRestart() });
  }

  private clearPendingRestart(pluginName: string): void {
    if (!this.pendingRestart.delete(pluginName)) return;
    broadcastToAllWindows('plugin:pending-restart-changed', { plugins: this.getPendingRestart() });
  }

  getFailedUpdates(): Array<{ name: string; attemptedVersion: string; runningVersion: string; error: string }> {
    return [...this.failedUpdates.entries()].map(([name, info]) => ({ name, ...info }));
  }

  private setFailedUpdate(
    pluginName: string,
    info: { attemptedVersion: string; runningVersion: string; error: string } | null,
  ): void {
    if (info) {
      this.failedUpdates.set(pluginName, info);
    } else if (!this.failedUpdates.delete(pluginName)) {
      return;
    }
    broadcastToAllWindows('plugin:failed-updates-changed', { failedUpdates: this.getFailedUpdates() });
  }

  /**
   * Hot-swap a freshly installed plugin into the running set. If the new
   * version fails to reach `active`, restore the on-disk backup and reload the
   * previous version so a broken release never disables a working plugin.
   */
  private async swapToInstalledPlugin(
    pluginName: string,
    attemptedVersion: string,
    install: Pick<InstallResult, 'backupDir' | 'priorInstalledRecord' | 'priorApproval'>,
  ): Promise<{ ok: boolean; error?: string }> {
    // Renderer-side plugin modules are cached by URL in the renderer process and
    // won't re-import after a backend hot-reload, so once a renderer bundle has
    // shipped for this plugin in this session, any subsequent successful swap
    // still needs a full app restart for the frontend to match.
    const hadPriorRenderer = this.rendererLoadedThisSession.has(pluginName);

    await this.unloadPlugin(pluginName);

    const loadFromDisk = async () => {
      const found = this.discoverPlugins().find((d) => d.manifest.name === pluginName);
      if (found) await this.loadPlugin(found.manifest, found.dir);
      return this.plugins.get(pluginName);
    };

    let instance = await loadFromDisk();

    if (instance?.state === 'active') {
      if (install.backupDir) this.marketplaceService?.discardBackup(install.backupDir);
      this.setFailedUpdate(pluginName, null);
      if (hadPriorRenderer) {
        this.markPendingRestart(pluginName);
      } else {
        this.clearPendingRestart(pluginName);
      }
      return { ok: true };
    }

    if (instance?.state === 'disabled') {
      // The plugin is disabled, so loadPlugin left a stub without validating the
      // new version (no consent/activation yet). Defer the success/rollback
      // decision to enablePlugin() by stashing this install's backup: if the new
      // version later fails consent or activation on enable, the previous version
      // is restored; on success the backup is discarded.
      //
      // There is a single on-disk backup slot (<dir>.prev) which each install
      // overwrites, so a fresh update-while-disabled supersedes any prior stash —
      // discard the now-stale backup reference and track the latest one.
      const prior = this.pendingConsentRollback.get(pluginName);
      if (prior?.backupDir && prior.backupDir !== install.backupDir) {
        this.marketplaceService?.discardBackup(prior.backupDir);
      }
      if (install.backupDir) {
        this.pendingConsentRollback.set(pluginName, { ...install, attemptedVersion });
      } else {
        this.pendingConsentRollback.delete(pluginName);
        this.setFailedUpdate(pluginName, null);
      }
      return { ok: true };
    }

    if (this.pendingConsent.has(pluginName)) {
      // Hold the backup until the user approves/denies so we can roll back if
      // the new version is rejected or fails to activate after approval.
      this.pendingConsentRollback.set(pluginName, { ...install, attemptedVersion });
      if (hadPriorRenderer) this.markPendingRestart(pluginName);
      return { ok: true };
    }

    const error = instance?.error ?? 'Plugin failed to activate';

    if (!install.backupDir) {
      // Fresh install (no prior version to fall back to) — leave the error state.
      this.setFailedUpdate(pluginName, null);
      return { ok: false, error };
    }

    console.warn(
      `[PluginManager] "${pluginName}" v${attemptedVersion} failed to activate (${error}); rolling back to previous version`,
    );

    await this.unloadPlugin(pluginName);
    this.marketplaceService?.rollbackInstall(pluginName, install.backupDir, install);
    instance = await loadFromDisk();

    const runningVersion = instance?.manifest.version ?? install.priorInstalledRecord?.version ?? 'unknown';
    this.setFailedUpdate(pluginName, { attemptedVersion, runningVersion, error });

    if (hadPriorRenderer) {
      this.markPendingRestart(pluginName);
    }
    return { ok: false, error };
  }

  async installFromMarketplace(pluginName: string, opts?: { skipHashCheck?: boolean }): Promise<void> {
    if (!this.marketplaceService) {
      throw new Error('Marketplace is not initialized');
    }

    // Refuse to replace a plugin whose owed post-update cleanup hasn't reconciled
    // yet (R5P2): an explicit user "Update" would otherwise unload+reload the very
    // generation the startup reconciler is about to run cleanup against — killing
    // the captured utility-process hook and later running the old debt against the
    // replacement. The deferral clears once reconciliation completes.
    if (this.isUpdateDeferred(pluginName)) {
      throw new Error(`Plugin "${pluginName}" is finishing a previous update. Please try again in a moment.`);
    }

    const catalog = this.marketplaceService.getCachedCatalog();
    const entry = catalog?.find((p) => p.name === pluginName);
    if (!entry) {
      throw new Error(`Plugin "${pluginName}" not found in marketplace catalog`);
    }

    // Preflight: if the catalog entry has no integrity hash and the caller
    // has not opted in, throw BEFORE unloading the existing instance so a
    // user who declines the confirmation keeps their currently-loaded plugin.
    if (!opts?.skipHashCheck && !entry.archiveHash && !entry.fileHash && !entry.hash) {
      throw new UnverifiedPluginError(pluginName);
    }

    await this.withInstallLock(pluginName, () => {
      // RE-CHECK the deferral INSIDE the lock but BEFORE the renderer replacement
      // (R9P1/R28P9): the pre-lock check above is a snapshot; a concurrent
      // app-update (freeze) or rollback could have deferred this plugin while we
      // were queued. Bail here to avoid a needless full renderer reload for a
      // request that would replace a generation whose owed cleanup is still needed.
      if (this.isUpdateDeferred(pluginName)) {
        throw new Error(`Plugin "${pluginName}" is finishing a previous update. Please try again in a moment.`);
      }
      return this.withRendererReplacementForUpdate(pluginName, async () => {
        const result = await this.marketplaceService!.installPlugin(entry, opts);
        await this.swapToInstalledPlugin(pluginName, entry.version, result);
      });
    });

    // Update count changed since we just installed/updated a plugin
    this.broadcastUpdateCount();
  }

  async uninstallFromMarketplace(pluginName: string): Promise<void> {
    // Refuse to tear down a plugin that owes un-reconciled post-update cleanup —
    // checked FIRST (before marketplace/name checks): uninstalling unloads its
    // process, so the startup reconciler could no longer run its owed cleanup
    // in-process (R6P1). Clears once reconciliation completes.
    if (this.isUpdateDeferred(pluginName)) {
      throw new Error(`Plugin "${pluginName}" is finishing a previous update. Please try again in a moment.`);
    }

    if (!this.marketplaceService) {
      throw new Error('Marketplace is not initialized');
    }

    if (
      !pluginName ||
      pluginName.includes('/') ||
      pluginName.includes('\\') ||
      pluginName === '.' ||
      pluginName === '..'
    ) {
      throw new Error('Invalid plugin name');
    }

    if (this.brandRequiredPluginNamesSet.has(pluginName)) {
      throw new Error(`Plugin "${pluginName}" is required and cannot be uninstalled`);
    }

    await this.withInstallLock(pluginName, () => {
      // Re-check the freeze INSIDE the lock but BEFORE the renderer replacement
      // (R28P9): an app-update may have begun while this uninstall was queued —
      // bail here to avoid a needless renderer reload for a request that must not
      // strand the owed cleanup the updater expects to run against this generation.
      this.assertNotFrozen(pluginName);
      return this.withRendererReplacementForUpdate(pluginName, async () => {
        await this.unloadPlugin(pluginName);
        this.marketplaceService!.uninstallPlugin(pluginName);
        // Clear every piece of lifecycle state before releasing the same lock
        // used by install/update/disable. A replacement install must not start
        // and then have this uninstall's delayed cleanup mutate its generation.
        this.clearDisabledState(pluginName);
        this.clearPendingRestart(pluginName);
        this.setFailedUpdate(pluginName, null);
        // Clear any deferred disabled-update rollback stash + its consent state:
        // the plugin is gone, so there's nothing to roll back to, and a lingering
        // stash would otherwise leak (and — before R28P27 — could wedge app updates)
        // (R28P27). Discard the on-disk backup too.
        const stash = this.pendingConsentRollback.get(pluginName);
        if (stash?.backupDir) this.marketplaceService?.discardBackup(stash.backupDir);
        this.pendingConsentRollback.delete(pluginName);
        this.pendingConsent.delete(pluginName);
        this.broadcastUIState();
        this.notifyToolsChanged();
      });
    });
  }

  async refreshMarketplace(marketplaceUrls?: string[]): Promise<MarketplaceCatalogEntry[]> {
    if (!this.marketplaceService) return [];

    const urls = marketplaceUrls ?? this.getMarketplaceUrls();
    if (urls.length === 0) return [];

    // Full refresh (fetch + required-plugin auto-install) under the single-flight
    // guard — dedupes with a concurrent startup init or periodic refresh so the
    // same required plugin isn't (re)installed twice.
    await this.refreshCatalogSingleFlight(urls);
    // Broadcast the refreshed status so a marketplace view already open (e.g.
    // during the periodic 4-hour refresh, or a refresh triggered elsewhere)
    // reloads with the new reachability/catalog instead of showing stale state.
    this.broadcastMarketplaceReady();
    return this.getMarketplaceCatalog();
  }

  private getMarketplaceUrls(): string[] {
    try {
      return [...__BRAND_MARKETPLACE_URLS];
    } catch {
      return [];
    }
  }

  /* ── Conversation Helpers ── */

  listConversations(): Array<Record<string, unknown>> {
    return readAllConversations(this.appHome) as unknown as Array<Record<string, unknown>>;
  }

  getConversation(conversationId: string): Record<string, unknown> | null {
    return (readConversation(this.appHome, conversationId) as unknown as Record<string, unknown>) ?? null;
  }

  upsertConversation(conversation: Record<string, unknown>): void {
    const conversationId = typeof conversation.id === 'string' ? conversation.id : '';
    if (!conversationId) {
      throw new Error('Conversation id is required');
    }
    const written = writeConversation(this.appHome, conversation as unknown as ConversationRecord);
    broadcastUpsert(this.appHome, written);
  }

  setActiveConversation(conversationId: string): void {
    setActiveConversationId(this.appHome, conversationId);
    broadcastActive(this.appHome);
  }

  appendConversationMessage(
    conversationId: string,
    message: {
      role: string;
      content: unknown;
      metadata?: Record<string, unknown>;
      parentId?: string | null;
      createdAt?: string;
    },
  ): Record<string, unknown> | null {
    const conversation = readConversation(this.appHome, conversationId) as unknown as Record<string, unknown> | null;
    if (!conversation) return null;

    const messageId = `plugin-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = message.createdAt ?? new Date().toISOString();
    const normalizedRole = message.role === 'user' ? 'user' : 'assistant';
    const normalizedContent =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : Array.isArray(message.content)
          ? message.content
          : [];
    const parentId =
      message.parentId ??
      (Array.isArray(conversation.messages) && conversation.messages.length > 0
        ? ((conversation.messages[conversation.messages.length - 1] as { id?: string }).id ?? null)
        : null);

    const nextMessage: Record<string, unknown> = {
      id: messageId,
      role: normalizedRole,
      content: normalizedContent,
      parentId,
      createdAt,
      metadata: {
        ...(message.metadata ?? {}),
        originalRole: message.role,
      },
    };

    const nextMessages = Array.isArray(conversation.messages) ? [...conversation.messages, nextMessage] : [nextMessage];
    const nextConversation = {
      ...conversation,
      messages: nextMessages,
      updatedAt: createdAt,
      lastMessageAt: createdAt,
      lastAssistantUpdateAt: normalizedRole === 'assistant' ? createdAt : conversation.lastAssistantUpdateAt,
      messageCount: nextMessages.length,
      userMessageCount:
        normalizedRole === 'user'
          ? ((conversation.userMessageCount as number | undefined) ?? 0) + 1
          : ((conversation.userMessageCount as number | undefined) ?? 0),
      hasUnread: normalizedRole === 'assistant' ? true : conversation.hasUnread,
    };

    const written = writeConversation(this.appHome, nextConversation as unknown as ConversationRecord);
    broadcastUpsert(this.appHome, written);
    return written as unknown as Record<string, unknown>;
  }

  markConversationUnread(conversationId: string, unread: boolean): void {
    const conversation = readConversation(this.appHome, conversationId);
    if (!conversation) return;
    const next: ConversationRecord = {
      ...conversation,
      hasUnread: unread,
      updatedAt: new Date().toISOString(),
    };
    const written = writeConversation(this.appHome, next);
    broadcastUpsert(this.appHome, written);
  }
}
