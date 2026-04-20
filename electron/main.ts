import { app, BrowserWindow, ipcMain, shell, Menu, nativeTheme, dialog, net, MenuItem, clipboard, systemPreferences, protocol, screen } from 'electron';
import { join } from 'path';
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { readEffectiveConfig, registerConfigHandlers } from './ipc/config.js';
import { registerAgentHandlers, registerTools, updateMcpTools, updateSkillTools, updatePluginTools, updateCliTools, getRegisteredTools } from './ipc/agent.js';
import { registerConversationHandlers } from './ipc/conversations.js';
import { registerWorkspaceTaskHandlers } from './ipc/workspace-tasks.js';
import { buildToolRegistry } from './tools/registry.js';
import { buildCliTools } from './tools/cli-tools.js';
import { registerMcpHandlers } from './ipc/mcp.js';
import { registerMemoryHandlers } from './ipc/memory.js';
import { rebuildMcpTools } from './tools/mcp-client.js';
import { loadSkillsAsTools } from './tools/skill-loader.js';
import { registerSkillsHandlers } from './ipc/skills.js';
import { PluginManager } from './plugins/plugin-manager.js';
import { registerPluginHandlers } from './ipc/plugins.js';
import { registerMicRecorderHandlers, cleanupMicRecorder } from './audio/mic-recorder.js';
import { registerLiveSttHandlers } from './audio/live-stt.js';
import { registerRealtimeHandlers, updateActiveRealtimeSessionTools } from './ipc/realtime.js';
import type { AppConfig } from './config/schema.js';
import { registerComputerUseHandlers } from './ipc/computer-use.js';
import { registerClipboardHandlers } from './ipc/clipboard.js';
import { registerShellHandlers } from './ipc/shell.js';
import { closeAllOverlayWindows } from './computer-use/overlay-window.js';
import { registerUsageHandlers } from './ipc/usage.js';
import { registerAutoUpdateHandlers, checkForUpdatesInteractive, performQuitAndInstall } from './ipc/auto-update.js';
import { registerPtyHandlers, destroyAllPtys } from './workspace/pty-manager.js';
import { applyBrandUserAgent, withBrandUserAgent } from './utils/user-agent.js';
import { bootstrapSuperpowers } from './tools/superpowers-bootstrap.js';
import { bootstrapBundledPlugins, getBrandRequiredPluginNames } from './plugins/plugin-bootstrap.js';
import { PLUGIN_RENDERER_PROTOCOL } from './plugins/renderer-build.js';
import { primeResolvedShellPath } from './utils/shell-env.js';
import { installIpcCapture } from './web-server/ipc-bridge.js';
import { startWebServer, stopWebServer, restartWebServer } from './web-server/web-server.js';

const APP_HOME = join(homedir(), '.' + __BRAND_APP_SLUG);

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

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

// Module-level ref for cleanup in before-quit handler
let pluginManagerRef: PluginManager | null = null;

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

