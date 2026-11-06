import { safeStorage, shell, type IpcMain } from 'electron';
import { z } from 'zod';
import { mcpServerSchema, type McpStatus } from '../../shared/mcp.js';
import { connectMcpServer, disconnectMcpServer, getMcpStatus, setMcpOAuthService } from '../tools/mcp-client.js';
import { McpOAuthService, mcpCredentialKey } from '../mcp/oauth-service.js';
import { McpCredentialStore } from '../mcp/credential-store.js';
import { McpLoginWindows } from '../mcp/login-window.js';
import { broadcastToAllWindows } from '../utils/window-send.js';
import type { AppConfig } from '../config/schema.js';

export function registerMcpHandlers(
  ipcMain: IpcMain,
  appHome: string,
  getConfig: () => AppConfig,
  reconnect: (name: string) => Promise<void>,
): McpOAuthService {
  const status = (): McpStatus[] => {
    const connected = new Map(getMcpStatus().map((entry) => [entry.name, entry]));
    return getConfig().mcpServers.map((cfg) => {
      const connection = connected.get(cfg.name);
      return {
        ...service.status(cfg.name),
        enabled: cfg.enabled !== false,
        status: (connection?.status ?? 'disconnected') as McpStatus['status'],
        toolCount: connection?.toolCount ?? 0,
        error: connection?.error,
      };
    });
  };
  const notify = () => broadcastToAllWindows('mcp:status-changed', status());
  let loginWindows: McpLoginWindows;
  const service = new McpOAuthService(new McpCredentialStore(appHome, safeStorage), {
    onChanged: notify,
    onAuthorized: reconnect,
    onLoginEnded: (loginId) => loginWindows.close(loginId),
  });
  loginWindows = new McpLoginWindows(service);
  service.configure(getConfig().mcpServers);
  setMcpOAuthService(service, notify);
  const name = z.string().min(1).max(256);
  ipcMain.handle('mcp:status', () => status());
  ipcMain.handle('mcp:login', (_event, value: unknown) => service.login(name.parse(value)));
  ipcMain.handle('mcp:open-login', (_event, value: unknown, browser: unknown) => {
    const id = z
      .string()
      .regex(/^[a-f0-9]{48}$/)
      .parse(value);
    const target = z.enum(['in-app', 'system']).default('system').parse(browser);
    const url = service.authorizationUrl(id);
    if (target === 'in-app') return loginWindows.open(id);
    return shell.openExternal(url).then(() => loginWindows.close(id));
  });
  ipcMain.handle('mcp:complete-login', (_event, id: unknown, url: unknown) =>
    service.completeLogin(
      z
        .string()
        .regex(/^[a-f0-9]{48}$/)
        .parse(id),
      z.string().max(16384).parse(url),
    ),
  );
  ipcMain.handle('mcp:cancel-login', (_event, value: unknown) => service.cancelLogin(name.parse(value)));
  ipcMain.handle('mcp:reconnect', async (_event, value: unknown) => {
    const serverName = name.parse(value);
    if (!getConfig().mcpServers.some((cfg) => cfg.name === serverName && cfg.enabled !== false))
      throw new Error('Save and enable this MCP server first.');
    await reconnect(serverName);
    notify();
  });
  ipcMain.handle('mcp:logout', async (_event, value: unknown) => {
    const serverName = name.parse(value);
    const result = await service.logout(serverName);
    await disconnectMcpServer(serverName);
    return result;
  });
  ipcMain.handle('mcp:set-client-secret', async (_event, value: unknown, secret: unknown) => {
    const serverName = name.parse(value);
    service.setClientSecret(serverName, z.string().min(1).max(16384).nullable().parse(secret));
    await disconnectMcpServer(serverName);
  });
  ipcMain.handle('mcp:test-connection', async (_event, raw: unknown) => {
    const parsed = mcpServerSchema.safeParse(raw);
    const server = parsed.success ? parsed.data : null;
    if (!server) {
      return { status: 'error' as const, toolCount: 0, error: 'Invalid server payload' };
    }
    // Use a temporary name so we don't pollute the real connection pool
    const testName = `__test__${server.name}__${crypto.randomUUID()}`;
    // Bound the whole test: connectMcpServer's connect() handshake has no
    // timeout, so a hung stdio/url server would otherwise pin this handler (and
    // keep the spawned test process alive) forever. Race a deadline; the finally
    // block always disconnects, killing any spawned process.
    const CONNECT_TEST_TIMEOUT_MS = 30_000;
    let timer: NodeJS.Timeout | undefined;
    // Keep a handle to the connect promise so a TIMED-OUT test can still tear down the connection
    // once it eventually settles (R169): Promise.race does NOT cancel connectMcpServer, so on a
    // timeout the connect keeps running and later does connections.set(testName, …) — AFTER the
    // finally's disconnect already ran — leaking a live __test__ connection (rebuilds skip __test__
    // names, so it survives until exit). Disconnect again after the connect settles to reap it.
    const connectPromise = connectMcpServer({ ...server, name: testName }, server);
    let settledBeforeCleanup = false;
    try {
      const conn = await Promise.race([
        connectPromise.then((c) => {
          settledBeforeCleanup = true;
          return c;
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Connection test timed out after ${CONNECT_TEST_TIMEOUT_MS / 1000}s`)),
            CONNECT_TEST_TIMEOUT_MS,
          );
          timer.unref?.();
        }),
      ]);
      return {
        status: conn.status,
        toolCount: conn.tools.length,
        error: conn.error,
        auth: getConfig().mcpServers.some((cfg) => mcpCredentialKey(cfg) === mcpCredentialKey(server))
          ? service.status(server.name)
          : undefined,
      };
    } catch (error) {
      return {
        status: 'error' as const,
        toolCount: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (timer) clearTimeout(timer);
      // Cleanup must not throw (e.g. disconnecting a never-fully-connected test
      // server) and mask the real result / crash the handler.
      try {
        await disconnectMcpServer(testName);
      } catch {
        /* best-effort cleanup */
      }
      // If the connect had NOT settled by the time we cleaned up (a timeout), it may still be running
      // and will insert a live connection when it completes — disconnect once more after it settles.
      if (!settledBeforeCleanup) {
        void connectPromise
          .catch(() => undefined)
          .finally(() => {
            void disconnectMcpServer(testName).catch(() => undefined);
          });
      }
    }
  });
  return service;
}
