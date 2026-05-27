/**
 * Tests for the agent runtime registry.
 *
 * Covers: registerRuntime, getRuntime, resolveRuntime, getAvailableRuntimes,
 * getActiveRuntimeId, and auto-resolution fallback behavior.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentRuntime, RuntimeCapabilities, StreamOptions, StreamEvent } from '../types.js';
import type { AppConfig } from '../../../config/schema.js';

// ---------------------------------------------------------------------------
// We need to re-import after clearing the registry each test. Since the
// registry uses module-level state, we use dynamic imports + resetModules.
// For simplicity, we'll import once and use registerRuntime to set up state.
// ---------------------------------------------------------------------------

import {
  registerRuntime,
  getRuntime,
  resolveRuntime,
  getAvailableRuntimes,
  getActiveRuntimeId,
  setPluginRuntimesSource,
} from '../index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const STUB_CAPABILITIES: RuntimeCapabilities = {
  builtInTools: false,
  mcpSupport: false,
  toolObserver: false,
  compaction: false,
  memory: false,
  fallback: false,
  multiProvider: false,
  subAgents: false,
  sessions: false,
  customTools: false,
};

function createStubRuntime(
  id: 'mastra' | 'claude-agent-sdk' | 'codex-sdk',
  name: string,
  available: boolean,
): AgentRuntime {
  return {
    id,
    name,
    capabilities: { ...STUB_CAPABILITIES },
    isAvailable: async () => available,
    async *stream(_options: StreamOptions): AsyncGenerator<StreamEvent> {
      yield { conversationId: 'test', type: 'text-delta', text: `Hello from ${name}` };
      yield { conversationId: 'test', type: 'done' };
    },
  };
}

function makeConfig(runtime: string = 'auto'): AppConfig {
  return {
    agent: { runtime },
  } as unknown as AppConfig;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Runtime Registry', () => {
  beforeEach(() => {
    // Re-register a clean set of runtimes before each test.
    // The registry uses a global Map, so registering overwrites any previous.
    registerRuntime(createStubRuntime('mastra', 'Mastra', true));
    registerRuntime(createStubRuntime('claude-agent-sdk', 'Claude Code', false));
    registerRuntime(createStubRuntime('codex-sdk', 'Codex', false));
    setPluginRuntimesSource(() => []);
  });

  describe('registerRuntime / getRuntime', () => {
    it('registers and retrieves a runtime by id', () => {
      const rt = getRuntime('mastra');
      expect(rt).toBeDefined();
      expect(rt!.id).toBe('mastra');
      expect(rt!.name).toBe('Mastra');
    });

    it('returns undefined for unknown id', () => {
      const rt = getRuntime('unknown-id' as 'mastra');
      expect(rt).toBeUndefined();
    });

    it('overwrites a previous registration', () => {
      registerRuntime(createStubRuntime('mastra', 'Mastra v2', true));
      const rt = getRuntime('mastra');
      expect(rt!.name).toBe('Mastra v2');
    });
  });

  describe('resolveRuntime', () => {
    it('returns Mastra when config is "auto" and no SDK is available', async () => {
      const rt = await resolveRuntime(makeConfig('auto'));
      expect(rt.id).toBe('mastra');
    });

    it('returns Claude Code when config is "auto" and CLI is available', async () => {
      registerRuntime(createStubRuntime('claude-agent-sdk', 'Claude Code', true));
      const rt = await resolveRuntime(makeConfig('auto'));
      expect(rt.id).toBe('claude-agent-sdk');
    });

    it('returns explicitly selected runtime when available', async () => {
      registerRuntime(createStubRuntime('codex-sdk', 'Codex', true));
      const rt = await resolveRuntime(makeConfig('codex-sdk'));
      expect(rt.id).toBe('codex-sdk');
    });

    it('falls back to Mastra when selected runtime is unavailable', async () => {
      const rt = await resolveRuntime(makeConfig('claude-agent-sdk'));
      expect(rt.id).toBe('mastra');
    });

    it('does not fall back to Mastra when an explicit plugin runtime is unavailable', async () => {
      const rt = await resolveRuntime(makeConfig('legion'));
      expect(rt.id).toBe('legion');
      expect(await rt.isAvailable()).toBe(false);
    });

    it('falls back to Mastra when config has no agent.runtime', async () => {
      const rt = await resolveRuntime({} as AppConfig);
      expect(rt.id).toBe('mastra');
    });
  });

  describe('getAvailableRuntimes', () => {
    it('returns all registered runtimes with availability status', async () => {
      const runtimes = await getAvailableRuntimes();
      expect(runtimes).toHaveLength(3);

      const mastra = runtimes.find((r) => r.id === 'mastra');
      expect(mastra).toBeDefined();
      expect(mastra!.available).toBe(true);
      expect(mastra!.name).toBe('Mastra');

      const claude = runtimes.find((r) => r.id === 'claude-agent-sdk');
      expect(claude).toBeDefined();
      expect(claude!.available).toBe(false);
    });
  });

  describe('getActiveRuntimeId', () => {
    it('returns the resolved runtime id for auto config', async () => {
      const id = await getActiveRuntimeId(makeConfig('auto'));
      expect(id).toBe('mastra');
    });

    it('returns claude-agent-sdk when available and set to auto', async () => {
      registerRuntime(createStubRuntime('claude-agent-sdk', 'Claude Code', true));
      const id = await getActiveRuntimeId(makeConfig('auto'));
      expect(id).toBe('claude-agent-sdk');
    });

    it('returns explicitly selected runtime id', async () => {
      registerRuntime(createStubRuntime('codex-sdk', 'Codex', true));
      const id = await getActiveRuntimeId(makeConfig('codex-sdk'));
      expect(id).toBe('codex-sdk');
    });
  });

  describe('stream', () => {
    it('yields events from the resolved runtime', async () => {
      const rt = await resolveRuntime(makeConfig('mastra'));
      const events: StreamEvent[] = [];
      for await (const event of rt.stream({
        conversationId: 'test',
        messages: [],
        config: {} as AppConfig,
        tools: [],
        appHome: '/tmp',
      })) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0]).toMatchObject({ type: 'text-delta', text: expect.stringContaining('Mastra') });
      expect(events[events.length - 1]).toMatchObject({ type: 'done' });
    });
  });
});