function buildMenu(): void {
  const updateMenuItem: Electron.MenuItemConstructorOptions = updateDownloaded
    ? {
        label: 'Restart to Update',
        click: () => {
          performQuitAndInstall();
        },
      }
    : {
        label: 'Check for Updates…',
        click: () => {
          checkForUpdatesInteractive();
        },
      };
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        updateMenuItem,
        {
          label: 'Settings…',
          accelerator: 'Cmd+,',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) win.webContents.send('menu:open-settings');
          },
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
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
          accelerator: 'Cmd+F',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) win.webContents.send('menu:find');
          },
        },
      ],
    },
    {
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
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom', label: 'Maximize' },
        { role: 'close' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Resolve the app icon — works in both dev and packaged builds
const APP_ICON = join(import.meta.dirname, '../../build/icon.png');
const IS_MAC = process.platform === 'darwin';

function createWindow(): BrowserWindow {
  const savedState = loadWindowState();
  const mainWindow = new BrowserWindow({
    ...(savedState.x !== undefined && savedState.y !== undefined ? { x: savedState.x, y: savedState.y } : {}),
    width: savedState.width,
    height: savedState.height,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: __BRAND_PRODUCT_NAME,
    icon: APP_ICON,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 10 },
    transparent: IS_MAC,
    vibrancy: IS_MAC ? 'sidebar' : undefined,
    visualEffectState: IS_MAC ? 'active' : undefined,
    backgroundColor: IS_MAC ? '#00000000' : (nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#ffffff'),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
    },
  });
  applyBrandUserAgent(mainWindow.webContents);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
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
      menu.append(new MenuItem({
        label: 'Copy Image',
        click: () => mainWindow.webContents.copyImageAt(params.x, params.y),
      }));
      menu.append(new MenuItem({
        label: 'Copy Image URL',
        click: () => clipboard.writeText(params.srcURL),
      }));
      menu.append(new MenuItem({
        label: 'Save Image As\u2026',
        click: async () => {
          try {
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
          } catch { /* ignore save errors */ }
        },
      }));
      if (params.selectionText) {
        menu.append(new MenuItem({ type: 'separator' }));
        menu.append(new MenuItem({ role: 'copy' }));
      }
    } else if (params.isEditable) {
      // Spellcheck suggestions
      if (params.misspelledWord) {
        if (params.dictionarySuggestions.length > 0) {
          for (const suggestion of params.dictionarySuggestions) {
            menu.append(new MenuItem({
              label: suggestion,
              click: () => mainWindow.webContents.replaceMisspelling(suggestion),
            }));
          }
        } else {
          menu.append(new MenuItem({ label: 'No suggestions', enabled: false }));
        }
        menu.append(new MenuItem({ type: 'separator' }));
        menu.append(new MenuItem({
          label: 'Add to Dictionary',
          click: () => mainWindow.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
        }));
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
      menu.append(new MenuItem({
        label: 'Open Link',
        click: () => shell.openExternal(params.linkURL),
      }));
      menu.append(new MenuItem({
        label: 'Copy Link',
        click: () => clipboard.writeText(params.linkURL),
      }));
    }

    if (menu.items.length > 0) {
      menu.popup({ window: mainWindow });
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'));
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

  return mainWindow;
}

function focusPrimaryWindow(): void {
  const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
  if (!win) {
    if (app.isReady()) createWindow();
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
  app.on('second-instance', () => {
    focusPrimaryWindow();
  });

  app.whenReady().then(() => {
    ensureAppHome();
    applyTheme();
    buildMenu();
    const shellPathReady = primeResolvedShellPath().catch((error) => {
      console.warn(`[${__BRAND_PRODUCT_NAME}] Failed to resolve shell PATH, using inherited environment:`, error);
      return process.env.PATH ?? '';
    });

    // Request microphone permission on macOS (needed for speech-to-text dictation)
    if (process.platform === 'darwin') {
      systemPreferences.askForMediaAccess('microphone').then((granted) => {
        console.info(`[${__BRAND_PRODUCT_NAME}] Microphone permission: ${granted ? 'granted' : 'denied'}`);
      }).catch((err) => {
        console.warn(`[${__BRAND_PRODUCT_NAME}] Failed to request microphone permission:`, err);
      });
    }

    // Set dock icon (macOS) — needed for dev mode since packager config doesn't apply
    if (process.platform === 'darwin' && app.dock && existsSync(APP_ICON)) {
      app.dock.setIcon(APP_ICON);
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
    let lastMcpFingerprint = JSON.stringify(getConfig().mcpServers ?? []);
    let lastSkillsFingerprint = JSON.stringify(getConfig().skills?.enabled ?? []);
    let lastCliToolsFingerprint = JSON.stringify(getConfig().cliTools ?? []);
    let lastDisplayFingerprint = JSON.stringify(getConfig().computerUse?.localMacos?.allowedDisplays ?? []);
    let lastWebServerFingerprint = JSON.stringify(getConfig().webServer ?? {});
    let lastLaunchAtLoginFp = JSON.stringify(getConfig().launchAtLogin ?? false);
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
        rebuildMcpTools(config.mcpServers ?? []).then((mcpTools) => {
          updateMcpTools(mcpTools);
          syncRealtimeTools();
          console.info(`[${__BRAND_PRODUCT_NAME}] MCP hot-reload complete: ${mcpTools.length} MCP tools`);
        }).catch((err) => {
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
        void shellPathReady.then(() => {
          const cliTools = buildCliTools(getConfig);
          updateCliTools(cliTools);
          syncRealtimeTools();
          console.info(`[${__BRAND_PRODUCT_NAME}] CLI tools hot-reload: ${cliTools.length} tools`);
        }).catch((err) => {
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
              const enabled = layout.displays.filter((d: { name: string; displayId: string }) =>
                allowedLower.has(d.name.toLowerCase()) || allowedLower.has(d.displayId.toLowerCase()),
              );
              if (enabled.length === 0) return;
              const maxDim = Math.max(
                ...enabled.map((d: { pixelWidth: number; pixelHeight: number }) => Math.max(d.pixelWidth, d.pixelHeight)),
              );
              if (maxDim > 0 && maxDim !== config.computerUse?.capture?.maxDimension) {
                setConfig('computerUse.capture.maxDimension', maxDim);
                console.info(`[${__BRAND_PRODUCT_NAME}] Auto-updated maxDimension to ${maxDim} for ${enabled.length} enabled displays`);
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
          if (wsConfig?.enabled) {
            restartWebServer(wsConfig)
              .then(() => console.info(`[${__BRAND_PRODUCT_NAME}] Web UI server restarted on ${wsConfig.tls?.enabled ? 'https' : 'http'}://localhost:${wsConfig.port}`))
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

      // Launch at login
      const newLaunchAtLoginFp = JSON.stringify(config.launchAtLogin ?? false);
      if (newLaunchAtLoginFp !== lastLaunchAtLoginFp) {
        lastLaunchAtLoginFp = newLaunchAtLoginFp;
        app.setLoginItemSettings({ openAtLogin: config.launchAtLogin ?? false });
      }
    };

    // Register IPC handlers (capture must be installed first for web UI bridge)
    installIpcCapture(ipcMain);
    const { setConfig } = registerConfigHandlers(ipcMain, APP_HOME, handleConfigChanged);
    registerAgentHandlers(ipcMain, APP_HOME);
    registerConversationHandlers(ipcMain, APP_HOME, getConfig);
    registerWorkspaceTaskHandlers(ipcMain, APP_HOME);
    registerMcpHandlers(ipcMain);
    registerMemoryHandlers(ipcMain, APP_HOME, getConfig);
    registerSkillsHandlers(ipcMain, APP_HOME);
    registerMicRecorderHandlers(ipcMain);
    registerLiveSttHandlers(ipcMain);
    registerComputerUseHandlers(ipcMain, APP_HOME, getConfig);
    registerClipboardHandlers(ipcMain);
    registerShellHandlers(ipcMain);
    registerPtyHandlers(() => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null);
    registerUsageHandlers(ipcMain, APP_HOME);
    registerAutoUpdateHandlers(ipcMain, () => {
      updateDownloaded = true;
      buildMenu();
    });

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
          ...layout.displays.map((d: { pixelWidth: number; pixelHeight: number }) => Math.max(d.pixelWidth, d.pixelHeight)),
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

    // Listen for plugin tool changes before plugin activation so early registrations are not missed
    pluginManager.onToolsChanged((pluginTools) => {
      updatePluginTools(pluginTools);
      syncRealtimeTools();
    });

    // File dialog handler
    ipcMain.handle('dialog:open-file', async (_event, options?: { filters?: Array<{ name: string; extensions: string[] }> }) => {
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
          png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
          webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
          txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv',
        };
        const mime = mimeTypes[ext] ?? 'application/octet-stream';
        const isImage = mime.startsWith('image/');
        return {
          path: filePath,
          name: filePath.split('/').pop() ?? filePath,
          mime,
          isImage,
          size: data.length,
          dataUrl: `data:${mime};base64,${data.toString('base64')}`,
          // For text files, also include raw text
          ...(mime.startsWith('text/') || mime === 'application/json'
            ? { text: data.toString('utf-8') }
            : {}),
        };
      });
      return { canceled: false, files };
    });

    ipcMain.handle('dialog:open-directory', async () => {
      const win = BrowserWindow.getFocusedWindow();
      if (!win) return { canceled: true };
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) return { canceled: true };

      const directoryPath = result.filePaths[0];
      return {
        canceled: false,
        directoryPath,
        name: directoryPath.split('/').pop() ?? directoryPath,
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

    // Read file contents (capped at 100KB)
    ipcMain.handle('fs:read-file', async (_event, filePath: string) => {
      const fsPromises = await import('node:fs/promises');
      try {
        const content = await fsPromises.readFile(filePath, 'utf-8');
        return { content: content.slice(0, 100000) }; // limit to 100KB
      } catch (err) {
        return { error: (err as Error).message };
      }
    });

    // Git worktree management
    ipcMain.handle('git:list-worktrees', async (_event, projectPath: string) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { getResolvedProcessEnv } = await import('./utils/shell-env.js');
      const exec = promisify(execFile);
      try {
        const { stdout } = await exec('git', ['worktree', 'list', '--porcelain'], { cwd: projectPath, env: getResolvedProcessEnv() });
        const worktrees: Array<{ path: string; branch: string; head: string }> = [];
        let current: Record<string, string> = {};
        for (const line of stdout.split('\n')) {
          if (line.startsWith('worktree ')) current.path = line.slice(9);
          else if (line.startsWith('HEAD ')) current.head = line.slice(5);
          else if (line.startsWith('branch ')) current.branch = line.slice(7).replace('refs/heads/', '');
          else if (line === '') {
            if (current.path) worktrees.push({ path: current.path, branch: current.branch ?? 'detached', head: current.head ?? '' });
            current = {};
          }
        }
        return { worktrees };
      } catch (err) {
        return { worktrees: [], error: (err as Error).message };
      }
    });

    ipcMain.handle('git:create-worktree', async (_event, projectPath: string, branchName: string) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const path = await import('node:path');
      const fs = await import('node:fs');
      const { getResolvedProcessEnv } = await import('./utils/shell-env.js');
      const exec = promisify(execFile);
      try {
        // Ensure .worktrees is in .gitignore
        const gitignorePath = path.join(projectPath, '.gitignore');
        try {
          const content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
          if (!content.includes('.worktrees')) {
            fs.writeFileSync(gitignorePath, content.trimEnd() + '\n.worktrees/\n', 'utf-8');
          }
        } catch { /* ignore gitignore errors */ }

        const worktreePath = path.join(projectPath, '.worktrees', branchName);
        await exec('git', ['worktree', 'add', '-b', branchName, worktreePath], { cwd: projectPath, env: getResolvedProcessEnv() });
        return { path: worktreePath, branch: branchName };
      } catch (err) {
        return { error: (err as Error).message };
      }
    });

    ipcMain.handle('git:remove-worktree', async (_event, projectPath: string, worktreePath: string) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { getResolvedProcessEnv } = await import('./utils/shell-env.js');
      const exec = promisify(execFile);
      try {
        await exec('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: projectPath, env: getResolvedProcessEnv() });
        return { success: true };
      } catch (err) {
        return { error: (err as Error).message };
      }
    });

    // Git status — returns list of changed files
    ipcMain.handle('git:status', async (_event, projectPath: string) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { getResolvedProcessEnv } = await import('./utils/shell-env.js');
      const exec = promisify(execFile);
      try {
        const { stdout } = await exec('git', ['status', '--porcelain', '-uall'], { cwd: projectPath, env: getResolvedProcessEnv(), maxBuffer: 1024 * 1024 });
        const files: Array<{ path: string; status: string }> = [];
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue;
          const status = line.slice(0, 2).trim();
          const filePath = line.slice(3).trim().replace(/^"(.*)"$/, '$1');
          if (filePath.startsWith('.worktrees/') || filePath.startsWith('.worktrees\\')) continue;
          files.push({ path: filePath, status });
        }
        return { files };
      } catch (err) {
        return { files: [], error: (err as Error).message };
      }
    });

    // Git diff — returns unified diff for a file or the whole repo
    ipcMain.handle('git:diff', async (_event, projectPath: string, filePath?: string) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { getResolvedProcessEnv } = await import('./utils/shell-env.js');
      const exec = promisify(execFile);
      try {
        // Get both staged and unstaged diffs
        const args = ['diff', 'HEAD'];
        if (filePath) args.push('--', filePath);
        const { stdout } = await exec('git', args, { cwd: projectPath, env: getResolvedProcessEnv(), maxBuffer: 5 * 1024 * 1024 });

        // If no diff against HEAD (new untracked file), try showing the file content as all-adds
        if (!stdout.trim() && filePath) {
          const { stdout: statusOut } = await exec('git', ['status', '--porcelain', '--', filePath], { cwd: projectPath, env: getResolvedProcessEnv() });
          if (statusOut.startsWith('??') || statusOut.trim().startsWith('A')) {
            // Untracked or newly added — show full file as diff
            const { readFile } = await import('node:fs/promises');
            const { join } = await import('node:path');
            try {
              const content = await readFile(join(projectPath, filePath), 'utf-8');
              const lines = content.split('\n');
              const fakeDiff = [
                `diff --git a/${filePath} b/${filePath}`,
                'new file mode 100644',
                `--- /dev/null`,
                `+++ b/${filePath}`,
                `@@ -0,0 +1,${lines.length} @@`,
                ...lines.map((l) => `+${l}`),
              ].join('\n');
              return { diff: fakeDiff };
            } catch {
              return { diff: '' };
            }
          }
        }

        return { diff: stdout };
      } catch (err) {
        return { diff: '', error: (err as Error).message };
      }
    });

    // Git current branch
    ipcMain.handle('git:current-branch', async (_event, projectPath: string) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { getResolvedProcessEnv } = await import('./utils/shell-env.js');
      const exec = promisify(execFile);
      try {
        const { stdout } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectPath, env: getResolvedProcessEnv() });
        return { branch: stdout.trim() };
      } catch (err) {
        return { branch: '', error: (err as Error).message };
      }
    });

    // Git branches — list all local branches with metadata
    ipcMain.handle('git:branches', async (_event, projectPath: string) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { getResolvedProcessEnv } = await import('./utils/shell-env.js');
      const exec = promisify(execFile);
      try {
        const env = getResolvedProcessEnv();
        // Get local branches with format
        const { stdout } = await exec('git', ['branch', '--format=%(refname:short)\t%(objectname:short)\t%(upstream:short)\t%(HEAD)\t%(committerdate:relative)'], { cwd: projectPath, env });
        const branches: Array<{ name: string; shortHash: string; upstream: string; isCurrent: boolean; isDefault: boolean; lastActivity: string }> = [];
        // Detect default branch
        let defaultBranch = 'main';
        try {
          const { stdout: defOut } = await exec('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: projectPath, env });
          defaultBranch = defOut.trim().replace('refs/remotes/origin/', '');
        } catch {
          // Fallback: check if 'main' or 'master' exists
          try {
            await exec('git', ['rev-parse', '--verify', 'main'], { cwd: projectPath, env });
            defaultBranch = 'main';
          } catch {
            try {
              await exec('git', ['rev-parse', '--verify', 'master'], { cwd: projectPath, env });
              defaultBranch = 'master';
            } catch {
              // Keep 'main' as default
            }
          }
        }
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue;
          const parts = line.split('\t');
          const name = parts[0]?.trim() ?? '';
          if (!name) continue;
          branches.push({
            name,
            shortHash: parts[1]?.trim() ?? '',
            upstream: parts[2]?.trim() ?? '',
            isCurrent: parts[3]?.trim() === '*',
            isDefault: name === defaultBranch,
            lastActivity: parts[4]?.trim() ?? '',
          });
        }
        return { branches, defaultBranch };
      } catch (err) {
        return { branches: [], defaultBranch: 'main', error: (err as Error).message };
      }
    });

    // Git checkout — switch branches
    ipcMain.handle('git:checkout', async (_event, projectPath: string, branchName: string) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { getResolvedProcessEnv } = await import('./utils/shell-env.js');
      const exec = promisify(execFile);
      try {
        await exec('git', ['checkout', branchName], { cwd: projectPath, env: getResolvedProcessEnv() });
        return { success: true };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    });

    // Git create branch — create and switch to new branch
    ipcMain.handle('git:create-branch', async (_event, projectPath: string, branchName: string) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { getResolvedProcessEnv } = await import('./utils/shell-env.js');
      const exec = promisify(execFile);
      try {
        await exec('git', ['checkout', '-b', branchName], { cwd: projectPath, env: getResolvedProcessEnv() });
        return { success: true, branch: branchName };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    });

    // Git stage — add files to staging area
    ipcMain.handle('git:stage', async (_event, projectPath: string, filePaths: string[]) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { getResolvedProcessEnv } = await import('./utils/shell-env.js');
      const exec = promisify(execFile);
      try {
        await exec('git', ['add', '--', ...filePaths], { cwd: projectPath, env: getResolvedProcessEnv() });
        return { success: true };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    });

    // Git unstage — remove files from staging area
    ipcMain.handle('git:unstage', async (_event, projectPath: string, filePaths: string[]) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { getResolvedProcessEnv } = await import('./utils/shell-env.js');
      const exec = promisify(execFile);
      try {
        await exec('git', ['reset', 'HEAD', '--', ...filePaths], { cwd: projectPath, env: getResolvedProcessEnv() });
        return { success: true };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    });

    // Git commit — commit staged changes
    ipcMain.handle('git:commit', async (_event, projectPath: string, summary: string, description?: string) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { getResolvedProcessEnv } = await import('./utils/shell-env.js');
      const exec = promisify(execFile);
      try {
        const args = ['commit', '-m', summary];
        if (description) args.push('-m', description);
        const { stdout } = await exec('git', args, { cwd: projectPath, env: getResolvedProcessEnv() });
        // Extract commit hash from output
        const hashMatch = stdout.match(/\[[\w/]+ ([a-f0-9]+)\]/);
        return { success: true, hash: hashMatch?.[1] ?? '' };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    });

    // Git log — commit history
    ipcMain.handle('git:log', async (_event, projectPath: string, limit?: number) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { getResolvedProcessEnv } = await import('./utils/shell-env.js');
      const exec = promisify(execFile);
      try {
        const n = limit ?? 50;
        const { stdout } = await exec('git', ['log', `--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%s%x00%D`, `-${n}`], { cwd: projectPath, env: getResolvedProcessEnv(), maxBuffer: 2 * 1024 * 1024 });
        const commits: Array<{ hash: string; shortHash: string; author: string; email: string; timestamp: number; message: string; refs: string }> = [];
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue;
          const parts = line.split('\0');
          if (parts.length < 6) continue;
          commits.push({
            hash: parts[0],
            shortHash: parts[1],
            author: parts[2],
            email: parts[3],
            timestamp: parseInt(parts[4], 10),
            message: parts[5],
            refs: parts[6] ?? '',
          });
        }
        return { commits };
      } catch (err) {
        return { commits: [], error: (err as Error).message };
      }
    });

    // Git show — files changed in a commit + optional diff for a specific file
    ipcMain.handle('git:show', async (_event, projectPath: string, commitHash: string, filePath?: string) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { getResolvedProcessEnv } = await import('./utils/shell-env.js');
      const exec = promisify(execFile);
      const env = getResolvedProcessEnv();
      try {
        if (filePath) {
          // Return diff for a specific file in the commit
          const { stdout } = await exec('git', ['diff', `${commitHash}^..${commitHash}`, '--', filePath], { cwd: projectPath, env, maxBuffer: 5 * 1024 * 1024 });
          return { diff: stdout };
        }
        // Return list of changed files
        const { stdout } = await exec('git', ['diff-tree', '--no-commit-id', '-r', '--name-status', commitHash], { cwd: projectPath, env, maxBuffer: 1024 * 1024 });
        const files: Array<{ path: string; status: string }> = [];
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue;
          const parts = line.split('\t');
          if (parts.length >= 2) {
            files.push({ status: parts[0], path: parts[1] });
          }
        }
        return { files };
      } catch (err) {
        return { files: [], diff: '', error: (err as Error).message };
      }
    });

    // Git fetch
    ipcMain.handle('git:fetch', async (_event, projectPath: string) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { getResolvedProcessEnv } = await import('./utils/shell-env.js');
      const exec = promisify(execFile);
      try {
        await exec('git', ['fetch', '--all'], { cwd: projectPath, env: getResolvedProcessEnv(), timeout: 30000 });
        return { success: true };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    });

    // Git pull
    ipcMain.handle('git:pull', async (_event, projectPath: string) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { getResolvedProcessEnv } = await import('./utils/shell-env.js');
      const exec = promisify(execFile);
      try {
        const { stdout } = await exec('git', ['pull'], { cwd: projectPath, env: getResolvedProcessEnv(), timeout: 60000 });
        return { success: true, summary: stdout.trim() };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    });

    // Git push
    ipcMain.handle('git:push', async (_event, projectPath: string) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { getResolvedProcessEnv } = await import('./utils/shell-env.js');
      const exec = promisify(execFile);
      const env = getResolvedProcessEnv();
      try {
        await exec('git', ['push'], { cwd: projectPath, env, timeout: 60000 });
        return { success: true };
      } catch (err) {
        const errorMsg = (err as Error).message;
        // If push fails because no upstream, try setting upstream
        if (errorMsg.includes('no upstream') || errorMsg.includes('--set-upstream')) {
          try {
            const { stdout: branch } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectPath, env });
            await exec('git', ['push', '--set-upstream', 'origin', branch.trim()], { cwd: projectPath, env, timeout: 60000 });
            return { success: true };
          } catch (retryErr) {
            return { success: false, error: (retryErr as Error).message };
          }
        }
        return { success: false, error: errorMsg };
      }
    });

    // Git remote status — ahead/behind count
    ipcMain.handle('git:remote-status', async (_event, projectPath: string) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { getResolvedProcessEnv } = await import('./utils/shell-env.js');
      const exec = promisify(execFile);
      const env = getResolvedProcessEnv();
      try {
        let behind = 0;
        let ahead = 0;
        try {
          const { stdout: behindOut } = await exec('git', ['rev-list', '--count', 'HEAD..@{u}'], { cwd: projectPath, env });
          behind = parseInt(behindOut.trim(), 10) || 0;
        } catch { /* no upstream */ }
        try {
          const { stdout: aheadOut } = await exec('git', ['rev-list', '--count', '@{u}..HEAD'], { cwd: projectPath, env });
          ahead = parseInt(aheadOut.trim(), 10) || 0;
        } catch { /* no upstream */ }
        return { ahead, behind };
      } catch (err) {
        return { ahead: 0, behind: 0, error: (err as Error).message };
      }
    });

    // Git staged status — enhanced status with staging info
    ipcMain.handle('git:staged-status', async (_event, projectPath: string) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { getResolvedProcessEnv } = await import('./utils/shell-env.js');
      const exec = promisify(execFile);
      try {
        const { stdout } = await exec('git', ['status', '--porcelain', '-uall'], { cwd: projectPath, env: getResolvedProcessEnv(), maxBuffer: 1024 * 1024 });
        const files: Array<{ path: string; indexStatus: string; worktreeStatus: string; staged: boolean }> = [];
        for (const line of stdout.split('\n')) {
          if (!line || line.length < 3) continue;
          const indexStatus = line[0];
          const worktreeStatus = line[1];
          const filePath = line.slice(3).trim().replace(/^"(.*)"$/, '$1');
          // Filter out worktree directories
          if (filePath.startsWith('.worktrees/') || filePath.startsWith('.worktrees\\')) continue;
          const staged = indexStatus !== ' ' && indexStatus !== '?';
          files.push({ path: filePath, indexStatus, worktreeStatus, staged });
        }
        return { files };
      } catch (err) {
        return { files: [], error: (err as Error).message };
      }
    });

    // Open project in VS Code
    ipcMain.handle('git:open-in-editor', async (_event, projectPath: string) => {
      const { execFile } = await import('node:child_process');
      const { getResolvedProcessEnv } = await import('./utils/shell-env.js');
      try {
        execFile('code', [projectPath], { env: getResolvedProcessEnv() });
        return { success: true };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    });

    // Show project in Finder
    ipcMain.handle('git:show-in-finder', async (_event, projectPath: string) => {
      const { shell } = await import('electron');
      shell.showItemInFolder(projectPath);
      return { success: true };
    });

    // Get GitHub remote URL for the repo
    ipcMain.handle('git:remote-url', async (_event, projectPath: string) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { getResolvedProcessEnv } = await import('./utils/shell-env.js');
      const exec = promisify(execFile);
      try {
        const { stdout } = await exec('git', ['remote', 'get-url', 'origin'], { cwd: projectPath, env: getResolvedProcessEnv() });
        let url = stdout.trim();
        // Convert SSH URL to HTTPS
        if (url.startsWith('git@')) {
          url = url.replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '');
        } else if (url.endsWith('.git')) {
          url = url.replace(/\.git$/, '');
        }
        return { url };
      } catch (err) {
        return { url: '', error: (err as Error).message };
      }
    });

    // Open URL in default browser
    ipcMain.handle('git:open-url', async (_event, url: string) => {
      const { shell } = await import('electron');
      shell.openExternal(url);
      return { success: true };
    });

    // Git diff between two branches (for task review)
    ipcMain.handle('git:diff-branch', async (_event, projectPath: string, baseBranch: string, taskBranch: string) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { getResolvedProcessEnv } = await import('./utils/shell-env.js');
      const exec = promisify(execFile);
      try {
        const { stdout } = await exec('git', ['diff', `${baseBranch}...${taskBranch}`], { cwd: projectPath, env: getResolvedProcessEnv(), maxBuffer: 5 * 1024 * 1024 });
        return { diff: stdout };
      } catch (err) {
        return { diff: '', error: (err as Error).message };
      }
    });

    // Git diff between branches — files only (for file list in review)
    ipcMain.handle('git:diff-branch-stat', async (_event, projectPath: string, baseBranch: string, taskBranch: string) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { getResolvedProcessEnv } = await import('./utils/shell-env.js');
      const exec = promisify(execFile);
      try {
        const { stdout } = await exec('git', ['diff', '--name-status', `${baseBranch}...${taskBranch}`], { cwd: projectPath, env: getResolvedProcessEnv(), maxBuffer: 1024 * 1024 });
        const files: Array<{ status: string; path: string }> = [];
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue;
          const parts = line.split('\t');
          if (parts.length >= 2) files.push({ status: parts[0], path: parts[1] });
        }
        return { files };
      } catch (err) {
        return { files: [], error: (err as Error).message };
      }
    });

    // Git diff between branches — single file
    ipcMain.handle('git:diff-branch-file', async (_event, projectPath: string, baseBranch: string, taskBranch: string, filePath: string) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { getResolvedProcessEnv } = await import('./utils/shell-env.js');
      const exec = promisify(execFile);
      try {
        const { stdout } = await exec('git', ['diff', `${baseBranch}...${taskBranch}`, '--', filePath], { cwd: projectPath, env: getResolvedProcessEnv(), maxBuffer: 5 * 1024 * 1024 });
        return { diff: stdout };
      } catch (err) {
        return { diff: '', error: (err as Error).message };
      }
    });

    // Git merge branch
    ipcMain.handle('git:merge-branch', async (_event, projectPath: string, branchName: string) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { getResolvedProcessEnv } = await import('./utils/shell-env.js');
      const exec = promisify(execFile);
      try {
        const { stdout } = await exec('git', ['merge', branchName, '--no-edit'], { cwd: projectPath, env: getResolvedProcessEnv() });
        return { success: true, summary: stdout.trim() };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    });

    // Git delete branch
    ipcMain.handle('git:delete-branch', async (_event, projectPath: string, branchName: string) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { getResolvedProcessEnv } = await import('./utils/shell-env.js');
      const exec = promisify(execFile);
      try {
        await exec('git', ['branch', '-D', branchName], { cwd: projectPath, env: getResolvedProcessEnv() });
        return { success: true };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
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

    // Fetch image bytes from main process (bypasses CORS)
    ipcMain.handle('image:fetch', async (_event, url: string) => {
      try {
        const resp = await net.fetch(url, {
          headers: withBrandUserAgent(),
        });
        if (!resp.ok) return { error: `HTTP ${resp.status}` };
        const buffer = Buffer.from(await resp.arrayBuffer());
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
        const resp = await net.fetch(url, {
          headers: withBrandUserAgent(),
        });
        if (!resp.ok) return { error: `HTTP ${resp.status}` };
        const buffer = Buffer.from(await resp.arrayBuffer());
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

      // Security: ensure the resolved path is under the media directory
      if (!filePath.startsWith(mediaDir)) {
        return new Response('Forbidden', { status: 403 });
      }

      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        return new Response('Not Found', { status: 404 });
      }

      const data = readFileSync(filePath);
      const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
      const mimeTypes: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
        mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
        mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', opus: 'audio/opus', ogg: 'audio/ogg',
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      return new Response(data, {
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

      const pluginName = decodeURIComponent(parsed.hostname);
      const pathSegments = parsed.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
      const [fileHash, ...assetParts] = pathSegments;
      const assetPath = assetParts.join('/');

      if (!pluginName || !fileHash || !assetPath) {
        return new Response('Bad Request', { status: 400 });
      }

      const resolved = pluginManagerRef.resolveRendererAssetRequest(pluginName, fileHash, assetPath);
      if (!resolved) {
        return new Response('Not Found', { status: 404 });
      }

      const data = readFileSync(resolved.filePath);
      return new Response(data, {
        headers: {
          'Content-Type': resolved.contentType,
          'Cache-Control': 'no-cache',
        },
      });
    });

    const mainWindow = createWindow();

    // Show the window immediately but fully transparent while plugin approval
    // dialogs are pending. This keeps the window "shown" (so native dialogs
    // have a valid app context on macOS) without flashing a partially-rendered UI.
    mainWindow.once('ready-to-show', async () => {
      mainWindow.setOpacity(0);
      mainWindow.show();

      try {
        await pluginManager.loadAll();
        console.info(`[${__BRAND_PRODUCT_NAME}] ${pluginManager.getPluginCount()} plugins loaded`);
      } catch (err) {
        console.error(`[${__BRAND_PRODUCT_NAME}] Plugin loading failed:`, err);
      }

      mainWindow.setOpacity(1);
    });

    // Initialize tools asynchronously
    shellPathReady.then(() => buildToolRegistry(getConfig, APP_HOME)).then((tools) => {
      const pluginTools = pluginManager.getAllPluginTools();
      const allTools = [...tools, ...pluginTools];
      registerTools(allTools);
      console.info(`[${__BRAND_PRODUCT_NAME}] ${tools.length} tools + ${pluginTools.length} plugin tools registered`);

      // Register realtime handlers (needs tool registry)
      registerRealtimeHandlers(ipcMain, getConfig, getRegisteredTools, APP_HOME);

      // Start web UI server if enabled
      const webServerConfig = getConfig().webServer;
      if (webServerConfig?.enabled) {
        startWebServer(webServerConfig)
          .then(() => console.info(`[${__BRAND_PRODUCT_NAME}] Web UI server started on ${webServerConfig.tls?.enabled ? 'https' : 'http'}://localhost:${webServerConfig.port}`))
          .catch((err) => console.error(`[${__BRAND_PRODUCT_NAME}] Web server failed to start:`, err));
      }
    }).catch((err) => {
      console.error(`[${__BRAND_PRODUCT_NAME}] Failed to build tool registry:`, err);
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // Stop web UI server
  stopWebServer().catch(() => {});
  // Cleanup PTY sessions
  destroyAllPtys();
  // Best-effort plugin cleanup (don't block quit on failures)
  pluginManagerRef?.unloadAll().catch((err) => {
    console.error(`[${__BRAND_PRODUCT_NAME}] Plugin cleanup error:`, err);
  });
  cleanupMicRecorder();
  closeAllOverlayWindows();
});
