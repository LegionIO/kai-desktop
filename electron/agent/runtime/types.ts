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

  /**
   * Runtime spawns a subprocess that executes untrusted, model-directed tools
   * (shell, file edits) unsupervised. Drives blast-radius confinement at the
   * IPC chokepoint (env scrub + cwd confinement). True for the autonomous SDK
   * runtimes (pi / claude-agent-sdk / codex-sdk); false for mastra, whose tool
   * execution stays in-process behind Kai's own guards.
   */
  executesUntrustedTools: boolean;
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
  /** Preallocated Kai assistant id. Runtimes that persist their own response
   * messages should use this id and echo it on stream events. */
  responseMessageId?: string;
  config: AppConfig;
  tools: ToolDefinition[];
  appHome: string;
  reasoningEffort?: ReasoningEffort;
  abortSignal?: AbortSignal;
  cwd?: string;

  /** The active profile/model key of THIS turn, threaded to tool execution
   *  context so a sub_agent tool can inherit the parent's profile + fallback
   *  chain. `parentModelKey` is the inherit fallback when no profile is active. */
  parentProfileKey?: string | null;
  parentModelKey?: string | null;

  /**
   * Confinement inputs pre-built by the IPC layer (issue #66) for runtimes with
   * `executesUntrustedTools`. `childEnv` is the fail-closed allowlist env
   * (buildAgentChildEnv) to hand the spawned CLI; `confinedCwd` is the
   * validated/clamped working directory (resolveConfinedCwd). Absent for mastra.
   */
  childEnv?: NodeJS.ProcessEnv;
  confinedCwd?: string;

  // --- Callback hooks (used by IPC middleware) ---

  /** Side-channel for events that should be broadcast immediately. */
  emitEvent?: (event: StreamEvent) => void;

  /**
   * Called when a tool starts executing (for observer / approval flows).
   * Return `{ skip, result }` to short-circuit execution — the tool body is
   * never called and `result` is fed to `augmentToolResult` / the model.
   */
  onToolExecutionStart?: (state: {
    toolCallId: string;
    toolName: string;
    args: unknown;
    cancel: () => void;
  }) => void | { skip: true; result: unknown } | Promise<void | { skip: true; result: unknown }>;

  /** Called when a tool finishes executing. */
  onToolExecutionEnd?: (state: { toolCallId: string; toolName: string }) => void;

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
   * Pre-resolved credentials for the selected model, used by runtimes that
   * need explicit endpoint + API key + model name (Claude Code, Codex).
   */
  modelAuth?: {
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

  /**
   * Injected prior conversation context for cross-runtime switch.
   * When present, indicates the runtime is being used for the first time in this
   * conversation (switched from a different runtime). The context contains a
   * transcript or summary of prior turns.
   *
   * - Claude Code SDK: skip session resume (prior session is from another runtime)
   * - Codex SDK: prepend to the user prompt (Codex has no system prompt API)
   * - Mastra: not used (Mastra already receives full message history)
   */
  switchContext?: string;
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
export type RuntimeId = 'mastra' | 'claude-agent-sdk' | 'codex-sdk' | 'pi' | 'opencode';

/** Human-readable labels for the settings UI. */
export const RUNTIME_LABELS: Record<RuntimeId, string> = {
  mastra: 'Mastra',
  'claude-agent-sdk': 'Claude Agent SDK',
  'codex-sdk': 'Codex SDK',
  pi: 'pi',
  opencode: 'OpenCode',
};

/**
 * Kai tools NOT bridged into an external-CLI runtime (Codex / Claude Agent SDK).
 * These runtimes have their own native equivalent, so bridging Kai's version
 * would duplicate/confuse it. Everything else — including builtin tools like
 * web_search / web_fetch / memory and cli-source tools — IS bridged, so the
 * external runtime can call the same tools the native Mastra agent can.
 *
 * `sub_agent`: both SDKs have a native sub-agent/Agent primitive.
 */
export const RUNTIME_BRIDGE_SKIP_TOOLS = new Set<string>(['sub_agent']);
