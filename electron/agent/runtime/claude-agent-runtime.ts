/**
 * Claude Agent SDK runtime adapter.
 *
 * Uses the `@anthropic-ai/claude-agent-sdk` to stream messages via the Claude
 * Code subprocess.  The SDK handles its own tool execution loop, so Kai's tools
 * are exposed via an in-process MCP server (`createSdkMcpServer()`).
 *
 * Architecture:
 *   - `query()` spawns a Claude Code subprocess and returns an async generator
 *   - Text is streamed via `stream_event` messages (BetaRawMessageStreamEvent)
 *   - Tool calls/results arrive on `assistant` messages (BetaMessage content blocks)
 *   - Custom Kai tools are registered as an MCP server via `createSdkMcpServer()`
 *   - Permissions handled via `canUseTool` callback
 *   - Session resume supported via `resume` / `sessionId` options
 */

import type { AgentRuntime, RuntimeCapabilities, StreamOptions, StreamEvent } from './types.js';
import { detectClaudeAgentSdk } from './detect.js';
import type { AppConfig } from '../../config/schema.js';
import { resolveStreamConfig } from '../model-catalog.js';
import { withWorkingDirectoryPrompt } from '../instructions.js';

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

const CLAUDE_CAPABILITIES: RuntimeCapabilities = {
  builtInTools: true,   // SDK has its own built-in tools (Read, Write, Bash, etc.)
  mcpSupport: true,     // SDK supports MCP natively
  toolObserver: false,  // SDK manages its own tool lifecycle
  compaction: false,    // SDK manages context internally
  memory: false,        // SDK uses sessions, not Kai memory layers
  fallback: true,       // SDK supports fallbackModel option
  multiProvider: true,  // Anthropic + Bedrock + Vertex
  subAgents: true,      // SDK has native Agent tool
  sessions: true,       // SDK supports session resume
  customTools: true,    // Via MCP bridge
};

// ---------------------------------------------------------------------------
// Types for the dynamic SDK import (avoids hard compile-time dependency)
// ---------------------------------------------------------------------------

/**
 * Subset of the SDK's Options type we actually use.
 * Keep in sync with @anthropic-ai/claude-agent-sdk when updating.
 */
type SdkOptions = {
  abortController?: AbortController;
  cwd?: string;
  model?: string;
  fallbackModel?: string;
  maxTurns?: number;
  thinking?: { type: 'adaptive' } | { type: 'enabled'; budgetTokens?: number } | { type: 'disabled' };
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk';
  allowDangerouslySkipPermissions?: boolean;
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; title?: string; toolUseID: string; [k: string]: unknown },
  ) => Promise<{ behavior: 'allow' | 'deny'; message?: string; updatedPermissions?: unknown[] }>;
  mcpServers?: Record<string, unknown>;
  tools?: string[] | { type: 'preset'; preset: 'claude_code' };
  includePartialMessages?: boolean;
  resume?: string;
  sessionId?: string;
  persistSession?: boolean;
  env?: Record<string, string | undefined>;
  systemPrompt?: string | string[] | { type: 'preset'; preset: 'claude_code'; append?: string; excludeDynamicSections?: boolean };
};

/**
 * Minimal typing for SDK messages we handle.
 * The full SDKMessage union is very large — we only match on what we translate.
 */
