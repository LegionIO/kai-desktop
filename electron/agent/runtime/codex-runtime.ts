/**
 * Codex SDK agent runtime adapter.
 *
 * Uses the `@openai/codex-sdk` to execute turns via the Codex CLI subprocess.
 * The SDK supports real-time streaming via `Thread.runStreamed()`, which yields
 * `ThreadEvent` objects that we translate to Kai's `StreamEvent` format.
 *
 * Architecture:
 *   - `Codex` class creates a `Thread` via `startThread()` or `resumeThread()`
 *   - `Thread.runStreamed()` returns an async generator of `ThreadEvent`
 *   - Thread items: agent_message, command_execution, file_change,
 *     mcp_tool_call, reasoning, web_search, todo_list, error
 *   - Supports: model, sandboxMode, workingDirectory, approvalPolicy,
 *     reasoningEffort, session resume via thread ID
 */

import type { AgentRuntime, RuntimeCapabilities, StreamOptions, StreamEvent } from './types.js';
import { detectCodexSdk } from './detect.js';
import type { AppConfig } from '../../config/schema.js';
import {
  buildCodexMcpPrompt,
  buildCodexMcpServerConfig,
  CodexMcpBridge,
} from './codex-mcp-bridge.js';

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

const CODEX_CAPABILITIES: RuntimeCapabilities = {
  builtInTools: true,   // Codex has built-in shell, file editing, web search
  mcpSupport: true,     // Codex supports MCP tool calls
  toolObserver: false,  // Codex manages its own tool lifecycle
  compaction: false,    // Codex manages context internally
  memory: false,        // No Kai memory layer integration
  fallback: false,      // No model fallback chain
  multiProvider: false,  // OpenAI models only
  subAgents: false,     // No sub-agent delegation
  sessions: true,       // Thread resume via thread ID
  customTools: true,   // Custom Kai tools via local MCP bridge
};

// ---------------------------------------------------------------------------
// Types for the dynamic SDK import (avoids hard compile-time dependency)
// ---------------------------------------------------------------------------

/** Minimal typing for Codex SDK classes we use. */
type CodexClass = new (options?: {
  apiKey?: string;
  baseUrl?: string;
  config?: Record<string, unknown>;
  env?: Record<string, string>;
}) => {
  startThread(options?: {
    model?: string;
    sandboxMode?: string;
    workingDirectory?: string;
    modelReasoningEffort?: string;
    approvalPolicy?: string;
    skipGitRepoCheck?: boolean;
  }): ThreadInstance;
  resumeThread(id: string, options?: {
    model?: string;
    sandboxMode?: string;
    workingDirectory?: string;
    modelReasoningEffort?: string;
    approvalPolicy?: string;
    skipGitRepoCheck?: boolean;
  }): ThreadInstance;
};

type ThreadInstance = {
  id: string | null;
  runStreamed(input: string, options?: { signal?: AbortSignal }): Promise<{
    events: AsyncGenerator<ThreadEventAny>;
  }>;
  run(input: string, options?: { signal?: AbortSignal }): Promise<{
    items: ThreadItemAny[];
    finalResponse: string;
    usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number } | null;
  }>;
};

type ThreadEventAny = {
  type: string;
  thread_id?: string;
  item?: ThreadItemAny;
  usage?: { input_tokens: number; cached_input_tokens: number; output_tokens: number };
  error?: { message: string };
  message?: string;
  [key: string]: unknown;
};

type ThreadItemAny = {
  id: string;
  type: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  status?: string;
  changes?: Array<{ path: string; kind: string }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: { content: Array<{ type: string; text?: string }>; structured_content?: unknown };
  error?: { message: string };
  query?: string;
  items?: Array<{ text: string; completed: boolean }>;
  message?: string;
};

// ---------------------------------------------------------------------------
// Runtime implementation
// ---------------------------------------------------------------------------

export class CodexRuntime implements AgentRuntime {
  readonly id = 'codex-sdk' as const;
  readonly name = 'Codex';
  readonly capabilities = CODEX_CAPABILITIES;

  async isAvailable(): Promise<boolean> {
    return detectCodexSdk();
  }

