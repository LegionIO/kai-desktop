import type { z } from 'zod';

export type ToolSource = 'builtin' | 'mcp' | 'skill' | 'plugin' | 'cli';

export type ToolProgressEvent = {
  stream: 'stdout' | 'stderr';
  delta: string;
  output: string;
  bytesSeen: number;
  truncated: boolean;
  stopped: boolean;
  subAgentConversationId?: string;
};

export type ToolExecutionContext = {
  toolCallId: string;
  conversationId?: string;
  cwd?: string;
  abortSignal?: AbortSignal;
  onProgress?: (event: ToolProgressEvent) => void;
  /** True when the run has no live user watching (automation / headless agent
   *  run). Tools that would normally block on user input (e.g. ask_user) use
   *  this to fall back to a persistent Alert instead of failing/hanging. */
  isHeadless?: boolean;
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
