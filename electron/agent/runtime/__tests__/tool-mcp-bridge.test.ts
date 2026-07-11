/**
 * Tests for the Tool → MCP Bridge.
 *
 * Covers: listTools (JSON Schema conversion), callTool (execution + error
 * handling), getTool, hasTool, updateTools, dispose.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolMcpBridge } from '../tool-mcp-bridge.js';
import type { ToolDefinition } from '../../../tools/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: overrides.name ?? 'test-tool',
    description: overrides.description ?? 'A test tool',
    inputSchema:
      overrides.inputSchema ??
      z.object({
        path: z.string().describe('The file path'),
        content: z.string().optional().describe('File content'),
      }),
    execute: overrides.execute ?? (async (input) => `Executed with: ${JSON.stringify(input)}`),
    ...overrides,
  };
}

function createBridge(tools: ToolDefinition[] = [createTool()]): ToolMcpBridge {
  return new ToolMcpBridge({
    tools,
    conversationId: 'test-conv',
    cwd: '/tmp/test',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ToolMcpBridge', () => {
  describe('listTools', () => {
    it('returns tools with real JSON Schema from Zod definitions', () => {
      const bridge = createBridge();
      const tools = bridge.listTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('test-tool');
      expect(tools[0].description).toBe('A test tool');

      const schema = tools[0].inputSchema;
      expect(schema.type).toBe('object');
      expect(schema.properties).toBeDefined();

      const props = schema.properties as Record<string, unknown>;
      expect(props.path).toBeDefined();
      expect((props.path as Record<string, unknown>).type).toBe('string');
    });

    it('handles tools with complex schemas', () => {
      const complexTool = createTool({
        name: 'complex-tool',
        inputSchema: z.object({
          command: z.string(),
          timeout: z.number().optional().default(5000),
          recursive: z.boolean().default(false),
          tags: z.array(z.string()).optional(),
        }),
      });

      const bridge = createBridge([complexTool]);
      const tools = bridge.listTools();

      expect(tools).toHaveLength(1);
      const schema = tools[0].inputSchema;
      expect(schema.type).toBe('object');

      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.command?.type).toBe('string');
      expect(props.timeout?.type).toBe('number');
      expect(props.recursive?.type).toBe('boolean');
      expect(props.tags?.type).toBe('array');
    });

    it('lists multiple tools', () => {
      const bridge = createBridge([
        createTool({ name: 'tool-a' }),
        createTool({ name: 'tool-b' }),
        createTool({ name: 'tool-c' }),
      ]);

      const tools = bridge.listTools();
      expect(tools).toHaveLength(3);
      expect(tools.map((t) => t.name)).toEqual(['tool-a', 'tool-b', 'tool-c']);
    });

    it('returns empty array when no tools registered', () => {
      const bridge = createBridge([]);
      expect(bridge.listTools()).toEqual([]);
    });
  });

  describe('callTool', () => {
    it('executes a tool and returns text result', async () => {
      const bridge = createBridge();
      const result = await bridge.callTool('test-tool', { path: '/tmp/file.txt' });

      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('/tmp/file.txt');
    });

    it('returns error for unknown tool', async () => {
      const bridge = createBridge();
      const result = await bridge.callTool('nonexistent', {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('nonexistent');
      expect(result.content[0].text).toContain('not found');
    });

    it('catches execution errors and returns them as MCP error', async () => {
      const failingTool = createTool({
        name: 'failing-tool',
        inputSchema: z.object({}),
        execute: async () => {
          throw new Error('Intentional test failure');
        },
      });

      const bridge = createBridge([failingTool]);
      const result = await bridge.callTool('failing-tool', {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Intentional test failure');
    });

    it('validates args before execution', async () => {
      let receivedArgs: unknown;
      const tool = createTool({
        inputSchema: z.object({ count: z.number() }),
        execute: async (input) => {
          receivedArgs = input;
          return 'ok';
        },
      });

      const bridge = createBridge([tool]);
      await bridge.callTool('test-tool', { count: 42 });

      expect(receivedArgs).toEqual({ count: 42 });
    });

    it('rejects args that fail validation instead of passing them through', async () => {
      let executed = false;
      const tool = createTool({
        inputSchema: z.object({ count: z.number() }),
        execute: async () => {
          executed = true;
          return 'ok';
        },
      });

      const bridge = createBridge([tool]);
      // Pass a string instead of number — validation fails, so the tool must NOT
      // run and the call must be reported as an error (privileged tools should
      // never receive unvalidated input).
      const result = await bridge.callTool('test-tool', { count: 'not-a-number' });

      expect(executed).toBe(false);
      expect(result.isError).toBe(true);
    });

    it('stringifies non-string results as JSON', async () => {
      const tool = createTool({
        inputSchema: z.object({}),
        execute: async () => ({ files: ['a.txt', 'b.txt'], count: 2 }),
      });

      const bridge = createBridge([tool]);
      const result = await bridge.callTool('test-tool', {});

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.files).toEqual(['a.txt', 'b.txt']);
      expect(parsed.count).toBe(2);
    });
  });

  describe('getTool / hasTool / size', () => {
    it('returns tool by name', () => {
      const bridge = createBridge([createTool({ name: 'my-tool' })]);
      const tool = bridge.getTool('my-tool');
      expect(tool).toBeDefined();
      expect(tool!.name).toBe('my-tool');
    });

    it('returns undefined for missing tool', () => {
      const bridge = createBridge();
      expect(bridge.getTool('nope')).toBeUndefined();
    });

    it('hasTool returns correct boolean', () => {
      const bridge = createBridge([createTool({ name: 'exists' })]);
      expect(bridge.hasTool('exists')).toBe(true);
      expect(bridge.hasTool('nope')).toBe(false);
    });

    it('size returns count of registered tools', () => {
      const bridge = createBridge([createTool({ name: 'a' }), createTool({ name: 'b' })]);
      expect(bridge.size).toBe(2);
    });
  });

  describe('updateTools', () => {
    it('replaces all tools', () => {
      const bridge = createBridge([createTool({ name: 'old' })]);
      expect(bridge.hasTool('old')).toBe(true);

      bridge.updateTools([createTool({ name: 'new' })]);
      expect(bridge.hasTool('old')).toBe(false);
      expect(bridge.hasTool('new')).toBe(true);
      expect(bridge.size).toBe(1);
    });
  });

  describe('dispose', () => {
    it('clears all tools', () => {
      const bridge = createBridge([createTool({ name: 'a' }), createTool({ name: 'b' })]);
      expect(bridge.size).toBe(2);

      bridge.dispose();
      expect(bridge.size).toBe(0);
      expect(bridge.listTools()).toEqual([]);
    });
  });
});
