import type { z } from 'zod';

export type ToolSource = 'builtin' | 'mcp' | 'skill' | 'plugin' | 'cli' | 'browser';

export type ToolProgressEvent = {
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
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  execute: (input: unknown, context: ToolExecutionContext) => Promise<unknown>;
  source?: ToolSource;
  sourceId?: string;
  originalName?: string;
  aliases?: string[];
};
