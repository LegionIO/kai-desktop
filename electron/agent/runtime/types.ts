/**
 * Agent runtime abstraction layer.
 *
 * Defines the contract every runtime adapter must satisfy so the IPC layer and
 * renderer can remain agnostic of the underlying agent implementation.
 *
 * Supported runtimes:
 *   - Mastra           (default, full Kai feature set)
 *   - Claude Agent SDK (@anthropic-ai/claude-agent-sdk)
 *   - Codex SDK        (@openai/codex-sdk) — stub/minimal
 */

import type { StreamEvent } from '../mastra-agent.js';
import type { AppConfig } from '../../config/schema.js';
import type { ToolDefinition } from '../../tools/types.js';
import type { ReasoningEffort, ResolvedStreamConfig, ModelCatalogEntry } from '../model-catalog.js';

// Re-export StreamEvent so runtime adapters import from a single place.
export type { StreamEvent } from '../mastra-agent.js';

// ---------------------------------------------------------------------------
// Capability flags
// ---------------------------------------------------------------------------

/**
 * Declares which Kai features a given runtime supports.  The IPC middleware
 * uses these to gate optional processing (observer, compaction, …).
 */
export type RuntimeCapabilities = {
  /** Runtime manages its own tool execution loop (Read, Write, Bash, …). */
  builtInTools: boolean;

  /** Runtime can connect to MCP servers natively. */
  mcpSupport: boolean;

  /** Compatible with Kai's ToolObserverManager middleware. */
  toolObserver: boolean;

  /** Compatible with Kai's context compaction middleware. */
  compaction: boolean;

  /** Compatible with Kai's memory layers (working / observational / semantic). */
  memory: boolean;

  /** Supports model fallback chains managed by Kai. */
  fallback: boolean;

  /** Supports multi-provider model selection (Anthropic, Bedrock, OpenAI, …). */
  multiProvider: boolean;

  /** Supports sub-agent delegation. */
  subAgents: boolean;

  /** Supports session resume across queries. */
  sessions: boolean;

  /** Can accept custom Kai tools (skills, plugins, CLI tools) at stream time. */
  customTools: boolean;
};

// ---------------------------------------------------------------------------
// Stream options — the inputs every runtime receives
// ---------------------------------------------------------------------------

/**
 * Options passed to `AgentRuntime.stream()`.
 *
 * The shape mirrors what `streamMastra()` in `ipc/agent.ts` already assembles
 * so the refactor from direct Mastra calls to the runtime abstraction is
 * a straightforward delegation.
 */
export type StreamOptions = {
  conversationId: string;
  messages: unknown[];
  config: AppConfig;
  tools: ToolDefinition[];
  appHome: string;
  reasoningEffort?: ReasoningEffort;
  abortSignal?: AbortSignal;
  cwd?: string;

  // --- Callback hooks (used by IPC middleware) ---

  /** Side-channel for events that should be broadcast immediately. */
  emitEvent?: (event: StreamEvent) => void;

  /** Called when a tool starts executing (for observer / approval flows). */
  onToolExecutionStart?: (state: {
    toolCallId: string;
    toolName: string;
    args: unknown;
    cancel: () => void;
  }) => void | Promise<void>;

  /** Called when a tool finishes executing. */
  onToolExecutionEnd?: (state: {
    toolCallId: string;
    toolName: string;
  }) => void;

  /**
   * Allows the IPC layer to modify / compact a tool result before it is
   * appended to the conversation.
   */
  augmentToolResult?: (state: {
    toolCallId: string;
    toolName: string;
    args: unknown;
    result: unknown;
  }) => Promise<unknown> | unknown;

  // --- Pre-resolved fields (optional, provided by IPC layer) ---

  /**
   * Pre-resolved stream configuration (model, temperature, fallback chain, etc.).
   * When provided, the runtime can skip internal resolution.
   * When absent, the runtime resolves from `config` directly.
   */
  streamConfig?: ResolvedStreamConfig;

  /**
   * Pre-resolved primary model entry.
   * When provided alongside `streamConfig`, avoids redundant model catalog lookups.
   */
  primaryModel?: ModelCatalogEntry | null;

  /**
   * Pre-resolved Anthropic-compatible credentials for the Claude Code runtime.
   * When present, the Claude runtime passes these via the SDK `settings` option,
   * overriding ~/.claude/settings.json.
   */
  claudeAuth?: {
    modelName: string;
    baseUrl: string;
    apiKey: string;
  };

  /**
   * Persisted metadata from the conversation record.
   * Runtimes use this to resume prior sessions:
   *   - `claudeSdkSessionId` (Claude Code SDK): resume the Claude Code session
   *   - `codexSdkThreadId` (Codex SDK): resume the Codex thread
   */
  conversationMetadata?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Agent runtime interface
// ---------------------------------------------------------------------------

export interface AgentRuntime {
  /** Unique machine-readable identifier (e.g. `'mastra'`). */
  readonly id: RuntimeId;

  /** Human-readable display name (e.g. `'Mastra'`). */
  readonly name: string;

  /** Capability flags checked by the IPC middleware. */
  readonly capabilities: RuntimeCapabilities;

  /**
   * Returns `true` when the runtime's dependencies are installed and usable.
   *
   * For built-in runtimes (Mastra) this always returns `true`.  For external
   * SDKs it performs a dynamic `import()` probe.  Results are cached.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Core streaming method.
   *
   * Must yield `StreamEvent` objects compatible with the renderer's
   * `RuntimeProvider` accumulation logic.  At minimum, a runtime must emit:
   *
   *   - `text-delta` (one or more) for assistant text
   *   - `tool-call` / `tool-result` for each tool invocation
   *   - `done` when the turn is complete
   *   - `error` on unrecoverable failure
   *
   * Optional event types (`context-usage`, `model-fallback`, `retry`, etc.)
   * enhance the UI but are not required.
   */
  stream(options: StreamOptions): AsyncGenerator<StreamEvent>;

  /**
   * Generate a short title for a conversation.
   * Falls back to the IPC layer's default implementation when absent.
   */
  generateTitle?(messages: unknown[], config: AppConfig): Promise<string | null>;

  /** Release any resources held by the runtime (open connections, etc.). */
  dispose?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Runtime identifiers
// ---------------------------------------------------------------------------

/** The set of known runtime identifiers. */
export type RuntimeId = 'mastra' | 'claude-agent-sdk' | 'codex-sdk';

/** Human-readable labels for the settings UI. */
export const RUNTIME_LABELS: Record<RuntimeId, string> = {
  mastra: 'Mastra',
  'claude-agent-sdk': 'Claude Agent SDK',
  'codex-sdk': 'Codex SDK',
};
