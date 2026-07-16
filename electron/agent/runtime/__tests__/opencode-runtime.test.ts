import { describe, it, expect } from 'vitest';
import { translateOpencodeEvent, buildOpencodeMcpConfig, buildOpencodeMcpPrompt } from '../opencode-runtime.js';
import type { ToolDefinition } from '../../../tools/types.js';

/**
 * translateOpencodeEvent maps opencode's `--format json` stream events to Kai
 * StreamEvents. The end-to-end stream (spawn + real turn) is exercised manually
 * (opencode runs on its default provider); here we lock the pure translation.
 */
const CID = 'conv-1';

describe('translateOpencodeEvent', () => {
  it('maps a text part to a text-delta', () => {
    const out = translateOpencodeEvent(CID, { type: 'text', part: { type: 'text', text: 'PONG' } });
    expect(out).toEqual([{ conversationId: CID, type: 'text-delta', text: 'PONG' }]);
  });

  it('ignores an empty text part', () => {
    expect(translateOpencodeEvent(CID, { type: 'text', part: { type: 'text', text: '' } })).toEqual([]);
  });

  it('maps a completed tool_use to tool-call + tool-result', () => {
    const out = translateOpencodeEvent(CID, {
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'bash',
        callID: 'call_abc',
        state: { status: 'completed', input: { command: 'echo hi' }, output: 'hi\n' },
      },
    });
    expect(out).toEqual([
      {
        conversationId: CID,
        type: 'tool-call',
        toolCallId: 'call_abc',
        toolName: 'bash',
        args: { command: 'echo hi' },
      },
      { conversationId: CID, type: 'tool-result', toolCallId: 'call_abc', toolName: 'bash', result: 'hi\n' },
    ]);
  });

  it('maps an errored tool_use to an error-shaped tool-result', () => {
    const out = translateOpencodeEvent(CID, {
      type: 'tool_use',
      part: { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'error', output: 'boom' } },
    });
    expect(out[0]!.type).toBe('tool-call');
    expect(out[1]!.type).toBe('tool-result');
    expect((out[1]!.result as { isError?: boolean }).isError).toBe(true);
  });

  it('maps step_finish tokens to a context-usage event', () => {
    const out = translateOpencodeEvent(CID, {
      type: 'step_finish',
      part: { type: 'step-finish', tokens: { input: 33, output: 5, cache: { read: 100, write: 0 } } },
    });
    expect(out).toEqual([
      {
        conversationId: CID,
        type: 'context-usage',
        data: { inputTokens: 33, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0 },
      },
    ]);
  });

  it('maps an error event to a Kai error', () => {
    const out = translateOpencodeEvent(CID, { type: 'error', part: { error: 'rate limited' } } as never);
    expect(out[0]!.type).toBe('error');
    expect(out[0]!.error).toContain('rate limited');
  });

  it('emits nothing for step_start and unknown event types', () => {
    expect(translateOpencodeEvent(CID, { type: 'step_start', part: { type: 'step-start' } })).toEqual([]);
    expect(translateOpencodeEvent(CID, { type: 'whatever' })).toEqual([]);
  });
});

describe('buildOpencodeMcpConfig', () => {
  it('emits a remote MCP server block with bearer header', () => {
    const cfg = buildOpencodeMcpConfig('http://127.0.0.1:5000/mcp', 'tok-123') as {
      mcp: { kai: { type: string; url: string; enabled: boolean; headers?: Record<string, string> } };
    };
    expect(cfg.mcp.kai.type).toBe('remote');
    expect(cfg.mcp.kai.url).toBe('http://127.0.0.1:5000/mcp');
    expect(cfg.mcp.kai.enabled).toBe(true);
    expect(cfg.mcp.kai.headers).toEqual({ Authorization: 'Bearer tok-123' });
  });

  it('omits the headers block when there is no token', () => {
    const cfg = buildOpencodeMcpConfig('http://127.0.0.1:5000/mcp', null) as {
      mcp: { kai: { headers?: unknown } };
    };
    expect(cfg.mcp.kai.headers).toBeUndefined();
  });
});

describe('buildOpencodeMcpPrompt', () => {
  const mkTool = (name: string, description: string): ToolDefinition =>
    ({ name, description, inputSchema: {}, execute: async () => ({}) }) as unknown as ToolDefinition;

  it('returns the prompt unchanged when there are no tools', () => {
    expect(buildOpencodeMcpPrompt('do the thing', [])).toBe('do the thing');
  });

  it('lists tools under the kai_ MCP prefix and keeps the user request', () => {
    const out = buildOpencodeMcpPrompt('what is the weather', [mkTool('get_weather', 'Get weather')]);
    expect(out).toContain('kai_get_weather: Get weather');
    expect(out).toContain('User request:');
    expect(out).toContain('what is the weather');
  });
});
