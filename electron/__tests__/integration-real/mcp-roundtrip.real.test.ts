/**
 * Real-API smoke: MCP server + client roundtrip wired into a real model.
 *
 * Skipped unless `RUN_REAL_API_TESTS=1`.
 *
 * What this proves: an in-process MCP server can advertise a tool, a real
 * model call wired to that tool can pick it, the MCP client transports the
 * request through to the server, and the result flows back into the model's
 * final answer.
 *
 * Why in-process: the MCP SDK exposes `InMemoryTransport.createLinkedPair()`
 * specifically for this scenario. Using a real socket transport would add
 * port-binding flakiness to nightly runs that already pay for real provider
 * traffic — the linked pair gives us identical protocol coverage at zero
 * network cost.
 */

import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { generateText, stepCountIs, tool } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

import { CostMeter, countAnthropicInputTokens } from './cost-meter.js';

const TEST_ID = 'real.mcp-roundtrip.anthropic.haiku';
const MODEL = 'claude-3-5-haiku-latest';
const MAX_OUTPUT_TOKENS = 200;
const RUN = process.env.RUN_REAL_API_TESTS === '1';

describe.skipIf(!RUN)('real-API: MCP roundtrip (Anthropic)', () => {
  let meter: CostMeter;
  let workDir: string;
  let mcpClient: Client | null = null;
  let mcpServer: McpServer | null = null;
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';

  beforeAll(() => {
    if (!apiKey) {
      throw new Error('RUN_REAL_API_TESTS=1 but ANTHROPIC_API_KEY is unset.');
    }
    workDir = process.env.COST_LEDGER_DIR ?? mkdtempSync(join(tmpdir(), 'real-api-ledger-'));
    meter = new CostMeter({
      ledgerPath: join(workDir, 'cost-ledger.jsonl'),
    });
  });

  afterAll(async () => {
    // Close in opposite order of creation. Tolerate either side already shut.
    try {
      await mcpClient?.close();
    } catch {
      // Already torn down.
    }
    try {
      await mcpServer?.close();
    } catch {
      // Already torn down.
    }
    if (!process.env.COST_LEDGER_DIR && workDir) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    try {
      meter.endTest({
        provider: 'anthropic',
        model: MODEL,
        status: 'error',
        note: 'afterEach catchall',
      });
    } catch {
      // No active test row.
    }
  });

  it('routes a model tool call through an in-memory MCP transport pair', async () => {
    meter.beginTest(TEST_ID);

    // ── Stand up the in-process MCP server ────────────────────────────────
    mcpServer = new McpServer({ name: 'real-api-test', version: '1.0.0' });
    let serverInvocations = 0;
    mcpServer.registerTool(
      'echo',
      {
        description: 'Echo back the input string, prefixed with EC:.',
        inputSchema: { text: z.string() },
      },
      async ({ text }) => {
        serverInvocations += 1;
        return {
          content: [{ type: 'text' as const, text: `EC: ${text}` }],
        };
      },
    );

    // ── Wire client/server with a linked in-memory transport pair ─────────
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    mcpClient = new Client({ name: 'real-api-client', version: '1.0.0' });
    await Promise.all([mcpServer.connect(serverTransport), mcpClient.connect(clientTransport)]);

    // Verify the MCP handshake exposed our tool — protocol-level evidence
    // separate from the model call below.
    const listed = await mcpClient.listTools();
    expect(listed.tools.map((t) => t.name)).toContain('echo');

    // ── Wrap the MCP tool as an AI SDK tool so the model can invoke it ─────
    const echoBridge = tool({
      description: 'Echo back the input string, prefixed with EC:.',
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => {
        const result = await mcpClient!.callTool({
          name: 'echo',
          arguments: { text },
        });
        return result;
      },
    });

    const messages = [
      {
        role: 'user' as const,
        content: 'Call the echo tool with text="ping" and then state the tool result verbatim in your reply.',
      },
    ];
    const inputTokens = await countAnthropicInputTokens({
      apiKey,
      model: MODEL,
      messages,
    });
    const decision = meter.gate('anthropic', MODEL, inputTokens * 3, MAX_OUTPUT_TOKENS);
    expect(decision.allowed, decision.reason).toBe(true);

    const anthropic = createAnthropic({ apiKey });
    const result = await generateText({
      model: anthropic(MODEL),
      messages,
      tools: { echo: echoBridge },
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      stopWhen: stepCountIs(4),
    });

    expect(serverInvocations).toBeGreaterThanOrEqual(1);
    expect(result.text).toMatch(/EC: ping/);

    meter.record('anthropic', MODEL, result.totalUsage);
    meter.endTest({
      provider: 'anthropic',
      model: MODEL,
      status: 'ok',
      usage: result.totalUsage,
    });
  });
});
