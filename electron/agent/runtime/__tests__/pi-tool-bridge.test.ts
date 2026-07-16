import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { PiToolBridge } from '../pi-tool-bridge.js';
import type { ToolDefinition } from '../../../tools/types.js';
import { existsSync, readFileSync } from 'node:fs';

/**
 * PiToolBridge exposes Kai tools to pi via a loopback HTTP API + a generated
 * pi extension. pi has no MCP client, so this is the bridge mechanism. These
 * tests exercise the HTTP contract (list/call/auth) + the generated extension
 * file — the parts verifiable without a provider login (the model-driven tool
 * call itself needs pi authenticated).
 */
function fakeTool(over: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'kai_echo',
    description: 'Echo the given text.',
    source: 'builtin',
    inputSchema: z.object({ text: z.string() }),
    execute: async (input: unknown) => ({ value: `echoed: ${(input as { text: string }).text}` }),
    ...over,
  } as ToolDefinition;
}

let bridge: PiToolBridge | null = null;
afterEach(async () => {
  if (bridge) await bridge.stop();
  bridge = null;
});

describe('PiToolBridge', () => {
  it('returns null (no server) when there are no bridgeable tools', async () => {
    bridge = new PiToolBridge();
    expect(await bridge.start([], 'conv', process.cwd())).toBeNull();
  });

  it('GET /tools lists tools with a JSON Schema; POST /call executes them; auth is enforced', async () => {
    bridge = new PiToolBridge();
    const h = await bridge.start([fakeTool()], 'conv', process.cwd());
    expect(h).not.toBeNull();
    const { url, token } = h!;
    const auth = { authorization: `Bearer ${token}` };

    // Unauthorized is rejected.
    expect((await fetch(`${url}/tools`)).status).toBe(401);

    // list_tools with a real JSON Schema.
    const list = (await (await fetch(`${url}/tools`, { headers: auth })).json()) as {
      tools: Array<{ name: string; inputSchema: { type?: string; properties?: Record<string, unknown> } }>;
    };
    expect(list.tools).toHaveLength(1);
    expect(list.tools[0]!.name).toBe('kai_echo');
    expect(list.tools[0]!.inputSchema.type).toBe('object');
    expect(list.tools[0]!.inputSchema.properties).toHaveProperty('text');

    // call executes the actual Kai tool.
    const call = (await (
      await fetch(`${url}/call`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'kai_echo', args: { text: 'hi' } }),
      })
    ).json()) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    expect(call.isError).toBeFalsy();
    expect(call.content[0]!.text).toContain('echoed: hi');
  });

  it('POST /call surfaces an unknown tool as isError, and invalid args are rejected', async () => {
    bridge = new PiToolBridge();
    const h = await bridge.start([fakeTool()], 'conv', process.cwd());
    const auth = { authorization: `Bearer ${h!.token}`, 'content-type': 'application/json' };

    const unknown = (await (
      await fetch(`${h!.url}/call`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'nope', args: {} }) })
    ).json()) as { isError?: boolean };
    expect(unknown.isError).toBe(true);

    const badArgs = (await (
      await fetch(`${h!.url}/call`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ name: 'kai_echo', args: { text: 123 } }), // wrong type
      })
    ).json()) as { isError?: boolean };
    expect(badArgs.isError).toBe(true);
  });

  it('writes a generated pi extension file that reads the bridge URL/token from env', async () => {
    bridge = new PiToolBridge();
    const h = await bridge.start([fakeTool()], 'conv', process.cwd());
    expect(existsSync(h!.extensionPath)).toBe(true);
    const src = readFileSync(h!.extensionPath, 'utf8');
    expect(src).toContain('export default');
    expect(src).toContain('pi.registerTool');
    expect(src).toContain(h!.urlEnvVar); // reads URL from env, not hardcoded
    expect(src).toContain(h!.tokenEnvVar); // reads token from env, not hardcoded
  });

  it('stop() tears down the server (port no longer accepts connections) + removes the ext file', async () => {
    bridge = new PiToolBridge();
    const h = await bridge.start([fakeTool()], 'conv', process.cwd());
    const url = h!.url;
    const extPath = h!.extensionPath;
    await bridge.stop();
    bridge = null;
    expect(existsSync(extPath)).toBe(false);
    // The server should be down — a fetch rejects (connection refused).
    await expect(fetch(`${url}/tools`)).rejects.toBeTruthy();
  });
});
