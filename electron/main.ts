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
} from 'electron';
import { basename, join, sep } from 'path';
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync, appendFileSync } from 'fs';
import { homedir } from 'os';
import { readEffectiveConfig, registerConfigHandlers } from './ipc/config.js';
import {
  registerAgentHandlers,
  registerTools,
  updateMcpTools,
  updateSkillTools,
  updatePluginTools,
  updateCliTools,
  getRegisteredTools,
  setWorkspaceToolDefinitions,
  getWorkspaceToolDefinitions,
} from './ipc/agent.js';
import { registerConversationHandlers } from './ipc/conversations.js';
import { resetStaleRunStatus } from './ipc/conversation-store.js';
import { getCliInstallStatus, installCliCommand, uninstallCliCommand } from './ipc/cli-install.js';
import { buildToolRegistry } from './tools/registry.js';
import { buildCliTools } from './tools/cli-tools.js';
import { registerMcpHandlers } from './ipc/mcp.js';
import { registerMemoryHandlers } from './ipc/memory.js';
import { rebuildMcpTools, disconnectAllMcpServers } from './tools/mcp-client.js';
import { loadSkillsAsTools } from './tools/skill-loader.js';
import { registerSkillsHandlers } from './ipc/skills.js';
import { registerPlatformHandlers } from './ipc/platform.js';
import { registerAppshotHandlers } from './ipc/appshots.js';
import { registerDiffHandlers } from './ipc/diffs.js';
import { registerArtifactBundleHandlers } from './ipc/artifact-bundle.js';
import { registerAutomationsHandlers } from './ipc/automations.js';
import { eventBus } from './automations/event-bus.js';
import { registerBuiltinSources } from './automations/builtin-sources.js';
import { getAutomationEngine, initializeAutomationEngine } from './automations/engine.js';
import { PluginManager } from './plugins/plugin-manager.js';
import { registerPluginHandlers } from './ipc/plugins.js';
import { registerMicRecorderHandlers, cleanupMicRecorder, getRecorderWindow } from './audio/mic-recorder.js';
import { registerLiveSttHandlers } from './audio/live-stt.js';
import { registerBatchTranscribeHandlers } from './audio/batch-transcribe.js';
import { registerStreamingSttHandlers } from './audio/streaming-stt.js';
import { registerRealtimeHandlers, updateActiveRealtimeSessionTools } from './ipc/realtime.js';
import type { AppConfig } from './config/schema.js';
import { registerRuntime } from './agent/runtime/index.js';
import { MastraRuntime } from './agent/runtime/mastra-runtime.js';
import { ClaudeAgentRuntime } from './agent/runtime/claude-agent-runtime.js';
import { CodexRuntime } from './agent/runtime/codex-runtime.js';
import { PiRuntime } from './agent/runtime/pi-runtime.js';
import { registerComputerUseHandlers } from './ipc/computer-use.js';
import { getExistingComputerUseManager } from './computer-use/service.js';
import { registerClipboardHandlers } from './ipc/clipboard.js';
import { registerShellHandlers } from './ipc/shell.js';
import { registerPartitionHandlers } from './ipc/partitions.js';
import { registerTaskHandlers } from './ipc/tasks.js';
import {
  registerAgentHandlers as registerAgentEntityHandlers,
  listAllAgents,
  assignTaskToAgent,
  startAgentRun,
  stopAgentForDeletedTask,
} from './ipc/agents.js';
import { listAllTasks } from './ipc/tasks.js';
import { TaskDispatcher } from './agent/task-dispatcher.js';
import { registerOrchestratorHandlers, broadcastOrchestratorState } from './ipc/orchestrator.js';
import { registerWorkspaceHandlers } from './ipc/workspaces.js';
import { TaskTerminalManager, registerTaskTerminalHandlers } from './terminal/task-terminal-manager.js';
import { initOutputBuffer, flushAll as flushOutputBuffers } from './terminal/output-buffer.js';
import { closeAllOverlayWindows } from './computer-use/overlay-window.js';
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
import { webClients } from './web-server/web-clients.js';
import { createPaddedDockIcon, setPaddedMacDockIcon } from './utils/dock-icon.js';
import { resolveCodePaths } from './ota/bootstrap.js';
import { checkAndHandleRollback, signalAppRunning, signalGracefulQuit } from './ota/rollback.js';
import { registerOtaHandlers, cleanupOta } from './ipc/ota.js';
import { initializeSubagentCleanup } from './services/subagent-cleanup.js';
import { isExternallyOpenableUrl } from './utils/safe-external-url.js';
import { safeReadFileWithin } from './utils/safe-file-read.js';

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

