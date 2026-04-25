import { app, shell, BrowserWindow, safeStorage, session } from 'electron';
import { getBrandUserAgent } from '../utils/user-agent.js';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http';
import { URL } from 'url';
import { z } from 'zod';
import { generateForPlugin } from '../agent/plugin-generate.js';
import { getRegisteredTools } from '../ipc/agent.js';
import type {
  PluginAPI,
  PluginInstance,
  PluginBannerDescriptor,
  PluginModalDescriptor,
  PluginBrowserWindowOptions,
  PluginSettingsSectionDescriptor,
  PluginPanelDescriptor,
  PluginNavigationItemDescriptor,
  PluginCommandDescriptor,
  PluginConversationDecorationDescriptor,
  PluginThreadDecorationDescriptor,
  PluginNotificationDescriptor,
  PluginAuthWindowOptions,
  PluginAuthResult,
  PluginConversationAppendMessage,
  PluginConversationRecord,
  PluginHttpRequest,
  PluginHttpResponse,
  PreSendHook,
  PostReceiveHook,
  PluginNavigationTarget,
  MessageContent,
} from './types.js';
import type { AppConfig } from '../config/schema.js';
import type { ToolDefinition } from '../tools/types.js';
import { buildScopedToolName, getScopedToolPrefix } from '../tools/naming.js';
import { convertJsonSchemaToZod } from '../tools/skill-loader.js';
import { readConversationStore, writeConversationStore, broadcastConversationChange } from '../ipc/conversations.js';

type PluginAPICallbacks = {
  appHome: string;
  getConfig: () => AppConfig;
  setConfig: (path: string, value: unknown) => void;
  getPluginConfig: () => Record<string, unknown>;
  setPluginConfig: (path: string, value: unknown) => void;
  getPluginState: () => Record<string, unknown>;
  replacePluginState: (next: Record<string, unknown>) => void;
  setPluginState: (path: string, value: unknown) => void;
  emitPluginEvent: (eventName: string, data?: unknown) => void;
  showNotification: (descriptor: Omit<PluginNotificationDescriptor, 'pluginName' | 'visible'>) => void;
  dismissNotification: (id: string) => void;
  openNavigationTarget: (target: PluginNavigationTarget) => void;
  onUIStateChanged: () => void;
  onToolsChanged: () => void;
  registerActionHandler: (targetId: string, handler: (action: string, data?: unknown) => void | Promise<void>) => void;
};

function isZodSchema(schema: unknown): schema is z.ZodTypeAny {
  return Boolean(
    schema
    && typeof schema === 'object'
    && typeof (schema as { safeParse?: unknown }).safeParse === 'function',
  );
}

function normalizePluginTool(tool: ToolDefinition): ToolDefinition {
  const rawSchema = tool.inputSchema as unknown;
  const inputSchema = isZodSchema(rawSchema)
    ? rawSchema
    : rawSchema && typeof rawSchema === 'object'
      ? convertJsonSchemaToZod(rawSchema as Record<string, unknown>)
      : z.object({}).passthrough();

  return {
    ...tool,
    inputSchema,
  };
}

function resolvePluginToolOriginalName(pluginName: string, tool: ToolDefinition): string {
  if (tool.source === 'plugin' && tool.sourceId === pluginName && tool.originalName) {
    return tool.originalName;
  }

  const legacyPrefix = `plugin:${pluginName}:`;
  if (tool.name.startsWith(legacyPrefix)) {
    return tool.name.slice(legacyPrefix.length);
  }

  const safePrefix = getScopedToolPrefix('plugin', pluginName);
  if (tool.name.startsWith(safePrefix)) {
    return tool.name.slice(safePrefix.length);
  }

  return tool.originalName ?? tool.name;
}

function normalizePluginObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

type StoredConversationMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: MessageContent[] | string;
  parentId: string | null;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

function normalizeConversationRole(role: PluginConversationAppendMessage['role']): StoredConversationMessage['role'] {
  return role;
}

function getConversationBranch(
  tree: StoredConversationMessage[],
  headId: string | null,
): StoredConversationMessage[] {
  if (!headId) return [];

  const byId = new Map(tree.map((message) => [message.id, message] as const));
  const branch: StoredConversationMessage[] = [];
  let currentId: string | null = headId;

  while (currentId) {
    const current = byId.get(currentId);
    if (!current) break;
    branch.push(current);
    currentId = current.parentId;
  }

  return branch.reverse();
}