type SdkMessageAny = {
  type: string;
  subtype?: string;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Runtime implementation
// ---------------------------------------------------------------------------

export class ClaudeAgentRuntime implements AgentRuntime {
  readonly id = 'claude-agent-sdk' as const;
  readonly name = 'Claude Code';
  readonly capabilities = CLAUDE_CAPABILITIES;

  async isAvailable(): Promise<boolean> {
    return detectClaudeAgentSdk();
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
    let sdkQuery: (params: { prompt: string; options?: SdkOptions }) => AsyncGenerator<SdkMessageAny, void>;
    let sdkCreateSdkMcpServer: ((opts: { name: string; tools?: unknown[] }) => unknown) | undefined;
    let sdkToolHelper: ((name: string, desc: string, schema: unknown, handler: unknown) => unknown) | undefined;

    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      sdkQuery = sdk.query as unknown as typeof sdkQuery;
      sdkCreateSdkMcpServer = sdk.createSdkMcpServer as unknown as typeof sdkCreateSdkMcpServer;
      sdkToolHelper = sdk.tool as unknown as typeof sdkToolHelper;
    } catch {
      yield {
        conversationId,
        type: 'text-delta',
        text: 'Claude Agent SDK failed to load. Ensure the Claude Code CLI is installed and available on your PATH.',
      };
      yield { conversationId, type: 'done' };
      return;
    }

    // -----------------------------------------------------------------------
    // 2. Resolve model and system prompt
    // -----------------------------------------------------------------------
    const streamConfig = options.streamConfig ?? resolveStreamConfig(config, {
      threadModelKey: null,
      threadProfileKey: null,
      reasoningEffort,
      fallbackEnabled: false,
    });
    const primaryModel = options.primaryModel !== undefined
      ? options.primaryModel
      : streamConfig?.primaryModel ?? null;

    const modelName = primaryModel?.modelConfig.modelName ?? 'claude-sonnet-4-6';
    const apiKey = primaryModel?.modelConfig.apiKey;

    // Assemble system prompt (appended to Claude Code's default prompt)
    const basePrompt = streamConfig?.systemPrompt ?? config.systemPrompt ?? '';
    const assembledPrompt = await withWorkingDirectoryPrompt(basePrompt, cwd);

    // -----------------------------------------------------------------------
    // 3. Build MCP server for Kai's custom tools
    // -----------------------------------------------------------------------
    let mcpServers: Record<string, unknown> | undefined;

    if (tools.length > 0 && sdkCreateSdkMcpServer && sdkToolHelper) {
      try {
        const sdkTools = tools.map((tool) => {
          // Convert Zod schema to raw shape for the SDK's tool() helper
          // The SDK expects ZodRawShape (the object properties), but our tools
          // have a full ZodObject. We extract .shape if available.
          const zodShape = extractZodShape(tool.inputSchema);

          return sdkToolHelper!(
            tool.name,
            tool.description ?? '',
            zodShape,
            async (args: unknown) => {
              try {
                const result = await tool.execute(args, {
                  toolCallId: `sdk-bridge-${Date.now()}`,
                  conversationId,
                  cwd,
                  abortSignal,
                });
                const text = typeof result === 'string' ? result : JSON.stringify(result);
                return { content: [{ type: 'text' as const, text }] };
              } catch (err) {
                return {
                  content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
                  isError: true,
                };
              }
            },
          );
        });

        const mcpConfig = sdkCreateSdkMcpServer({
          name: 'kai-tools',
          tools: sdkTools,
        });
        mcpServers = { 'kai-tools': mcpConfig };
      } catch (err) {
        console.warn('[ClaudeAgentRuntime] Failed to create MCP bridge for tools:', err);
      }
    }

    // -----------------------------------------------------------------------
    // 4. Extract SDK-specific config
    // -----------------------------------------------------------------------
    const agentConfig = (config as Record<string, unknown>).agent as Record<string, unknown> | undefined;
    const sdkConfig = (agentConfig?.claudeAgentSdk ?? {}) as Record<string, unknown>;

    const permissionMode = (sdkConfig.permissionMode as string) ?? 'default';
    const maxTurns = (sdkConfig.maxTurns as number) ?? 25;
    const thinkingConfig = (sdkConfig.thinking as { type: string; budgetTokens?: number }) ?? { type: 'adaptive' };

    // Map reasoningEffort to SDK effort level
    const effort = reasoningEffort ?? 'high';

    // -----------------------------------------------------------------------
    // 5. Build abort controller
    // -----------------------------------------------------------------------
    const abortController = new AbortController();
    if (abortSignal) {
      if (abortSignal.aborted) {
        yield { conversationId, type: 'done' };
        return;
      }
      abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
    }

    // -----------------------------------------------------------------------
    // 6. Build prompt from messages
    // -----------------------------------------------------------------------
    // The SDK takes a prompt string for the current turn.
    // Extract the last user message as the prompt.
    const prompt = extractLastUserPrompt(options.messages);
    if (!prompt) {
      yield {
        conversationId,
        type: 'text-delta',
        text: 'No user message found to send to Claude Agent SDK.',
      };
      yield { conversationId, type: 'done' };
      return;
    }

    // -----------------------------------------------------------------------
    // 7. Build environment with API key
    // -----------------------------------------------------------------------
    const env: Record<string, string | undefined> = {
      ...process.env,
    };
    if (apiKey) {
      env.ANTHROPIC_API_KEY = apiKey;
    }

    // -----------------------------------------------------------------------
    // 8. Start the query
    // -----------------------------------------------------------------------
    const sdkOptions: SdkOptions = {
      abortController,
      cwd: cwd ?? process.cwd(),
      model: modelName,
      maxTurns,
      thinking: thinkingConfig as SdkOptions['thinking'],
      effort: effort as SdkOptions['effort'],
      permissionMode: permissionMode as SdkOptions['permissionMode'],
      allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions',
      mcpServers,
      includePartialMessages: true,
      persistSession: (sdkConfig.persistSession as boolean) ?? false,
      env,
      // Use the built-in Claude Code tools + our MCP tools
      tools: { type: 'preset', preset: 'claude_code' },
      // Pass Kai's system prompt appended to Claude Code's default
      systemPrompt: assembledPrompt
        ? { type: 'preset', preset: 'claude_code', append: assembledPrompt }
        : { type: 'preset', preset: 'claude_code' },
    };

    // If we have a fallback model, pass it
    if (streamConfig?.fallbackEnabled && streamConfig.fallbackModels.length > 0) {
      const fallbackModel = streamConfig.fallbackModels[0];
      if (fallbackModel) {
        sdkOptions.fallbackModel = fallbackModel.modelConfig.modelName;
      }
    }

    // -----------------------------------------------------------------------
    // 9. Stream and translate events
    // -----------------------------------------------------------------------
    try {
      const queryIter = sdkQuery({ prompt, options: sdkOptions });

      for await (const msg of queryIter) {
        if (abortSignal?.aborted) break;

        const events = translateSdkMessage(conversationId, msg);
        for (const event of events) {
          yield event;
        }
      }

      // If we haven't yielded a done event yet, yield one now
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
    }
  }

  async generateTitle(
    _messages: unknown[],
    _config: AppConfig,
  ): Promise<string | null> {
    // Let the IPC layer handle title generation for now
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helper: Extract the last user prompt from messages
// ---------------------------------------------------------------------------

function extractLastUserPrompt(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: unknown } | undefined;
    if (!msg) continue;

    if (msg.role === 'user') {
      if (typeof msg.content === 'string') return msg.content;
      if (Array.isArray(msg.content)) {
        // Extract text parts
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
// Helper: Extract Zod shape from a ZodObject
// ---------------------------------------------------------------------------

function extractZodShape(zodSchema: unknown): unknown {
  if (!zodSchema || typeof zodSchema !== 'object') return {};

  // ZodObject in Zod 4 has a .shape property
  const schema = zodSchema as { shape?: unknown; _def?: { shape?: unknown; typeName?: string } };

  // Try direct .shape property (Zod 4 ZodObject)
  if (schema.shape && typeof schema.shape === 'object') {
    return schema.shape;
  }

  // Try ._def.shape (Zod 3 compatibility)
  if (schema._def?.shape && typeof schema._def.shape === 'object') {
    return typeof schema._def.shape === 'function'
      ? (schema._def.shape as () => unknown)()
      : schema._def.shape;
  }

  // Fallback: return the schema itself — the SDK's tool() helper may handle it
  return zodSchema;
}

// ---------------------------------------------------------------------------
// Helper: Translate SDK messages to Kai StreamEvents
// ---------------------------------------------------------------------------

function translateSdkMessage(conversationId: string, msg: SdkMessageAny): StreamEvent[] {
  const events: StreamEvent[] = [];

  switch (msg.type) {
    // ---------------------------------------------------------------
    // Streaming text deltas (partial assistant messages)
    // ---------------------------------------------------------------
    case 'stream_event': {
      const event = msg.event as {
        type?: string;
        delta?: { type?: string; text?: string };
        content_block?: { type?: string; id?: string; name?: string; input?: unknown };
        index?: number;
      } | undefined;
      if (!event) break;

      // content_block_delta with text
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
        events.push({
          conversationId,
          type: 'text-delta',
          text: event.delta.text,
        });
      }

      // content_block_start with tool_use — signal start of tool call
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        const block = event.content_block;
        events.push({
          conversationId,
          type: 'tool-call',
          toolCallId: (block.id as string) ?? `tool-${Date.now()}`,
          toolName: (block.name as string) ?? 'unknown',
          args: block.input ?? {},
          startedAt: new Date().toISOString(),
        });
      }

      // input_json_delta for tool call arguments (partial)
      if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
        // We don't have a streaming tool-args event in Kai, so we skip these
      }

      break;
    }

    // ---------------------------------------------------------------
    // Full assistant message (contains complete content blocks)
    // ---------------------------------------------------------------
    case 'assistant': {
      const betaMessage = msg.message as {
        content?: Array<{
          type: string;
          id?: string;
          text?: string;
          name?: string;
          input?: unknown;
        }>;
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
      } | undefined;

      if (!betaMessage?.content) break;

      for (const block of betaMessage.content) {
        if (block.type === 'tool_use') {
          // Complete tool call from assistant message
          events.push({
            conversationId,
            type: 'tool-call',
            toolCallId: block.id ?? `tool-${Date.now()}`,
            toolName: block.name ?? 'unknown',
            args: block.input ?? {},
            startedAt: new Date().toISOString(),
          });
        }
        // Text blocks are already streamed via stream_event, skip here
      }

      // Emit usage from the assistant message
      if (betaMessage.usage) {
        const u = betaMessage.usage;
        const inputTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        const outputTokens = u.output_tokens ?? 0;
        events.push({
          conversationId,
          type: 'context-usage',
          data: {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
          },
        });
      }
      break;
    }

    // ---------------------------------------------------------------
    // Tool progress
    // ---------------------------------------------------------------
    case 'tool_progress': {
      const toolName = msg.tool_name as string | undefined;
      const toolUseId = msg.tool_use_id as string | undefined;
      if (toolName && toolUseId) {
        // Emit as observer-style event
        events.push({
          conversationId,
          type: 'observer-message',
          data: {
            toolCallId: toolUseId,
            toolName,
            message: `Tool ${toolName} executing (${Math.round((msg.elapsed_time_seconds as number) ?? 0)}s)...`,
          },
        });
      }
      break;
    }

    // ---------------------------------------------------------------
    // Result (success or error)
    // ---------------------------------------------------------------
    case 'result': {
      const usage = msg.usage as {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      } | undefined;

      if (usage) {
        const inputTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        const outputTokens = usage.output_tokens ?? 0;
        events.push({
          conversationId,
          type: 'context-usage',
          data: {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            costUsd: (msg.total_cost_usd as number) ?? undefined,
            numTurns: (msg.num_turns as number) ?? undefined,
            durationMs: (msg.duration_ms as number) ?? undefined,
          },
        });
      }

      if (msg.subtype === 'error_during_execution' || msg.subtype === 'error_max_turns' || msg.subtype === 'error_max_budget_usd') {
        const errors = msg.errors as string[] | undefined;
        events.push({
          conversationId,
          type: 'error',
          error: errors?.join('; ') ?? `SDK error: ${msg.subtype}`,
        });
      }

      // Result text from success
      if (msg.subtype === 'success' && msg.result && typeof msg.result === 'string') {
        // The result text is typically already streamed via stream_event.
        // Only emit if it contains content not yet streamed (e.g. structured output).
        if (msg.structured_output !== undefined) {
          events.push({
            conversationId,
            type: 'text-delta',
            text: typeof msg.structured_output === 'string'
              ? msg.structured_output
              : JSON.stringify(msg.structured_output),
          });
        }
      }

      events.push({ conversationId, type: 'done' });
      break;
    }

    // ---------------------------------------------------------------
    // System init — capture session info
    // ---------------------------------------------------------------
    case 'system': {
      if (msg.subtype === 'init') {
        const sessionId = msg.session_id as string | undefined;
        if (sessionId) {
          // Emit as enrichment data for the conversation
          events.push({
            conversationId,
            type: 'enrichment',
            data: {
              sdkSessionId: sessionId,
              sdkModel: msg.model as string | undefined,
              sdkTools: msg.tools as string[] | undefined,
              sdkVersion: msg.claude_code_version as string | undefined,
            },
          });
        }
      }

      // Compact boundary — let the UI know context was compacted
      if (msg.subtype === 'compact_boundary') {
        const metadata = msg.compact_metadata as {
          pre_tokens?: number;
          post_tokens?: number;
          duration_ms?: number;
        } | undefined;
        events.push({
          conversationId,
          type: 'compaction',
          data: {
            preTokens: metadata?.pre_tokens,
            postTokens: metadata?.post_tokens,
            durationMs: metadata?.duration_ms,
          },
        });
      }
      break;
    }

    // ---------------------------------------------------------------
    // API retry events
    // ---------------------------------------------------------------
    case 'api_retry': {
      events.push({
        conversationId,
        type: 'retry',
        data: {
          attempt: (msg.attempt as number) ?? 1,
          delay: (msg.delay_seconds as number) ?? 0,
          error: (msg.error_message as string) ?? 'API retry',
        },
      });
      break;
    }

    // Other message types (user, user_replay, auth_status, etc.) are
    // informational and don't need translation to StreamEvent.
    default:
      break;
  }

  return events;
}
