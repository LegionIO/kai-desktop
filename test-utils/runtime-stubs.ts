/**
 * Helpers that construct minimal in-memory stubs of the three AI runtimes
 * (Mastra, Claude Agent SDK, Codex SDK) for unit tests.
 *
 * These stubs mirror the shape of `AgentRuntime` from
 * `electron/agent/runtime/types.ts` — enough surface that test code which
 * imports them compiles and runs. Methods are created with `vi.fn()` so
 * tests can assert call counts.
 *
 * For the canonical stub-injection example, see the registry tests in
 * `electron/agent/runtime/__tests__/registry.test.ts`.
 */

import { vi } from 'vitest';
import type { Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Capability flags — mirror RuntimeCapabilities in electron/agent/runtime/types.ts
// ---------------------------------------------------------------------------

export type StubRuntimeCapabilities = {
  builtInTools: boolean;
  mcpSupport: boolean;
  toolObserver: boolean;
  compaction: boolean;
  memory: boolean;
  fallback: boolean;
  multiProvider: boolean;
  subAgents: boolean;
  sessions: boolean;
  customTools: boolean;
  executesUntrustedTools: boolean;
};

const DEFAULT_CAPABILITIES: StubRuntimeCapabilities = {
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
  executesUntrustedTools: false,
};

// ---------------------------------------------------------------------------
// Stream event shape — mirrors the minimum required by RuntimeProvider
// ---------------------------------------------------------------------------

export type StubStreamEvent =
  | { conversationId: string; type: 'text-delta'; text: string }
  | { conversationId: string; type: 'tool-call'; toolCallId: string; toolName: string; args: unknown }
  | { conversationId: string; type: 'tool-result'; toolCallId: string; result: unknown }
  | { conversationId: string; type: 'done' }
  | { conversationId: string; type: 'error'; error: string };

// ---------------------------------------------------------------------------
// Common stub runtime fields
// ---------------------------------------------------------------------------

interface StubRuntimeBase {
  readonly id: 'mastra' | 'claude-agent-sdk' | 'codex-sdk';
  readonly name: string;
  readonly capabilities: StubRuntimeCapabilities;
  isAvailable: Mock<() => Promise<boolean>>;
  stream: Mock<(options: unknown) => AsyncGenerator<StubStreamEvent>>;
  generateTitle: Mock<(messages: unknown[], config: unknown) => Promise<string | null>>;
  dispose: Mock<() => Promise<void>>;
}

export interface StubClaudeAgentRuntime extends StubRuntimeBase {
  readonly id: 'claude-agent-sdk';
}

export interface StubCodexRuntime extends StubRuntimeBase {
  readonly id: 'codex-sdk';
}

export interface StubMastraRuntime extends StubRuntimeBase {
  readonly id: 'mastra';
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

async function* defaultStream(conversationId = 'test'): AsyncGenerator<StubStreamEvent> {
  yield { conversationId, type: 'text-delta', text: '' };
  yield { conversationId, type: 'done' };
}

function buildBase<TId extends StubRuntimeBase['id']>(
  id: TId,
  name: string,
  capabilities: Partial<StubRuntimeCapabilities>,
): StubRuntimeBase & { readonly id: TId } {
  return {
    id,
    name,
    capabilities: { ...DEFAULT_CAPABILITIES, ...capabilities },
    isAvailable: vi.fn(async () => true),
    stream: vi.fn((_options: unknown) => defaultStream()),
    generateTitle: vi.fn(async () => null),
    dispose: vi.fn(async () => undefined),
  };
}

export function stubClaudeAgent(overrides: Partial<StubClaudeAgentRuntime> = {}): StubClaudeAgentRuntime {
  const base = buildBase('claude-agent-sdk', 'Claude Code', {
    builtInTools: true,
    mcpSupport: true,
    fallback: true,
    multiProvider: true,
    subAgents: true,
    sessions: true,
    customTools: true,
    executesUntrustedTools: true,
  });
  return { ...base, ...overrides } as StubClaudeAgentRuntime;
}

export function stubCodex(overrides: Partial<StubCodexRuntime> = {}): StubCodexRuntime {
  const base = buildBase('codex-sdk', 'Codex', {
    builtInTools: true,
    mcpSupport: true,
    sessions: true,
    customTools: true,
    executesUntrustedTools: true,
  });
  return { ...base, ...overrides } as StubCodexRuntime;
}

export function stubMastra(overrides: Partial<StubMastraRuntime> = {}): StubMastraRuntime {
  const base = buildBase('mastra', 'Mastra', {
    mcpSupport: true,
    toolObserver: true,
    compaction: true,
    memory: true,
    fallback: true,
    multiProvider: true,
    subAgents: true,
    customTools: true,
  });
  return { ...base, ...overrides } as StubMastraRuntime;
}