function ensureConversationTree(
  conversation: PluginConversationRecord,
): { tree: StoredConversationMessage[]; headId: string | null } {
  const rawTree = Array.isArray(conversation.messageTree)
    ? conversation.messageTree as StoredConversationMessage[]
    : null;

  if (rawTree && rawTree.length > 0) {
    return {
      tree: rawTree,
      headId: conversation.headId ?? rawTree[rawTree.length - 1]?.id ?? null,
    };
  }

  let parentId: string | null = null;
  const tree = (Array.isArray(conversation.messages) ? conversation.messages : []).map((message, index) => {
    const typed = normalizePluginObject(message) as StoredConversationMessage;
    const id = typeof typed.id === 'string' && typed.id
      ? typed.id
      : `plugin-msg-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`;
    const normalized: StoredConversationMessage = {
      id,
      role: normalizeConversationRole(
        typed.role === 'user' || typed.role === 'assistant' || typed.role === 'system' || typed.role === 'tool'
          ? typed.role
          : 'assistant',
      ),
      content: (typed.content as MessageContent[] | string | undefined) ?? '',
      parentId,
      createdAt: typeof typed.createdAt === 'string' ? typed.createdAt : new Date().toISOString(),
      metadata: typed.metadata && typeof typed.metadata === 'object'
        ? typed.metadata
        : undefined,
    };
    parentId = normalized.id;
    return normalized;
  });

  return {
    tree,
    headId: tree[tree.length - 1]?.id ?? null,
  };
}

function normalizeConversationRecord(
  conversation: PluginConversationRecord,
): PluginConversationRecord {
  const { tree, headId } = ensureConversationTree(conversation);
  const branch = getConversationBranch(tree, headId);

  return {
    ...conversation,
    messages: branch,
    messageTree: tree,
    headId,
    messageCount: branch.length,
    userMessageCount: branch.filter((message) => message.role === 'user').length,
  };
}

function listPermission(instance: PluginInstance): string {
  return instance.manifest.permissions.join(', ') || 'none';
}