function formatMainProcessError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function recordMainProcessUnhandledError(kind: MainProcessUnhandledKind, error: unknown): void {
  const formatted = formatMainProcessError(error);
  console.error(`[${__BRAND_PRODUCT_NAME}] Unhandled main-process ${kind}:`, error);
  try {
    mkdirSync(join(APP_HOME, 'logs'), { recursive: true });
    appendFileSync(MAIN_PROCESS_LOG, `[${new Date().toISOString()}] [${kind}] ${formatted}\n\n`, 'utf-8');
  } catch {
    /* best-effort logging only */
  }
}

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
initPluginBrowser(codePaths);

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

let updateDownloaded = false;
let primaryWindowRef: BrowserWindow | null = null;
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
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
      { type: 'separator' },
      {
        label: 'Find',
        accelerator: 'CommandOrControl+F',
        click: () => {
          const win = BrowserWindow.getFocusedWindow();
          if (win) win.webContents.send('menu:find');
        },
      },
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
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
                const resp = await net.fetch(params.srcURL, {
                  headers: withBrandUserAgent(),
                });
                if (resp.ok) {
                  const buffer = Buffer.from(await resp.arrayBuffer());
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

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(codePaths.renderer, 'index.html'));
  }

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
  });
  mainWindow.on('closed', () => {
    if (primaryWindowRef === mainWindow) {
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
    let lastSkillsFingerprint = JSON.stringify(getConfig().skills?.enabled ?? []);
    let lastCliToolsFingerprint = JSON.stringify(getConfig().cliTools ?? []);
    let lastDisplayFingerprint = JSON.stringify(getConfig().computerUse?.localMacos?.allowedDisplays ?? []);
    let lastWebServerFingerprint = JSON.stringify(getConfig().webServer ?? {});
    let lastLaunchAtLoginFp = JSON.stringify(getConfig().launchAtLogin ?? false);
    let lastAutopilotFingerprint = JSON.stringify(getConfig().autopilot ?? {});
    let webServerDebounce: ReturnType<typeof setTimeout> | null = null;
    const syncRealtimeTools = (): void => {
      updateActiveRealtimeSessionTools(getRegisteredTools());
    };

    const handleConfigChanged = (config: AppConfig) => {
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

      // Skills hot-reload
      const newSkillsFp = JSON.stringify(config.skills?.enabled ?? []);
      if (newSkillsFp !== lastSkillsFingerprint) {
        lastSkillsFingerprint = newSkillsFp;
        const skillsDir = config.skills?.directory || join(APP_HOME, 'skills');
        const skillTools = loadSkillsAsTools(skillsDir, config.skills?.enabled ?? [], getConfig);
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
    const { setConfig } = registerConfigHandlers(ipcMain, APP_HOME, handleConfigChanged);
    registerConversationHandlers(ipcMain, APP_HOME, getConfig);
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

    // Debug logging: renderer can write to debug-logs/ via IPC
    const debugLogDir = join(process.cwd(), 'debug-logs');
    ipcMain.on('debug:log', (_event, file: string, message: string) => {
      try {
        mkdirSync(debugLogDir, { recursive: true });
        const safeName = file.replace(/[^a-zA-Z0-9_-]/g, '');
        appendFileSync(join(debugLogDir, `${safeName}.log`), `[${new Date().toISOString()}] ${message}\n`);
      } catch {
        /* ignore */
      }
    });
    registerComputerUseHandlers(ipcMain, APP_HOME, getConfig);
    registerClipboardHandlers(ipcMain);
    registerShellHandlers(ipcMain);
    registerPartitionHandlers(ipcMain);
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
          void startAgentRun(APP_HOME, taskTerminalManager, assignedAgentId);
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
            console.info(`[Autopilot] Unblocked task "${task.title}": ${result.resolution}`);

            // Auto-restart the assigned agent
            if (task.assignedAgentId) {
              setTimeout(() => {
                void startAgentRun(APP_HOME, taskTerminalManager, task.assignedAgentId);
              }, 500);
            }
            return true;
          } else {
            task.unblockAttempts = (task.unblockAttempts ?? 0) + 1;
            task.updatedAt = new Date().toISOString();
            writeFileSync(taskPath, JSON.stringify(task, null, 2), 'utf-8');
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
    );
    registerPluginHandlers(ipcMain, pluginManager);
    pluginManagerRef = pluginManager;
    setUpdateHookRunner(pluginManager);

    // Register agent handlers after pluginManager so inference providers are available
    registerAgentHandlers(ipcMain, APP_HOME, pluginManager);

    // A fresh backend has no in-flight runs. If a previous leader died mid-run,
    // stale `running`/`awaiting-approval` runStatus is left on disk — sweep it to
    // idle before serving clients so nothing shows a stuck spinner or blocks new
    // submits.
    try {
      resetStaleRunStatus(APP_HOME);
    } catch (err) {
      console.warn(`[${__BRAND_PRODUCT_NAME}] stale runStatus sweep failed (non-fatal):`, err);
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
        }, 2000).unref();
      },
    })
      .then((socketPath) => console.info(`[${__BRAND_PRODUCT_NAME}] Local CLI bridge listening at ${socketPath}`))
      .catch((err) => {
        console.error(`[${__BRAND_PRODUCT_NAME}] Local CLI bridge failed to start:`, err);
        // A headless backend with no reachable socket is useless AND would hold
        // the singleton lock forever, blocking every future CLI/GUI launch. Exit
        // so the next launch can take over. A windowed GUI leader keeps running
        // (the socket is a bonus there, not its reason to exist).
        if (IS_HEADLESS) {
          app.quit();
          setTimeout(() => app.exit(1), 2000).unref();
        }
      });

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
    const automationEngine = initializeAutomationEngine({
      bus: eventBus,
      appHome: APP_HOME,
      getConfig,
      getAutomationsConfig: () => getConfig().automations,
      getRegisteredTools,
      getWorkspaceTools: getWorkspaceToolDefinitions,
      handlePluginAction: (payload) => pluginManager.handleAction(payload),
    });
    registerAutomationsHandlers(ipcMain, automationEngine, eventBus);

    // Register available agent runtimes
    registerRuntime(new MastraRuntime());
    registerRuntime(new ClaudeAgentRuntime());
    registerRuntime(new CodexRuntime());
    registerRuntime(new PiRuntime());

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

        // Read files and return as base64 data URLs
        const files = result.filePaths.map((filePath) => {
          const data = readFileSync(filePath);
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
          return {
            path: filePath,
            name: basename(filePath),
            mime,
            isImage,
            size: data.length,
            dataUrl: `data:${mime};base64,${data.toString('base64')}`,
            // For text files, also include raw text
            ...(mime.startsWith('text/') || mime === 'application/json' ? { text: data.toString('utf-8') } : {}),
          };
        });
        return { canceled: false, files };
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

    // List directory contents on the host (used by web UI directory browser)
    ipcMain.handle('fs:list-directory', (_event, dirPath: string) => {
      try {
        const resolved = dirPath === '~' ? homedir() : dirPath.replace(/^~\//, homedir() + '/');
        if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
          return { error: 'Not a directory', entries: [] };
        }
        const entries = readdirSync(resolved, { withFileTypes: true })
          .filter((e) => !e.name.startsWith('.'))
          .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }))
          .sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
        return { path: resolved, entries };
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
        if (!existsSync(resolved) || !statSync(resolved).isFile()) {
          return { error: 'File not found' };
        }
        return { content: readFileSync(resolved, 'utf-8') };
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

      const data = safeReadFileWithin(mediaDir, filePath);
      if (!data) {
        return new Response('Not Found', { status: 404 });
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

      return new Response(new Uint8Array(data), {
        headers: { 'Content-Type': contentType, 'Cache-Control': 'no-cache' },
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

      // Symlink/TOCTOU-safe read: a malicious plugin could plant a symlink in
      // its own dir to exfiltrate files outside it via its renderer bundle.
      const data = safeReadFileWithin(resolved.baseDir, resolved.filePath);
      if (!data) {
        return new Response('Not Found', { status: 404 });
      }
      return new Response(new Uint8Array(data), {
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
        // Initialize marketplace and auto-install required plugins before loading
        const marketplaceUrls = getBrandMarketplaceUrls();
        if (marketplaceUrls.length > 0) {
          try {
            await pluginManager.initMarketplace(marketplaceUrls);
          } catch (err) {
            console.warn(`[${__BRAND_PRODUCT_NAME}] Marketplace init failed (non-fatal):`, err);
          }
        }

        await pluginManager.loadAll();
        console.info(`[${__BRAND_PRODUCT_NAME}] ${pluginManager.getPluginCount()} plugins loaded`);

        // Start periodic marketplace catalog refresh for plugin update detection
        pluginManager.startCatalogRefresh();

        // If this launch follows a successful update, fire post-update hooks
        // (e.g., revoke admin privileges granted by pre-update hook).
        const updateMarker = consumePostUpdateMarker();
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
        registerTools(allTools);
        console.info(`[${__BRAND_PRODUCT_NAME}] ${tools.length} tools + ${pluginTools.length} plugin tools registered`);

        // Register realtime handlers (needs tool registry)
        registerRealtimeHandlers(ipcMain, getConfig, getRegisteredTools, APP_HOME);

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

app.on('before-quit', () => {
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
  taskTerminalManagerRef?.dispose();
  flushOutputBuffers();
  taskDispatcherRef?.stop();
});
