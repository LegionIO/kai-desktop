/**
 * Pi Tool Bridge — exposes Kai's custom tools (skills / plugins / MCP / builtin)
 * to the `pi` CLI, which has NO MCP client but DOES support first-class
 * TypeScript extensions that register LLM-callable tools.
 *
 * pi doesn't speak MCP, so instead of a StreamableHTTP MCP server (as the Codex
 * bridge uses) this exposes a tiny loopback JSON HTTP API:
 *   GET  /tools               → [{ name, description, inputSchema (JSON Schema) }]
 *   POST /call {name,args}     → { content:[…], isError? }
 * and GENERATES a pi extension module that, on load, fetches /tools and calls
 * `pi.registerTool(...)` for each — proxying each tool's `execute` to POST /call.
 *
 * Security: binds to 127.0.0.1 on a random port with a per-bridge bearer token
 * (passed to the pi child only, via a unique env var) so no other local process
 * can drive Kai's tools through this port. Mirrors CodexMcpBridge's posture.
 *
 * Lifecycle:
 *   1. start(tools, conversationId, cwd) → { url, token, tokenEnvVar, extensionPath }
 *   2. pi is spawned with `-e <extensionPath>` + the token env var; the extension
 *      registers the tools and calls back during the turn.
 *   3. stop() → shut down the server + delete the generated extension file.
 */

import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ToolDefinition } from '../../tools/types.js';
import { ToolMcpBridge } from './tool-mcp-bridge.js';

/** Cap the inbound POST /call body — a tool-call args payload is small JSON. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export type PiToolBridgeHandle = {
  /** Base URL the extension calls (http://127.0.0.1:<port>). */
  url: string;
  /** Bearer token the extension must present. */
  token: string;
  /** Unique env-var name carrying the token (given only to the pi child). */
  tokenEnvVar: string;
  /** Unique env-var name carrying the base URL (given only to the pi child). */
  urlEnvVar: string;
  /** Absolute path of the generated pi extension module (pass via `-e`). */
  extensionPath: string;
};

export class PiToolBridge {
  private httpServer: HttpServer | null = null;
  private bridge: ToolMcpBridge | null = null;
  private port = 0;
  private tmpDir: string | null = null;
  private abortSignal?: AbortSignal;

  /**
   * Start the loopback server + write the pi extension file. Returns null if
   * there are no bridgeable tools (caller then spawns pi without `-e`).
   */
  async start(
    tools: ToolDefinition[],
    conversationId: string,
    cwd?: string,
    abortSignal?: AbortSignal,
  ): Promise<PiToolBridgeHandle | null> {
    if (!tools || tools.length === 0) return null;
    this.abortSignal = abortSignal;
    this.bridge = new ToolMcpBridge({ tools, conversationId, cwd });

    const token = randomUUID();
    // Unique env-var names per bridge so concurrent pi runs don't race a shared key.
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();
    const tokenEnvVar = `KAI_PI_BRIDGE_TOKEN_${suffix}`;
    const urlEnvVar = `KAI_PI_BRIDGE_URL_${suffix}`;

    await new Promise<void>((resolve, reject) => {
      this.httpServer = createServer((req, res) => {
        void this.handleRequest(req, res, token).catch((err) => {
          if (!res.headersSent) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'internal error' }));
          }
          console.warn('[pi-tool-bridge] request error:', err instanceof Error ? err.message : err);
        });
      });
      this.httpServer.on('error', reject);
      this.httpServer.listen(0, '127.0.0.1', () => {
        const addr = this.httpServer!.address();
        if (addr && typeof addr === 'object') this.port = addr.port;
        resolve();
      });
    });

    const url = `http://127.0.0.1:${this.port}`;
    this.tmpDir = mkdtempSync(join(tmpdir(), 'kai-pi-ext-'));
    const extensionPath = join(this.tmpDir, 'kai-tools.ts');
    writeFileSync(extensionPath, buildPiExtensionSource(tokenEnvVar, urlEnvVar), 'utf8');

    console.info(`[pi-tool-bridge] started on ${url} with ${tools.length} tool(s); ext=${extensionPath}`);
    return { url, token, tokenEnvVar, urlEnvVar, extensionPath };
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
    // Auth: constant-ish string compare on the bearer token.
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/tools') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tools: this.bridge?.listTools() ?? [] }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/call') {
      const body = await readBody(req);
      let parsed: { name?: unknown; args?: unknown };
      try {
        parsed = JSON.parse(body) as { name?: unknown; args?: unknown };
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'invalid JSON body' }));
        return;
      }
      if (typeof parsed.name !== 'string') {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'missing tool name' }));
        return;
      }
      const result = await this.bridge!.callTool(parsed.name, parsed.args ?? {}, this.abortSignal);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  }

  /** Update the tool set (e.g. mid-session tool changes). */
  updateTools(tools: ToolDefinition[]): void {
    this.bridge?.updateTools(tools);
  }

  /** Shut down the server + remove the generated extension file. */
  async stop(): Promise<void> {
    try {
      if (this.httpServer) {
        await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
        this.httpServer = null;
      }
    } catch {
      /* best-effort */
    }
    this.bridge?.dispose();
    this.bridge = null;
    if (this.tmpDir) {
      try {
        rmSync(this.tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      this.tmpDir = null;
    }
  }
}

/** Read a bounded request body (rejects an oversized frame). */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      buf += chunk.toString('utf8');
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

/**
 * The generated pi extension. On load it fetches the tool list from the bridge
 * and registers each with `pi.registerTool`, proxying `execute` to POST /call.
 * The tool's JSON Schema (from Kai's Zod schema) IS a valid TypeBox/JSON-Schema
 * `parameters` value, so we pass it directly; the bridge re-validates server-side.
 * Reads the bridge URL + token from env (never on argv).
 */
function buildPiExtensionSource(tokenEnvVar: string, urlEnvVar: string): string {
  return `// AUTO-GENERATED by Kai's PiToolBridge — bridges Kai tools into pi. Do not edit.
export default async function (pi) {
  const base = process.env[${JSON.stringify(urlEnvVar)}];
  const token = process.env[${JSON.stringify(tokenEnvVar)}];
  if (!base || !token) return; // bridge not configured for this run

  const auth = { authorization: 'Bearer ' + token };
  let tools = [];
  try {
    const res = await fetch(base + '/tools', { headers: auth });
    if (res.ok) tools = (await res.json()).tools || [];
  } catch (e) {
    return; // bridge unreachable — pi still runs with its built-in tools
  }

  for (const t of tools) {
    pi.registerTool({
      name: t.name,
      label: t.name,
      description: t.description || '',
      // Kai's JSON Schema is a valid TypeBox/JSON-Schema parameters object.
      parameters: t.inputSchema && typeof t.inputSchema === 'object'
        ? t.inputSchema
        : { type: 'object', additionalProperties: true },
      async execute(_toolCallId, params, signal) {
        let out;
        try {
          const res = await fetch(base + '/call', {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({ name: t.name, args: params }),
            signal,
          });
          out = await res.json();
        } catch (e) {
          return { content: [{ type: 'text', text: 'Kai tool bridge error: ' + (e && e.message || e) }], details: {}, isError: true };
        }
        // Bridge returns { content:[{type,text|...}], isError? } — pass through to pi.
        return {
          content: Array.isArray(out.content) ? out.content : [{ type: 'text', text: String(out.content ?? '') }],
          details: {},
          ...(out.isError ? { isError: true } : {}),
        };
      },
    });
  }
}
`;
}