export function createPluginAPI(
  instance: PluginInstance,
  callbacks: PluginAPICallbacks,
): PluginAPI {
  const { manifest } = instance;
  let httpServer: Server | null = null;

  const requirePermission = (permission: string): void => {
    if (!manifest.permissions.includes(permission as typeof manifest.permissions[number])) {
      throw new Error(`Plugin "${manifest.name}" requires permission "${permission}" for this action. Declared: ${listPermission(instance)}`);
    }
  };

  const registerOrReplace = <T extends { id: string }>(items: T[], descriptor: T): void => {
    const index = items.findIndex((item) => item.id === descriptor.id);
    if (index >= 0) {
      items[index] = descriptor;
    } else {
      items.push(descriptor);
    }
    callbacks.onUIStateChanged();
  };

  const api: PluginAPI = {
    pluginName: manifest.name,
    pluginDir: instance.dir,

    config: {
      get: () => {
        requirePermission('config:read');
        return callbacks.getConfig();
      },

      set: (path: string, value: unknown) => {
        requirePermission('config:write');
        callbacks.setConfig(path, value);
      },

      getPluginData: () => {
        requirePermission('config:read');
        return callbacks.getPluginConfig();
      },

      setPluginData: (path: string, value: unknown) => {
        requirePermission('config:write');
        callbacks.setPluginConfig(path, value);
      },

      onChanged: (callback: (config: AppConfig) => void) => {
        requirePermission('config:read');
        instance.configChangeListeners.push(callback);
        return () => {
          const idx = instance.configChangeListeners.indexOf(callback);
          if (idx >= 0) instance.configChangeListeners.splice(idx, 1);
        };
      },
    },

    state: {
      get: () => callbacks.getPluginState(),
      replace: (next: Record<string, unknown>) => {
        requirePermission('state:publish');
        callbacks.replacePluginState(normalizePluginObject(next));
      },
      set: (path: string, value: unknown) => {
        requirePermission('state:publish');
        callbacks.setPluginState(path, value);
      },
      emitEvent: (eventName: string, data?: unknown) => {
        requirePermission('state:publish');
        callbacks.emitPluginEvent(eventName, data);
      },
    },

    tools: {
      register: (tools: ToolDefinition[]) => {
        requirePermission('tools:register');
        const prefixed = tools.map((tool) => normalizePluginTool(tool)).map((tool) => {
          const originalName = resolvePluginToolOriginalName(manifest.name, tool);

          return {
            ...tool,
            name: buildScopedToolName('plugin', manifest.name, originalName),
            source: 'plugin' as const,
            sourceId: manifest.name,
            originalName,
            aliases: Array.from(new Set([
              ...(tool.aliases ?? []),
              tool.name,
              `plugin:${manifest.name}:${originalName}`,
            ])),
          };
        });
        const newNames = new Set(prefixed.map((tool) => tool.name));
        instance.registeredTools = instance.registeredTools.filter((tool) => !newNames.has(tool.name));
        instance.registeredTools.push(...prefixed);
        callbacks.onToolsChanged();
      },

      unregister: (toolNames: string[]) => {
        requirePermission('tools:register');
        const fullNames = new Set(
          toolNames.flatMap((name) => {
            const originalName = name.startsWith(`plugin:${manifest.name}:`)
              ? name.slice(`plugin:${manifest.name}:`.length)
              : name;

            return [
              name,
              `plugin:${manifest.name}:${originalName}`,
              buildScopedToolName('plugin', manifest.name, originalName),
            ];
          }),
        );
        instance.registeredTools = instance.registeredTools.filter(
          (tool) => !fullNames.has(tool.name) && !(tool.aliases?.some((alias) => fullNames.has(alias))),
        );
        callbacks.onToolsChanged();
      },
    },

    messages: {
      registerPreSendHook: (hook: PreSendHook) => {
        requirePermission('messages:hook');
        instance.preSendHooks.push(hook);
      },

      registerPostReceiveHook: (hook: PostReceiveHook) => {
        requirePermission('messages:hook');
        instance.postReceiveHooks.push(hook);
      },
    },

    ui: {
      showBanner: (descriptor: Omit<PluginBannerDescriptor, 'pluginName'>) => {
        requirePermission('ui:banner');
        registerOrReplace(instance.uiBanners, { ...descriptor, pluginName: manifest.name });
      },

      hideBanner: (id: string) => {
        requirePermission('ui:banner');
        const idx = instance.uiBanners.findIndex((banner) => banner.id === id);
        if (idx >= 0) {
          instance.uiBanners[idx] = { ...instance.uiBanners[idx], visible: false };
          callbacks.onUIStateChanged();
        }
      },

      showModal: (descriptor: Omit<PluginModalDescriptor, 'pluginName'>) => {
        requirePermission('ui:modal');
        registerOrReplace(instance.uiModals, { ...descriptor, pluginName: manifest.name });
      },

      hideModal: (id: string) => {
        requirePermission('ui:modal');
        const idx = instance.uiModals.findIndex((modal) => modal.id === id);
        if (idx >= 0) {
          instance.uiModals[idx] = { ...instance.uiModals[idx], visible: false };
          callbacks.onUIStateChanged();
        }
      },

      updateModal: (id: string, updates: Partial<Omit<PluginModalDescriptor, 'id' | 'pluginName'>>) => {
        requirePermission('ui:modal');
        const idx = instance.uiModals.findIndex((modal) => modal.id === id);
        if (idx >= 0) {
          instance.uiModals[idx] = { ...instance.uiModals[idx], ...updates };
          callbacks.onUIStateChanged();
        }
      },

      registerSettingsView: (descriptor: Omit<PluginSettingsSectionDescriptor, 'pluginName' | 'component'>) => {
        requirePermission('ui:settings');
        registerOrReplace(instance.uiSettingsSections, { ...descriptor, component: 'SettingsView', pluginName: manifest.name });
      },

      registerPanelView: (descriptor: Omit<PluginPanelDescriptor, 'pluginName' | 'component'>) => {
        requirePermission('ui:panel');
        registerOrReplace(instance.uiPanels, { ...descriptor, component: 'PanelView', pluginName: manifest.name });
      },

      registerNavigationItem: (descriptor: Omit<PluginNavigationItemDescriptor, 'pluginName'>) => {
        requirePermission('ui:navigation');
        registerOrReplace(instance.uiNavigationItems, { ...descriptor, pluginName: manifest.name });
      },

      registerCommand: (descriptor: Omit<PluginCommandDescriptor, 'pluginName'>) => {
        requirePermission('ui:navigation');
        registerOrReplace(instance.uiCommands, { ...descriptor, pluginName: manifest.name });
      },

      showConversationDecoration: (descriptor: Omit<PluginConversationDecorationDescriptor, 'pluginName'>) => {
        requirePermission('ui:navigation');
        registerOrReplace(instance.conversationDecorations, { ...descriptor, pluginName: manifest.name });
      },

      hideConversationDecoration: (id: string) => {
        requirePermission('ui:navigation');
        const idx = instance.conversationDecorations.findIndex((decoration) => decoration.id === id);
        if (idx >= 0) {
          instance.conversationDecorations[idx] = { ...instance.conversationDecorations[idx], visible: false };
          callbacks.onUIStateChanged();
        }
      },

      showThreadDecoration: (descriptor: Omit<PluginThreadDecorationDescriptor, 'pluginName'>) => {
        requirePermission('ui:navigation');
        registerOrReplace(instance.threadDecorations, { ...descriptor, pluginName: manifest.name });
      },

      hideThreadDecoration: (id: string) => {
        requirePermission('ui:navigation');
        const idx = instance.threadDecorations.findIndex((decoration) => decoration.id === id);
        if (idx >= 0) {
          instance.threadDecorations[idx] = { ...instance.threadDecorations[idx], visible: false };
          callbacks.onUIStateChanged();
        }
      },
    },

    notifications: {
      show: (descriptor) => {
        requirePermission('notifications:send');
        callbacks.showNotification(descriptor);
      },
      dismiss: (id: string) => {
        requirePermission('notifications:send');
        callbacks.dismissNotification(id);
      },
    },

    navigation: {
      open: (target) => {
        requirePermission('navigation:open');
        callbacks.openNavigationTarget(target);
      },
    },

    conversations: {
      list: () => {
        requirePermission('conversations:read');
        return [];
      },
      get: (_conversationId: string) => null,
      upsert: (_conversation: PluginConversationRecord) => {},
      setActive: (_conversationId: string) => {},
      getActiveId: () => null,
      appendMessage: (_conversationId: string, _message: PluginConversationAppendMessage) => null,
      markUnread: (_conversationId: string, _unread: boolean) => {},
    },

    log: {
      info: (...args: unknown[]) => console.info(`[Plugin:${manifest.name}]`, ...args),
      warn: (...args: unknown[]) => console.warn(`[Plugin:${manifest.name}]`, ...args),
      error: (...args: unknown[]) => console.error(`[Plugin:${manifest.name}]`, ...args),
    },

    shell: {
      openExternal: (url: string) => {
        requirePermission('navigation:open');
        return shell.openExternal(url);
      },
    },

    auth: {
      openAuthWindow: (options: PluginAuthWindowOptions): Promise<PluginAuthResult> => {
        requirePermission('auth:window');
        const {
          url,
          callbackMatch,
          title = 'Sign In',
          width = 620,
          height = 720,
          timeoutMs = 300_000,
          showOnCreate = true,
          showAfterMs,
          successMessage,
          extractParams,
          interceptUrls,
          interceptHeader,
          partition,
          onReady,
          customUserAgent,
        } = options;

        return new Promise((resolve) => {
          let settled = false;
          let wasShown = showOnCreate;
          let revealTimer: NodeJS.Timeout | null = null;

          const ses = partition ? session.fromPartition(partition) : undefined;

          const authWin = new BrowserWindow({
            width,
            height,
            show: showOnCreate,
            title,
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
              ...(ses ? { session: ses } : {}),
            },
          });
          if (customUserAgent !== false) {
            authWin.webContents.setUserAgent(
              typeof customUserAgent === 'string' ? customUserAgent : getBrandUserAgent(),
            );
          }

          const clearRevealTimer = () => {
            if (revealTimer) {
              clearTimeout(revealTimer);
              revealTimer = null;
            }
          };

          const revealWindow = () => {
            if (settled || authWin.isDestroyed() || authWin.isVisible()) return;
            wasShown = true;
            authWin.show();
            authWin.focus();
          };

          const settle = (result: PluginAuthResult, closeWindow = true) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            clearRevealTimer();
            if (closeWindow) {
              setTimeout(() => {
                try { if (!authWin.isDestroyed()) authWin.close(); } catch { /* ignore */ }
              }, 500);
            }
            resolve(result);
          };

          if (!showOnCreate && typeof showAfterMs === 'number' && showAfterMs >= 0) {
            revealTimer = setTimeout(revealWindow, showAfterMs);
          }

          const timeout = setTimeout(() => {
            settle({ success: false, error: 'Authentication timed out' });
          }, timeoutMs);

          // Mode 1: Header interception (for APIs that don't use redirects)
          if (interceptUrls && interceptUrls.length > 0 && interceptHeader) {
            const targetSession = ses ?? authWin.webContents.session;
            const urlPatterns = interceptUrls;
            targetSession.webRequest.onBeforeSendHeaders(
              { urls: urlPatterns },
              (details, callback) => {
                const headerValue =
                  details.requestHeaders[interceptHeader] ??
                  details.requestHeaders[interceptHeader.toLowerCase()] ??
                  details.requestHeaders[interceptHeader.charAt(0).toUpperCase() + interceptHeader.slice(1)];
                if (headerValue && !settled) {
                  settle(
                    { success: true, params: { [interceptHeader]: headerValue } },
                    true,
                  );
                }
                callback({ requestHeaders: details.requestHeaders });
              },
            );
          }

          // Mode 2: Redirect matching (original behavior)
          if (callbackMatch) {
            const handleRedirect = (_event: Electron.Event, redirectUrl: string) => {
              if (settled || !redirectUrl.includes(callbackMatch)) return;

              try {
                const parsed = new URL(redirectUrl);
                const params: Record<string, string> = {};
                parsed.searchParams.forEach((value, key) => {
                  if (!extractParams || extractParams.includes(key)) {
                    params[key] = value;
                  }
                });

                clearRevealTimer();
                settled = true;
                clearTimeout(timeout);

                if (!wasShown) {
                  try { authWin.close(); } catch { /* ignore */ }
                  resolve({ success: true, params });
                  return;
                }

                const successHtml = successMessage || `
                  <html>
                  <body style="font-family: system-ui; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #1a1a2e; color: #e0e0e0;">
                    <div style="text-align: center;">
                      <h2 style="color: #4ade80;">&#10003; Authentication Successful</h2>
                      <p>You can close this window and return to the application.</p>
                    </div>
                  </body>
                  </html>
                `;
                authWin.loadURL(`data:text/html,${encodeURIComponent(successHtml)}`);
                setTimeout(() => {
                  try { authWin.close(); } catch { /* ignore */ }
                }, 2000);

                resolve({ success: true, params });
              } catch (err) {
                settle({ success: false, error: err instanceof Error ? err.message : String(err) });
              }
            };

            authWin.webContents.on('will-redirect', handleRedirect);
            authWin.webContents.on('will-navigate', handleRedirect);
          }

          // Provide helpers to the caller for auto-login / webContents interaction
          if (onReady) {
            const helpers = {
              executeJavaScript: (code: string) => authWin.webContents.executeJavaScript(code),
              getURL: () => authWin.webContents.getURL(),
              onDidNavigate: (cb: (url: string) => void) => {
                authWin.webContents.on('did-navigate', (_event: Electron.Event, navUrl: string) => cb(navUrl));
                authWin.webContents.on('will-redirect', (_event: Electron.Event, navUrl: string) => cb(navUrl));
                authWin.webContents.on('will-navigate', (_event: Electron.Event, navUrl: string) => cb(navUrl));
              },
              show: () => revealWindow(),
              hide: () => { if (!authWin.isDestroyed()) authWin.hide(); },
              close: () => settle({ success: false, error: 'Closed by plugin' }),
            };
            onReady(helpers);
          }

          authWin.loadURL(url).catch((err) => {
            settle({ success: false, error: `Failed to load auth URL: ${err.message}` });
          });

          authWin.once('close', () => {
            if (!settled) {
              settle({ success: false, error: 'Auth window closed by user' }, false);
            }
          });
        });
      },
    },

    safeStorage: {
      isEncryptionAvailable: () => {
        requirePermission('safe-storage');
        // Avoid calling safeStorage.isEncryptionAvailable() eagerly — on
        // macOS (especially MDM-managed machines) even the availability check
        // can trigger a Keychain access prompt at startup.  Encryption is
        // always available on macOS and Windows once the app is ready, so we
        // only need to probe on other platforms.
        if (process.platform === 'darwin' || process.platform === 'win32') {
          return app.isReady();
        }
        return safeStorage.isEncryptionAvailable();
      },
      encryptString: (plaintext: string) => {
        requirePermission('safe-storage');
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error('OS encryption is not available');
        }
        return safeStorage.encryptString(plaintext).toString('base64');
      },
      decryptString: (base64Cipher: string) => {
        requirePermission('safe-storage');
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error('OS encryption is not available');
        }
        return safeStorage.decryptString(Buffer.from(base64Cipher, 'base64'));
      },
    },

    browser: {
      open: (options: PluginBrowserWindowOptions) => {
        requirePermission('browser:window');
        const {
          url,
          title = 'Browser',
          width = 1280,
          height = 900,
          partition,
          customUserAgent,
        } = options;

        const ses = partition ? session.fromPartition(partition) : undefined;

        const browserWin = new BrowserWindow({
          width,
          height,
          title,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webviewTag: true,
            ...(ses ? { session: ses } : {}),
          },
        });
        if (customUserAgent !== false) {
          browserWin.webContents.setUserAgent(
            typeof customUserAgent === 'string' ? customUserAgent : getBrandUserAgent(),
          );
        }

        const partitionAttr = partition ? ` partition="${partition}"` : '';
        const jsUrl = JSON.stringify(url);
        const escapedTitle = title.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

        const chromeHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapedTitle}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; overflow: hidden; background: #1a1a2e; color: #e0e0e0; font-family: system-ui, -apple-system, sans-serif; }
  #chrome { display: flex; flex-direction: column; height: 100%; }
  #toolbar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; background: #16162a; border-bottom: 1px solid #2a2a4a; flex-shrink: 0; -webkit-app-region: drag; }
  #toolbar > * { -webkit-app-region: no-drag; }
  .nav-btn { width: 28px; height: 28px; border: none; background: transparent; color: #888; border-radius: 6px; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center; }
  .nav-btn:hover { background: #2a2a4a; color: #ccc; }
  .nav-btn:disabled { opacity: 0.3; cursor: default; }
  .nav-btn:disabled:hover { background: transparent; color: #888; }
  #url-bar { flex: 1; height: 28px; padding: 0 10px; border: 1px solid #2a2a4a; border-radius: 6px; background: #0f0f1e; color: #ccc; font-size: 12px; outline: none; }
  #url-bar:focus { border-color: #5b5bd6; }
  #tabs { display: flex; align-items: center; gap: 2px; padding: 4px 8px 0; background: #16162a; flex-shrink: 0; overflow-x: auto; }
  .tab { display: flex; align-items: center; gap: 6px; padding: 5px 12px; background: #1a1a2e; border: 1px solid #2a2a4a; border-bottom: none; border-radius: 8px 8px 0 0; cursor: pointer; font-size: 11px; color: #888; max-width: 200px; min-width: 60px; flex-shrink: 0; }
  .tab.active { background: #1e1e38; color: #e0e0e0; border-color: #3a3a5a; }
  .tab-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tab-close { width: 16px; height: 16px; border: none; background: transparent; color: #666; cursor: pointer; border-radius: 4px; font-size: 12px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .tab-close:hover { background: #3a3a5a; color: #ccc; }
  .new-tab-btn { width: 24px; height: 24px; border: none; background: transparent; color: #666; cursor: pointer; border-radius: 6px; font-size: 16px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .new-tab-btn:hover { background: #2a2a4a; color: #ccc; }
  #webview-container { flex: 1; position: relative; }
  webview { position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: none; }
  webview.hidden { display: none; }
</style>
</head>
<body>
<div id="chrome">
  <div id="tabs">
    <button class="new-tab-btn" id="new-tab-btn" title="New Tab">+</button>
  </div>
  <div id="toolbar">
    <button class="nav-btn" id="back-btn" title="Back" disabled>&#9664;</button>
    <button class="nav-btn" id="fwd-btn" title="Forward" disabled>&#9654;</button>
    <button class="nav-btn" id="reload-btn" title="Reload">&#8635;</button>
    <input type="text" id="url-bar" spellcheck="false">
  </div>
  <div id="webview-container"></div>
</div>
<script>
  const container = document.getElementById('webview-container');
  const tabsBar = document.getElementById('tabs');
  const newTabBtn = document.getElementById('new-tab-btn');
  const urlBar = document.getElementById('url-bar');
  const backBtn = document.getElementById('back-btn');
  const fwdBtn = document.getElementById('fwd-btn');
  const reloadBtn = document.getElementById('reload-btn');

  let tabs = [];
  let activeTabId = null;
  let tabIdCounter = 0;

  function createTab(url) {
    const id = ++tabIdCounter;
    const wv = document.createElement('webview');
    wv.setAttribute('src', url);
    wv.setAttribute('class', 'hidden');
    wv.setAttribute('allowpopups', '');
    ${partitionAttr ? `wv.setAttribute('partition', '${partition}');` : ''}
    wv.id = 'wv-' + id;
    container.appendChild(wv);

    const tab = { id, wv, title: 'Loading...' };
    tabs.push(tab);

    wv.addEventListener('page-title-updated', (e) => {
      tab.title = e.title || url;
      renderTabs();
    });
    wv.addEventListener('did-navigate', () => updateNavState());
    wv.addEventListener('did-navigate-in-page', () => updateNavState());

    // Handle new windows (target=_blank, window.open, cmd+click)
    // Open them as new tabs in our browser instead of new Electron windows
    wv.addEventListener('did-attach', () => {
      try {
        const wc = wv.getWebContents();
        if (wc) {
          wc.setWindowOpenHandler(({ url: newUrl }) => {
            if (newUrl && newUrl !== 'about:blank') {
              createTab(newUrl);
            }
            return { action: 'deny' };
          });
        }
      } catch (e) {
        console.warn('Could not set window open handler:', e);
      }
    });

    // Fallback for older Electron: listen for new-window on the webview element
    wv.addEventListener('new-window', (e) => {
      e.preventDefault();
      if (e.url && e.url !== 'about:blank') {
        createTab(e.url);
      }
    });

    switchTab(id);
    renderTabs();
    return id;
  }

  function switchTab(id) {
    activeTabId = id;
    tabs.forEach(t => {
      t.wv.classList.toggle('hidden', t.id !== id);
    });
    renderTabs();
    updateNavState();
  }

  function closeTab(id) {
    const idx = tabs.findIndex(t => t.id === id);
    if (idx < 0) return;
    const tab = tabs[idx];
    tab.wv.remove();
    tabs.splice(idx, 1);
    if (tabs.length === 0) {
      window.close();
      return;
    }
    if (activeTabId === id) {
      const next = tabs[Math.min(idx, tabs.length - 1)];
      switchTab(next.id);
    }
    renderTabs();
  }

  function renderTabs() {
    tabsBar.querySelectorAll('.tab').forEach(el => el.remove());
    tabs.forEach(t => {
      const el = document.createElement('div');
      el.className = 'tab' + (t.id === activeTabId ? ' active' : '');
      el.innerHTML = '<span class="tab-title"></span><button class="tab-close">&times;</button>';
      el.querySelector('.tab-title').textContent = t.title;
      el.addEventListener('click', (e) => {
        if (!e.target.classList.contains('tab-close')) switchTab(t.id);
      });
      el.querySelector('.tab-close').addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(t.id);
      });
      tabsBar.insertBefore(el, newTabBtn);
    });
  }

  function updateNavState() {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab) return;
    try {
      urlBar.value = tab.wv.getURL();
      backBtn.disabled = !tab.wv.canGoBack();
      fwdBtn.disabled = !tab.wv.canGoForward();
    } catch {}
  }

  backBtn.addEventListener('click', () => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab && tab.wv.canGoBack()) tab.wv.goBack();
  });
  fwdBtn.addEventListener('click', () => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab && tab.wv.canGoForward()) tab.wv.goForward();
  });
  reloadBtn.addEventListener('click', () => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab) tab.wv.reload();
  });
  urlBar.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      let val = urlBar.value.trim();
      if (val && !val.match(/^https?:\\/\\//)) val = 'https://' + val;
      const tab = tabs.find(t => t.id === activeTabId);
      if (tab && val) tab.wv.loadURL(val);
    }
  });
  newTabBtn.addEventListener('click', () => {
    createTab(${jsUrl});
  });

  createTab(${jsUrl});
