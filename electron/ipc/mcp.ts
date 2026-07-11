import type { IpcMain } from 'electron';
import { connectMcpServer, disconnectMcpServer } from '../tools/mcp-client.js';

interface McpServerInput {
  name: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Validate the shape of an inline MCP server config from the renderer.
 *
 * Per the project's trust model, the web-bridge / renderer is a fully
 * trusted surface (an authenticated client may configure and test any
 * MCP server, same as the desktop UI). We therefore accept inline server
 * objects rather than forcing a save-then-lookup flow — but we strictly
 * type-check every field so a malformed payload cannot smuggle unexpected
 * values into StdioClientTransport.
 */
function validateServerInput(raw: unknown): McpServerInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.name !== 'string' || !s.name) return null;
  const out: McpServerInput = { name: s.name };
  if (s.url !== undefined) {
    if (typeof s.url !== 'string') return null;
    out.url = s.url;
  }
  if (s.command !== undefined) {
    if (typeof s.command !== 'string') return null;
    out.command = s.command;
  }
  if (s.args !== undefined) {
    if (!Array.isArray(s.args) || !s.args.every((a) => typeof a === 'string')) return null;
    out.args = s.args as string[];
  }
  if (s.env !== undefined) {
    if (!s.env || typeof s.env !== 'object' || Array.isArray(s.env)) return null;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.env)) {
      if (typeof k !== 'string' || typeof v !== 'string') return null;
      env[k] = v;
    }
    out.env = env;
  }
  return out;
}

export function registerMcpHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('mcp:test-connection', async (_event, raw: unknown) => {
    const server = validateServerInput(raw);
    if (!server) {
      return { status: 'error' as const, toolCount: 0, error: 'Invalid server payload' };
    }
    // Use a temporary name so we don't pollute the real connection pool
    const testName = `__test__${server.name}__${Date.now()}`;
    // Bound the whole test: connectMcpServer's connect() handshake has no
    // timeout, so a hung stdio/url server would otherwise pin this handler (and
    // keep the spawned test process alive) forever. Race a deadline; the finally
    // block always disconnects, killing any spawned process.
    const CONNECT_TEST_TIMEOUT_MS = 30_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      const conn = await Promise.race([
        connectMcpServer({ ...server, name: testName }),
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
    }
  });
}