  async *stream(options: StreamOptions): AsyncGenerator<StreamEvent> {
    const {
      conversationId,
      config,
      tools,
      cwd,
      reasoningEffort,
      abortSignal,
    } = options;

    // -----------------------------------------------------------------------
    // 1. Dynamic SDK import
    // -----------------------------------------------------------------------
    let CodexCtor: CodexClass;

    try {
      const sdk = await import('@openai/codex-sdk');
      CodexCtor = sdk.Codex as unknown as CodexClass;
    } catch {
      yield {
        conversationId,
        type: 'text-delta',
        text: 'Codex SDK failed to load. Ensure the Codex CLI is installed and available on your PATH.',
      };
      yield { conversationId, type: 'done' };
      return;
    }

    // -----------------------------------------------------------------------
    // 2. Extract config
    // -----------------------------------------------------------------------
    const agentConfig = (config as Record<string, unknown>).agent as Record<string, unknown> | undefined;
    const sdkConfig = (agentConfig?.codexSdk ?? {}) as Record<string, unknown>;

    // Map Kai approval modes to Codex approval policy
    const approvalMap: Record<string, string> = {
      'suggest': 'on-request',
      'auto-edit': 'on-failure',
      'full-auto': 'never',
    };
    const approvalPolicy = approvalMap[(sdkConfig.approval as string) ?? 'suggest'] ?? 'on-request';

    // Map reasoning effort
    const effortMap: Record<string, string> = {
      'low': 'low',
      'medium': 'medium',
      'high': 'high',
      'xhigh': 'xhigh',
    };
    const modelEffort = effortMap[reasoningEffort ?? 'high'] ?? 'high';

    // Extract API key from the model config (look for OpenAI-compatible provider)
    const apiKey = extractOpenAiApiKey(config);

    // -----------------------------------------------------------------------
    // 3. Extract prompt from messages
    // -----------------------------------------------------------------------
    const prompt = extractLastUserPrompt(options.messages);
    if (!prompt) {
      yield {
        conversationId,
        type: 'text-delta',
        text: 'No user message found to send to Codex SDK.',
      };
      yield { conversationId, type: 'done' };
      return;
    }

    // -----------------------------------------------------------------------
    // 4. Start MCP bridge for custom tools (before creating Codex instance)
    //    Only bridge plugin/skill/mcp tools — Codex has its own built-in tools
    // -----------------------------------------------------------------------
    const bridge = new CodexMcpBridge();
    let bridgeUrl: string | undefined;

    const customTools = tools?.filter(
      (t) => t.source === 'plugin' || t.source === 'skill' || t.source === 'mcp',
    );

    if (customTools && customTools.length > 0) {
      try {
        bridgeUrl = await bridge.start(customTools, conversationId, cwd, abortSignal);
        console.info(`[codex-runtime] MCP bridge enabled with ${customTools.length} custom tool(s)`);
      } catch (err) {
        // Non-fatal — Codex can still work with its built-in tools only
        console.warn('[codex-runtime] Failed to start MCP bridge:', err);
      }
    }

    // -----------------------------------------------------------------------
    // 5. Create Codex instance and thread
    // -----------------------------------------------------------------------
    const codex = new CodexCtor({
      ...(apiKey ? { apiKey } : {}),
      ...(bridgeUrl ? {
        config: {
          features: {
            tool_search_always_defer_mcp_tools: false,
          },
          mcp_servers: {
            kai: buildCodexMcpServerConfig(bridgeUrl, customTools ?? []),
          },
        },
      } : {}),
    });

    const threadOptions = {
      workingDirectory: cwd ?? process.cwd(),
      modelReasoningEffort: modelEffort,
      approvalPolicy,
      skipGitRepoCheck: true,
    };

    // Resume or start new thread
    const resumeId = (sdkConfig.resumeThreadId as string) ?? undefined;
    const thread = resumeId
      ? codex.resumeThread(resumeId, threadOptions)
      : codex.startThread(threadOptions);

    // -----------------------------------------------------------------------
    // 6. Stream and translate events
    // -----------------------------------------------------------------------
    try {
      const codexPrompt = bridgeUrl && customTools
        ? buildCodexMcpPrompt(prompt, customTools)
        : prompt;

      const { events } = await thread.runStreamed(codexPrompt, {
        signal: abortSignal,
      });

      for await (const event of events) {
        if (abortSignal?.aborted) break;

        const translated = translateCodexEvent(conversationId, event);
        for (const evt of translated) {
          yield evt;
        }
      }

      yield { conversationId, type: 'done' };
    } catch (err) {
      if (abortSignal?.aborted) {
        yield { conversationId, type: 'done' };
        return;
      }

      yield {
        conversationId,
        type: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
      yield { conversationId, type: 'done' };
    } finally {
      // -----------------------------------------------------------------------
      // 7. Cleanup: stop the MCP bridge
      // -----------------------------------------------------------------------
      try {
        await bridge.stop();
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  async generateTitle(
    _messages: unknown[],
    _config: AppConfig,
  ): Promise<string | null> {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helper: Extract the last user prompt
// ---------------------------------------------------------------------------

function extractLastUserPrompt(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: unknown } | undefined;
    if (!msg) continue;

    if (msg.role === 'user') {
      if (typeof msg.content === 'string') return msg.content;
      if (Array.isArray(msg.content)) {
        const textParts = (msg.content as Array<{ type?: string; text?: string }>)
          .filter((p) => p.type === 'text' && p.text)
          .map((p) => p.text)
          .join('\n');
        if (textParts) return textParts;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helper: Extract OpenAI API key from config
// ---------------------------------------------------------------------------

function extractOpenAiApiKey(config: AppConfig): string | undefined {
  const providers = (config as Record<string, unknown>).models as Record<string, unknown> | undefined;
  const providerMap = (providers?.providers ?? {}) as Record<string, { type?: string; apiKey?: string; enabled?: boolean }>;

  for (const provider of Object.values(providerMap)) {
    if (provider.type === 'openai-compatible' && provider.enabled !== false && provider.apiKey) {
      return provider.apiKey;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Helper: Translate Codex ThreadEvent → Kai StreamEvent
// ---------------------------------------------------------------------------

function translateCodexEvent(conversationId: string, event: ThreadEventAny): StreamEvent[] {
  const events: StreamEvent[] = [];

  switch (event.type) {
    // ---------------------------------------------------------------
    // Thread lifecycle
    // ---------------------------------------------------------------
    case 'thread.started': {
      if (event.thread_id) {
        events.push({
          conversationId,
          type: 'enrichment',
          data: { codexThreadId: event.thread_id },
        });
      }
      break;
    }

    // ---------------------------------------------------------------
    // Item events (started, updated, completed)
    // ---------------------------------------------------------------
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const item = event.item;
      if (!item) break;

      switch (item.type) {
        case 'agent_message': {
          // Only emit text on completed to avoid duplicates from started→updated→completed
          if (event.type === 'item.completed' && item.text) {
            events.push({
              conversationId,
              type: 'text-delta',
              text: item.text,
            });
          }
          break;
        }

        case 'command_execution': {
          if (event.type === 'item.started') {
            events.push({
              conversationId,
              type: 'tool-call',
              toolCallId: item.id,
              toolName: 'Bash',
              args: { command: item.command ?? '' },
              startedAt: new Date().toISOString(),
            });
          }
          if (event.type === 'item.completed') {
            events.push({
              conversationId,
              type: 'tool-result',
              toolCallId: item.id,
              toolName: 'Bash',
              result: item.aggregated_output ?? '',
              finishedAt: new Date().toISOString(),
            });
          }
          break;
        }

        case 'file_change': {
          if (event.type === 'item.completed' && item.changes) {
            const summary = item.changes
              .map((c) => `${c.kind}: ${c.path}`)
              .join('\n');
            events.push({
              conversationId,
              type: 'tool-call',
              toolCallId: item.id,
              toolName: 'FileChange',
              args: { changes: item.changes },
              startedAt: new Date().toISOString(),
            });
            events.push({
              conversationId,
              type: 'tool-result',
              toolCallId: item.id,
              toolName: 'FileChange',
              result: summary,
              finishedAt: new Date().toISOString(),
            });
          }
          break;
        }

        case 'mcp_tool_call': {
          if (event.type === 'item.started') {
            events.push({
              conversationId,
              type: 'tool-call',
              toolCallId: item.id,
              toolName: `${item.server}/${item.tool}`,
              args: item.arguments ?? {},
              startedAt: new Date().toISOString(),
            });
          }
          if (event.type === 'item.completed') {
            const resultText = item.result?.content
              ?.filter((c) => c.type === 'text' && c.text)
              .map((c) => c.text)
              .join('\n') ?? '';
            events.push({
              conversationId,
              type: 'tool-result',
              toolCallId: item.id,
              toolName: `${item.server}/${item.tool}`,
              result: item.error ? `Error: ${item.error.message}` : resultText,
              finishedAt: new Date().toISOString(),
            });
          }
          break;
        }

        case 'reasoning': {
          // Emit reasoning as observer-style message
          if (event.type === 'item.completed' && item.text) {
            events.push({
              conversationId,
              type: 'observer-message',
              data: {
                toolCallId: item.id,
                toolName: 'reasoning',
                message: item.text,
              },
            });
          }
          break;
        }

        case 'error': {
          if (item.message) {
            events.push({
              conversationId,
              type: 'error',
              error: item.message,
            });
          }
          break;
        }

        // web_search, todo_list — informational, no direct mapping needed
        default:
          break;
      }
      break;
    }

    // ---------------------------------------------------------------
    // Turn completed — emit usage
    // ---------------------------------------------------------------
    case 'turn.completed': {
      if (event.usage) {
        const u = event.usage;
        const inputTokens = u.input_tokens + u.cached_input_tokens;
        events.push({
          conversationId,
          type: 'context-usage',
          data: {
            inputTokens,
            outputTokens: u.output_tokens,
            totalTokens: inputTokens + u.output_tokens,
          },
        });
      }
      break;
    }

    // ---------------------------------------------------------------
    // Turn failed
    // ---------------------------------------------------------------
    case 'turn.failed': {
      events.push({
        conversationId,
        type: 'error',
        error: event.error?.message ?? 'Codex turn failed',
      });
      break;
    }

    // ---------------------------------------------------------------
    // Stream error
    // ---------------------------------------------------------------
    case 'error': {
      events.push({
        conversationId,
        type: 'error',
        error: event.message ?? 'Codex stream error',
      });
      break;
    }

    // turn.started, thread.started already handled above
    default:
      break;
  }

  return events;
}