</script>
</body>
</html>`;

        browserWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(chromeHtml)}`);

        // Intercept new windows from webview guest contents and redirect
        // them back to the chrome page to open as new tabs
        browserWin.webContents.on('did-attach-webview', (_event, webContents) => {
          webContents.setWindowOpenHandler(({ url: newUrl }) => {
            if (newUrl && newUrl !== 'about:blank') {
              // Send the URL to the chrome page to open as a new tab
              browserWin.webContents.executeJavaScript(
                `typeof createTab === 'function' && createTab(${JSON.stringify(newUrl)})`
              ).catch(() => {});
            }
            return { action: 'deny' };
          });
        });
      },
    },

    session: {
      clearCookies: async (partition: string, filter?: { domain?: string }): Promise<number> => {
        requirePermission('auth:window');
        const ses = session.fromPartition(partition);
        const allCookies = await ses.cookies.get({});

        let targetCookies = allCookies;
        if (filter?.domain) {
          const domains = Array.isArray(filter.domain) ? filter.domain : [filter.domain];
          targetCookies = allCookies.filter((cookie) => {
            const d = cookie.domain?.toLowerCase() ?? '';
            return domains.some((pattern) => d.includes(pattern.toLowerCase()));
          });
        }

        for (const cookie of targetCookies) {
          const protocol = cookie.secure ? 'https' : 'http';
          const domain = cookie.domain?.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
          const cookieUrl = `${protocol}://${domain}${cookie.path}`;
          await ses.cookies.remove(cookieUrl, cookie.name);
        }

        return targetCookies.length;
      },
    },

    http: {
      listen: (port, handler, options) => {
        requirePermission('http:listen');
        return new Promise<void>((resolve, reject) => {
          if (httpServer) {
            reject(new Error('HTTP server already running for this plugin'));
            return;
          }

          httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            try {
              const parsedUrl = new URL(req.url ?? '/', `http://localhost:${port}`);
              const query: Record<string, string> = {};
              parsedUrl.searchParams.forEach((value, key) => {
                query[key] = value;
              });

              const headers: Record<string, string> = {};
              for (const [key, value] of Object.entries(req.headers)) {
                if (typeof value === 'string') headers[key] = value;
              }

              let body = '';
              if (req.method !== 'GET' && req.method !== 'HEAD') {
                body = await new Promise<string>((resolveBody) => {
                  const chunks: Buffer[] = [];
                  req.on('data', (chunk: Buffer) => chunks.push(chunk));
                  req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf-8')));
                });
              }

              const pluginReq: PluginHttpRequest = {
                method: req.method ?? 'GET',
                url: parsedUrl.pathname,
                headers,
                query,
                body: body || undefined,
              };

              const pluginRes: PluginHttpResponse = await handler(pluginReq);

              res.writeHead(pluginRes.status ?? 200, {
                'Content-Type': 'text/html',
                ...pluginRes.headers,
              });
              res.end(pluginRes.body ?? '');
            } catch (err) {
              console.error(`[Plugin:${manifest.name}] HTTP handler error:`, err);
              res.writeHead(500);
              res.end('Internal plugin error');
            }
          });

          const host = options?.host ?? '127.0.0.1';
          httpServer.listen(port, host, () => {
            console.info(`[Plugin:${manifest.name}] HTTP server listening on ${host}:${port}`);
            resolve();
          });

          httpServer.on('error', reject);
        });
      },

      close: () => {
        requirePermission('http:listen');
        return new Promise<void>((resolve) => {
          if (!httpServer) {
            resolve();
            return;
          }
          httpServer.close(() => {
            httpServer = null;
            resolve();
          });
        });
      },
    },

    agent: {
      generate: async (options) => {
        requirePermission('agent:generate');
        const config = callbacks.getConfig();
        const allTools = options.tools ? getRegisteredTools() : [];
        return generateForPlugin({
          messages: options.messages,
          config,
          appHome: callbacks.appHome,
          modelKey: options.modelKey,
          profileKey: options.profileKey,
          reasoningEffort: options.reasoningEffort,
          fallbackEnabled: options.fallbackEnabled,
          systemPrompt: options.systemPrompt,
          tools: allTools,
          abortSignal: options.abortSignal,
        });
      },
    },

    onAction: (targetId: string, handler: (action: string, data?: unknown) => void | Promise<void>) => {
      callbacks.registerActionHandler(targetId, handler);
    },

    fetch: ((...args: Parameters<typeof globalThis.fetch>) => {
      requirePermission('network:fetch');
      return globalThis.fetch(...args);
    }) as typeof globalThis.fetch,
  };

  api.conversations.list = () => {
    requirePermission('conversations:read');
    const store = readConversationStore(callbacks.appHome);
    return Object.values(store.conversations) as PluginConversationRecord[];
  };

  api.conversations.get = (conversationId: string) => {
    requirePermission('conversations:read');
    const store = readConversationStore(callbacks.appHome);
    return (store.conversations[conversationId] as PluginConversationRecord | undefined) ?? null;
  };

  api.conversations.upsert = (conversation: PluginConversationRecord) => {
    requirePermission('conversations:write');
    const store = readConversationStore(callbacks.appHome);
    const normalizedConversation = normalizeConversationRecord(conversation);
    store.conversations[conversation.id] = normalizedConversation as unknown as typeof store.conversations[string];
    writeConversationStore(callbacks.appHome, store);
    broadcastConversationChange(store);
  };

  api.conversations.getActiveId = () => {
    requirePermission('conversations:read');
    return readConversationStore(callbacks.appHome).activeConversationId;
  };

  api.conversations.setActive = (conversationId: string) => {
    requirePermission('conversations:write');
    const store = readConversationStore(callbacks.appHome);
    store.activeConversationId = conversationId;
    writeConversationStore(callbacks.appHome, store);
    broadcastConversationChange(store);
    callbacks.openNavigationTarget({ type: 'conversation', conversationId });
  };

  api.conversations.appendMessage = (conversationId: string, message: PluginConversationAppendMessage) => {
    requirePermission('conversations:write');
    const conversation = api.conversations.get(conversationId);
    if (!conversation) return null;

    const next = normalizePluginObject(conversation) as PluginConversationRecord;
    const { tree, headId } = ensureConversationTree(next);
    const messageId = `plugin-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const normalizedContent = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content;
    const createdAt = message.createdAt ?? new Date().toISOString();
    const normalizedRole = normalizeConversationRole(message.role);

    const storedMessage: StoredConversationMessage = {
      id: messageId,
      role: normalizedRole,
      content: normalizedContent,
      parentId: message.parentId ?? headId,
      createdAt,
      metadata: message.metadata ? { ...message.metadata } : undefined,
    };

    const nextTree = [...tree, storedMessage];
    const nextHeadId = storedMessage.id;
    const nextBranch = getConversationBranch(nextTree, nextHeadId);

    next.messages = nextBranch;
    next.messageTree = nextTree;
    next.headId = nextHeadId;
    next.updatedAt = createdAt;
    next.lastMessageAt = createdAt;
    next.lastAssistantUpdateAt = normalizedRole === 'user' ? next.lastAssistantUpdateAt : createdAt;
    next.messageCount = nextBranch.length;
    next.userMessageCount = nextBranch.filter((entry) => entry.role === 'user').length;
    next.hasUnread = normalizedRole === 'user' ? next.hasUnread : true;
    api.conversations.upsert(next);
    return next;
  };

  api.conversations.markUnread = (conversationId: string, unread: boolean) => {
    requirePermission('conversations:write');
    const conversation = api.conversations.get(conversationId);
    if (!conversation) return;
    api.conversations.upsert({
      ...conversation,
      hasUnread: unread,
      updatedAt: new Date().toISOString(),
    });
  };

  return api;
}

/** Cleanup HTTP server when plugin is deactivated */
export async function cleanupPluginAPI(api: PluginAPI): Promise<void> {
  try {
    await api.http.close();
  } catch {
    // Ignore cleanup errors
  }
}
