import type { z } from 'zod';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';

export type ToolSource = 'builtin' | 'mcp' | 'skill' | 'plugin' | 'cli' | 'browser' | 'bridge';

export type ToolProgressEvent = {
  /** MCP progress values retain their units; bytesSeen remains the UI fallback. */
  progress?: number;
  total?: number;
  stream: 'stdout' | 'stderr';
  delta: string;
  output: string;
  bytesSeen: number;
  truncated: boolean;
  stopped: boolean;
  subAgentConversationId?: string;
  /** For sub_agent tool progress: the sub-agent's most recent lifecycle signal.
   *  `complete`/`failed`/`stopped` are TERMINAL (the sub-agent is done — a
   *  watching parent observer must stop nudging it); `awaiting_response` and
   *  `continue` are non-terminal. Lets the observer gate on declared completion
   *  without parsing status text out of stdout. */
  subAgentSignal?: 'complete' | 'failed' | 'awaiting_response' | 'continue' | 'stopped' | 'paused';
};

export type ToolExecutionContext = {
  bridgeSessionId?: string;
  connectorClientId?: string;
  toolCallId: string;
  conversationId?: string;
  /** Unique owner for the current assistant run. Browser tabs and control leases
   * are scoped to this id so overlapping text/Realtime runs cannot clean up one
   * another's state. */
  browserOwnerId?: string;
  cwd?: string;
  abortSignal?: AbortSignal;
  onProgress?: (event: ToolProgressEvent) => void;
  /** True when the run has no live user watching (automation / headless agent
   *  run). Tools that would normally block on user input (e.g. ask_user) use
   *  this to fall back to a persistent Alert instead of failing/hanging. */
  isHeadless?: boolean;
  /** The active profile key of the PARENT turn running this tool, if any. A
   *  sub_agent tool inherits it (unless the call overrides) so the sub-agent
   *  runs under the same profile + fallback chain. */
  parentProfileKey?: string | null;
  /** The active model key of the parent turn — the inherit fallback when the
   *  parent had no profile (single-model turn). */
  parentModelKey?: string | null;
  /** True ONLY when this tool runs in a context that can properly GATE/enforce a plan-mode
   *  transition — i.e. an interactive run whose driver intercepts enter/exit_plan_mode for
   *  user approval + a plan-first restart (the Mastra streamHandler hook, or the Claude SDK
   *  exit_plan_mode handler). Every OTHER executor (Pi/Codex/OpenCode bridges, task agents,
   *  sub-agents, observer launches, plugin inference, realtime, direct automation tool actions)
   *  calls tool.execute DIRECTLY with this ABSENT — so enter_plan_mode/exit_plan_mode SELF-GUARD
   *  on it and refuse there (they'd otherwise save the plan + flip mode with no approval/restart,
   *  R141). A single chokepoint covering every ungated executor by construction. */
  planModeGateable?: boolean;
};

export type ToolDefinition = {
  jsonInputSchema?: Record<string, unknown>;
  jsonOutputSchema?: Record<string, unknown>;
  mcpDescriptor?: Pick<McpTool, 'title' | 'annotations' | '_meta' | 'icons'>;
  /** Preserve the source MCP envelope for connectors without changing native chat results. */
  executeMcp?: (input: unknown, context: ToolExecutionContext) => Promise<unknown>;
  bridge?: { instanceId: string; pluginId: string; componentId: string; origin: string[] };
  /** Optional explicit eligibility for a tool needing a chat/UI context. */
  mcpExportUnavailableReason?: string;
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  execute: (input: unknown, context: ToolExecutionContext) => Promise<unknown>;
  source?: ToolSource;
  sourceId?: string;
  originalName?: string;
  aliases?: string[];
};
