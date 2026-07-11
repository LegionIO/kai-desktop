/**
 * Claude Agent SDK runtime adapter.
 *
 * Uses the `@anthropic-ai/claude-agent-sdk` to stream messages via the Claude
 * Code subprocess.  The SDK handles its own tool execution loop; Kai's custom
 * tools are exposed via an in-process MCP server (`createSdkMcpServer()`).
 *
 * Architecture:
 *   - `query()` spawns a Claude Code subprocess and returns an async generator
 *   - Text is streamed via `stream_event` messages (BetaRawMessageStreamEvent)
 *   - Tool calls/results arrive on `assistant` messages (BetaMessage content blocks)
 *   - Custom Kai tools (skills, plan mode, ask_user, settings, CLI tools) are
 *     registered as an MCP server via `createSdkMcpServer()`. Tool handlers
 *     run in Kai's main process with full Electron IPC access.
 *   - Permissions handled via `bypassPermissions` mode (Kai manages its own UX)
 *   - Session resume supported via `resume` / `sessionId` options
 */

import type { AgentRuntime, RuntimeCapabilities, StreamOptions, StreamEvent } from './types.js';
import { detectClaudeAgentSdk, resolveClaudeCliPath } from './detect.js';
import type { AppConfig } from '../../config/schema.js';
import type { ToolDefinition, ToolExecutionContext } from '../../tools/types.js';
import { MAX_TOOL_NAME_LENGTH } from '../../tools/naming.js';
import { resolveStreamConfig } from '../model-catalog.js';
import { withWorkingDirectoryPrompt } from '../instructions.js';
import { registerPendingApproval, broadcastStreamEventRaw } from '../../ipc/tool-approval.js';
import { pendingQuestionAnswers } from '../../tools/ask-user.js';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { z } from 'zod';

// ---------------------------------------------------------------------------
// Debug logging
// ---------------------------------------------------------------------------

const DEBUG_ENABLED = !!process.env.KAI_DEBUG_CLAUDE_SDK;
const DEBUG_DIR = join(process.cwd(), 'debug-logs');
const DEBUG_LOG = join(DEBUG_DIR, 'claude-sdk.log');

// ---------------------------------------------------------------------------
// Child-process env scrubbing
// ---------------------------------------------------------------------------
//
// The Claude Code subprocess runs model-directed Bash/Write/Edit commands, and
// its `env` option defaults to the full process.env — so those commands would
// inherit Kai's OWN provider secrets. Scrub secret-shaped keys (mirrors the `sh`
// tool + codex-runtime) while keeping PATH/HOME/NODE_*/cert vars the CLI needs.
// The CLI's own Anthropic auth is overlaid explicitly (ANTHROPIC_AUTH_TOKEN /
// ANTHROPIC_BASE_URL) after the scrub. Patterns support a single leading/trailing
// `*` wildcard (case-insensitive).
const CLAUDE_ENV_SECRET_DENYLIST = [
  '*SECRET*',
  '*PASSWORD*',
  '*PASSWD*',
  '*TOKEN*',
  '*CREDENTIAL*',
  '*API_KEY*',
  '*APIKEY*',
  '*ACCESS_KEY*',
  '*PRIVATE_KEY*',
  '*_KEY',
  '*_PAT',
  '*_BASE_URL',
  'DATABASE_URL',
  'ANTHROPIC_*',
  'OPENAI_*',
  'AWS_*',
  'AZURE_*',
  'GOOGLE_*',
  'GEMINI_*',
  'GITHUB_*',
  'GH_*',
  'NPM_*',
];

function claudeEnvKeyMatches(key: string, pattern: string): boolean {
  const k = key.toUpperCase();
  const p = pattern.toUpperCase();
  const lead = p.startsWith('*');
  const trail = p.endsWith('*');
  const core = p.slice(lead ? 1 : 0, trail ? p.length - 1 : p.length);
  if (lead && trail) return k.includes(core);
  if (lead) return k.endsWith(core);
  if (trail) return k.startsWith(core);
  return k === core;
}

/**
 * Build the env for the Claude Code subprocess: process.env with Kai's secrets
 * scrubbed, then the CLI's own Anthropic auth overlaid. Auth vars are applied
 * AFTER the scrub (ANTHROPIC_* would otherwise be stripped by the denylist), so
 * the CLI still authenticates while model-directed Bash commands can't read
 * Kai's other provider keys.
 */
function buildScrubbedClaudeEnv(auth: { apiKey?: string; baseUrl?: string } | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (CLAUDE_ENV_SECRET_DENYLIST.some((pat) => claudeEnvKeyMatches(key, pat))) continue;
    out[key] = value;
  }
  if (auth?.apiKey) out.ANTHROPIC_AUTH_TOKEN = auth.apiKey;
  if (auth?.baseUrl) out.ANTHROPIC_BASE_URL = auth.baseUrl;
  return out;
}

function debugLog(msg: string): void {
  if (!DEBUG_ENABLED) return;
  try {
    mkdirSync(DEBUG_DIR, { recursive: true });
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* ignore */
  }
}
// ---------------------------------------------------------------------------

/** Tools excluded from the MCP bridge (SDK has its own equivalents). */
const SKIP_TOOLS = new Set(['sub_agent']);

const CLAUDE_CAPABILITIES: RuntimeCapabilities = {
  builtInTools: true, // SDK has its own built-in tools (Read, Write, Bash, etc.)
  mcpSupport: true, // SDK supports MCP natively
  toolObserver: false, // SDK manages its own tool lifecycle
  compaction: false, // SDK manages context internally
  memory: false, // SDK uses sessions, not Kai memory layers
  fallback: true, // SDK supports fallbackModel option
  multiProvider: true, // Anthropic + Bedrock + Vertex
  subAgents: true, // SDK has native Agent tool
  sessions: true, // SDK supports session resume
  customTools: true, // Via MCP bridge
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
  systemPrompt?:
    | string
    | string[]
    | { type: 'preset'; preset: 'claude_code'; append?: string; excludeDynamicSections?: boolean };
  pathToClaudeCodeExecutable?: string;
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

  /**
   * Maps Kai conversation IDs to Claude Code SDK session IDs.
   * This allows the SDK to resume its internal conversation history
   * on subsequent messages within the same Kai conversation.
   */
  private sessionMap = new Map<string, string>();

  async isAvailable(): Promise<boolean> {
    return detectClaudeAgentSdk();
  }

  async *stream(options: StreamOptions): AsyncGenerator<StreamEvent> {
    const { conversationId, config, tools, cwd, reasoningEffort, abortSignal } = options;

    // -----------------------------------------------------------------------
    // 1. Dynamic SDK import
    // -----------------------------------------------------------------------
    type SdkUserMessageInput = { type: 'user'; message: { role: 'user'; content: unknown }; parent_tool_use_id: null };
    type SdkQueryFn = (params: {
      prompt: string | AsyncIterable<SdkUserMessageInput>;
      options?: SdkOptions;
    }) => AsyncGenerator<SdkMessageAny, void>;
    type SdkCreateMcpServerFn = (opts: { name: string; version?: string; tools?: unknown[] }) => unknown;
    type SdkToolFn = (
      name: string,
      desc: string,
      schema: Record<string, unknown>,
      handler: (args: unknown, extra: unknown) => Promise<CallToolResult>,
    ) => unknown;

    let sdkQuery: SdkQueryFn;
    let sdkCreateMcpServer: SdkCreateMcpServerFn;
    let sdkTool: SdkToolFn;

    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      sdkQuery = sdk.query as unknown as SdkQueryFn;
      sdkCreateMcpServer = sdk.createSdkMcpServer as unknown as SdkCreateMcpServerFn;
      sdkTool = sdk.tool as unknown as SdkToolFn;
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
    // 2. Resolve system prompt & model from the pre-resolved stream config
    // -----------------------------------------------------------------------
    // options.streamConfig carries the user's model selection from the IPC layer.
    // The fallback re-resolves with defaults only when streamConfig is absent.
    const streamConfig =
      options.streamConfig ??
      resolveStreamConfig(config, {
        threadModelKey: null,
        threadProfileKey: null,
        reasoningEffort,
        fallbackEnabled: false,
      });

    // Assemble system prompt (appended to Claude Code's default prompt)
    const basePrompt = streamConfig?.systemPrompt ?? config.systemPrompt ?? '';
    const assembledPrompt = await withWorkingDirectoryPrompt(basePrompt, cwd);

    // -----------------------------------------------------------------------
    // 3. Build MCP bridge for Kai's custom tools
    // -----------------------------------------------------------------------
    // Kai tools are exposed to the Claude Code subprocess via an in-process
    // MCP server (createSdkMcpServer). Tool handlers run in this process —
    // they have full access to Electron IPC, BrowserWindow, and the FS.
    //
    // Excluded:
    //   - sub_agent: SDK has its own native Agent tool
    const bridgeableTools = (tools ?? []).filter((t) => !SKIP_TOOLS.has(t.name));

    let mcpServers: Record<string, unknown> | undefined;
    if (bridgeableTools.length > 0) {
      try {
        // The SDK wraps tool names with `mcp__<server>__` prefix.
        // For the 'kai' server this adds `mcp__kai__` (10 chars).
        // APIs enforce a hard 64-char limit on tool names.
        // MAX_TOOL_NAME_LENGTH (54) already accounts for this prefix.
        // Tool names should already be truncated at registration time
        // (buildScopedToolName), but we enforce it here as a safety net.
        const usedNames = new Set<string>();

        const sdkTools = bridgeableTools.map((t) => {
          let safeName = t.name.length > MAX_TOOL_NAME_LENGTH ? t.name.slice(0, MAX_TOOL_NAME_LENGTH) : t.name;
          // Resolve collisions from truncation by appending a counter
          if (usedNames.has(safeName)) {
            let counter = 2;
            while (usedNames.has(`${safeName.slice(0, MAX_TOOL_NAME_LENGTH - 2)}_${counter}`)) counter++;
            safeName = `${safeName.slice(0, MAX_TOOL_NAME_LENGTH - 2)}_${counter}`;
            debugLog(`[BRIDGE] Collision-resolved tool name: ${t.name} → ${safeName}`);
          }
          usedNames.add(safeName);
          if (safeName !== t.name) {
            debugLog(`[BRIDGE] Truncated tool name: ${t.name} → ${safeName}`);
          }
          const rawShape = extractZodShape(t.inputSchema);
          return sdkTool(
            safeName,
            t.description ?? '',
            rawShape,
            createToolHandler(t, conversationId, cwd, abortSignal),
          );
        });

        const kaiServer = sdkCreateMcpServer({
          name: 'kai',
          version: '1.0.0',
          tools: sdkTools,
        });

        mcpServers = { kai: kaiServer };
        debugLog(
          `[BRIDGE] Created MCP bridge with ${sdkTools.length} tools: ${bridgeableTools.map((t) => t.name).join(', ')}`,
        );
      } catch (bridgeErr) {
        debugLog(
          `[BRIDGE] Failed to create MCP bridge: ${bridgeErr instanceof Error ? bridgeErr.message : String(bridgeErr)}`,
        );
        // Non-fatal — SDK can still work with its built-in tools only
      }
    }

    // -----------------------------------------------------------------------
    // 4. Extract SDK-specific config
    // -----------------------------------------------------------------------
    const agentConfig = (config as Record<string, unknown>).agent as Record<string, unknown> | undefined;
    const sdkConfig = (agentConfig?.claudeAgentSdk ?? {}) as Record<string, unknown>;

    // Kai manages its own UX — bypass Claude Code's permission prompts entirely.
    // Without this, the SDK blocks on interactive approval for writes/bash/etc.
    const permissionMode = 'bypassPermissions';
    const maxTurns = (agentConfig?.maxTurns as number) ?? (sdkConfig.maxTurns as number) ?? 25;
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
    // The SDK accepts either a plain string or AsyncIterable<SDKUserMessage>.
    // We use the structured form so images survive — plain strings drop them.
    const lastUserContent = extractLastUserContent(options.messages);
    if (!lastUserContent) {
      yield {
        conversationId,
        type: 'text-delta',
        text: 'No user message found to send to Claude Agent SDK.',
      };
      yield { conversationId, type: 'done' };
      return;
    }

    // If the content is purely text, send a plain string (simpler + more
    // compatible with session-resume flows). Otherwise send a structured
    // SDKUserMessage so image blocks reach the model intact.
    const hasImages =
      Array.isArray(lastUserContent) && lastUserContent.some((b: { type: string }) => b.type === 'image');

    // When cross-runtime switch context is present, prepend it to the user prompt
    // so it's visible as direct conversation context (not buried in system prompt).
    const switchPrefix = options.switchContext ? `${options.switchContext}\n\n` : '';

    const prompt: string | AsyncIterable<SdkUserMessageInput> = hasImages
      ? (async function* () {
          yield {
            type: 'user' as const,
            message: { role: 'user' as const, content: lastUserContent },
            parent_tool_use_id: null,
          };
        })()
      : typeof lastUserContent === 'string'
        ? `${switchPrefix}${lastUserContent}`
        : `${switchPrefix}${(lastUserContent as Array<{ type: string; text?: string }>)
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('\n')}`;

    if (!prompt && !hasImages) {
      yield {
        conversationId,
        type: 'text-delta',
        text: 'No user message found to send to Claude Agent SDK.',
      };
      yield { conversationId, type: 'done' };
      return;
    }

    // -----------------------------------------------------------------------
    // 7. Start the query
    // -----------------------------------------------------------------------
    // When modelAuth is provided, model + endpoint + API key are passed via
    // the SDK's `settings` option (highest-priority layer). Otherwise the SDK
    // falls back to its own config (~/.claude/settings.json).

    // Resolve the system-installed `claude` binary path as a fallback
    // in case the SDK's bundled platform binary is missing (e.g. optional
    // deps were omitted during install).
    const claudeCliPath = await resolveClaudeCliPath();

    // Check if we have a prior SDK session for this conversation.
    // If so, pass `resume` so the SDK replays its stored history.
    // On app restart the in-memory sessionMap is empty, so fall back to the
    // persisted claudeSdkSessionId from the conversation's metadata (written to disk
    // when the enrichment event arrived in the previous session).
    //
    // When switch context is present, skip session resume — the prior session was
    // from a different runtime, so resuming it would fail or produce stale context.
    let existingSessionId: string | undefined;
    if (options.switchContext) {
      debugLog(`[SESSION] Skipping session resume — cross-runtime switch active`);
      existingSessionId = undefined;
    } else {
      const persistedSessionId = options.conversationMetadata?.claudeSdkSessionId as string | undefined;
      if (persistedSessionId && !this.sessionMap.has(conversationId)) {
        debugLog(`[SESSION] Seeding sessionMap from persisted metadata: sessionId=${persistedSessionId}`);
        this.sessionMap.set(conversationId, persistedSessionId);
      }
      existingSessionId = this.sessionMap.get(conversationId);
    }

    // Use pre-resolved auth from the model-runtime compatibility layer.
    // This ensures Kai is always in control of which model + endpoint is used,
    // rather than silently falling back to ~/.claude/settings.json.
    const auth = options.modelAuth ?? null;

    debugLog(
      `[STREAM] conversationId=${conversationId} prompt=${hasImages ? '[structured with images]' : JSON.stringify(prompt).slice(0, 200)}`,
    );
    debugLog(`[STREAM] existingSessionId=${existingSessionId ?? 'none'} sessionMapSize=${this.sessionMap.size}`);
    debugLog(
      `[STREAM] cwd=${cwd} maxTurns=${maxTurns} effort=${effort} permissionMode=${permissionMode} model=${auth?.modelName ?? 'default'} baseUrl=${auth?.baseUrl ?? 'sdk-default'}`,
    );

    const sdkOptions: SdkOptions = {
      abortController,
      // Default to homedir when no working directory is set. Using process.cwd()
      // would point at the kai-desktop source tree, causing the Claude Code
      // subprocess to walk up and load kai-desktop's CLAUDE.md + AGENTS.md
      // (~5.8 KB / ~1400 tokens) on every request.
      cwd: cwd ?? homedir(),
      // Model + auth from Kai's model-runtime resolver.
      ...(auth ? { model: auth.modelName } : {}),
      maxTurns,
      thinking: thinkingConfig as SdkOptions['thinking'],
      effort: effort as SdkOptions['effort'],
      permissionMode: permissionMode as SdkOptions['permissionMode'],
      allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions',
      includePartialMessages: true,
      persistSession: true,
      // Use specific Claude Code tools — SDK's built-in file/code tools.
      // Kai's custom tools are available via the MCP bridge above.
      tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'LSP', 'WebFetch', 'WebSearch', 'Agent', 'Monitor'],
      // Expose Kai's custom tools via in-process MCP server
      ...(mcpServers ? { mcpServers } : {}),
      // Pass Kai's system prompt appended to Claude Code's default.
      // excludeDynamicSections strips the permissions list, hooks, and MCP
      // tool definitions that Claude Code normally injects from
      // ~/.claude/settings.json — those sections add ~3–5k tokens per request
      // and are irrelevant here since Kai manages its own permissions UX.
      systemPrompt: assembledPrompt
        ? { type: 'preset', preset: 'claude_code', append: assembledPrompt, excludeDynamicSections: true }
        : { type: 'preset', preset: 'claude_code', excludeDynamicSections: true },
      // Env for the Claude Code subprocess. Defaults to the full process.env,
      // which would expose Kai's own provider secrets to the model-directed Bash
      // commands the subprocess runs — so we pass a SCRUBBED copy (Kai's secrets
      // removed, PATH/HOME/certs kept) with the CLI's own Anthropic auth overlaid
      // (ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL from Kai's resolver). This
      // replaces the prior `settings.env` override, which only ADDED auth vars on
      // top of the unscrubbed inherited env.
      env: buildScrubbedClaudeEnv(auth),
      // Resume previous session for conversation continuity
      ...(existingSessionId ? { resume: existingSessionId } : {}),
      // Fall back to system-installed CLI when bundled binary is missing
      ...(claudeCliPath ? { pathToClaudeCodeExecutable: claudeCliPath } : {}),
    };

    // -----------------------------------------------------------------------
    // 8. Stream and translate events
    // -----------------------------------------------------------------------
    let retryWithoutResume = false;

    try {
      debugLog(`[QUERY] Starting query with resume=${existingSessionId ?? 'none'}`);
      const queryIter = sdkQuery({ prompt, options: sdkOptions });

      let msgCount = 0;
      for await (const msg of queryIter) {
        if (abortSignal?.aborted) {
          debugLog(`[QUERY] Aborted after ${msgCount} messages`);
          break;
        }

        msgCount++;
        // Log every raw SDK message (truncate large ones)
        const rawJson = JSON.stringify(msg);
        debugLog(
          `[MSG ${msgCount}] type=${msg.type} subtype=${msg.subtype ?? 'none'} raw=${rawJson.slice(0, 500)}${rawJson.length > 500 ? '...(truncated)' : ''}`,
        );

        // Detect session resume failure — retry without resume
        if (
          existingSessionId &&
          msg.type === 'result' &&
          msg.subtype === 'error_during_execution' &&
          msgCount <= 2 // Error on first real message = resume failed
        ) {
          const rawStr = JSON.stringify(msg);
          if (rawStr.includes('No conversation found with session ID')) {
            debugLog(`[SESSION] Resume failed for sessionId=${existingSessionId} — will retry without resume`);
            this.sessionMap.delete(conversationId);
            retryWithoutResume = true;
            break;
          }
        }

        // Capture session ID for future resume within this conversation
        const msgSessionId = (msg as { session_id?: string }).session_id;
        if (msgSessionId && !this.sessionMap.has(conversationId)) {
          debugLog(`[SESSION] Captured sessionId=${msgSessionId} for conversationId=${conversationId}`);
          this.sessionMap.set(conversationId, msgSessionId);
        }

        const events = translateSdkMessage(conversationId, msg);
        debugLog(`[TRANSLATE] ${events.length} events: ${events.map((e) => e.type).join(', ')}`);
        for (const event of events) {
          yield event;
        }
      }

      if (!retryWithoutResume) {
        debugLog(`[QUERY] Finished after ${msgCount} messages`);
        // If we haven't yielded a done event yet, yield one now
        yield { conversationId, type: 'done' };
      }
    } catch (err) {
      debugLog(`[ERROR] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);

      // Session resume failure can also throw — detect and retry
      if (existingSessionId && err instanceof Error && err.message.includes('No conversation found with session ID')) {
        debugLog(`[SESSION] Resume threw — will retry without resume`);
        this.sessionMap.delete(conversationId);
        retryWithoutResume = true;
      }

      if (!retryWithoutResume) {
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

    // -----------------------------------------------------------------------
    // 8b. Retry without session resume if resume failed
    // -----------------------------------------------------------------------
    if (retryWithoutResume) {
      debugLog(`[RETRY] Retrying without resume for conversationId=${conversationId}`);
      const retryOptions = { ...sdkOptions };
      delete retryOptions.resume;

      try {
        const queryIter = sdkQuery({ prompt, options: retryOptions });

        let msgCount = 0;
        for await (const msg of queryIter) {
          if (abortSignal?.aborted) {
            debugLog(`[RETRY] Aborted after ${msgCount} messages`);
            break;
          }

          msgCount++;
          const rawJson = JSON.stringify(msg);
          debugLog(
            `[RETRY-MSG ${msgCount}] type=${msg.type} subtype=${msg.subtype ?? 'none'} raw=${rawJson.slice(0, 500)}${rawJson.length > 500 ? '...(truncated)' : ''}`,
          );

          // Capture new session ID
          const msgSessionId = (msg as { session_id?: string }).session_id;
          if (msgSessionId && !this.sessionMap.has(conversationId)) {
            debugLog(`[SESSION] Captured new sessionId=${msgSessionId} for conversationId=${conversationId}`);
            this.sessionMap.set(conversationId, msgSessionId);
          }

          const events = translateSdkMessage(conversationId, msg);
          for (const event of events) {
            yield event;
          }
        }

        debugLog(`[RETRY] Finished after ${msgCount} messages`);
        yield { conversationId, type: 'done' };
      } catch (retryErr) {
        debugLog(
          `[RETRY-ERROR] ${retryErr instanceof Error ? (retryErr.stack ?? retryErr.message) : String(retryErr)}`,
        );
        if (!abortSignal?.aborted) {
          yield {
            conversationId,
            type: 'error',
            error: retryErr instanceof Error ? retryErr.message : String(retryErr),
          };
        }
        yield { conversationId, type: 'done' };
      }
    }
  }

  async generateTitle(_messages: unknown[], _config: AppConfig): Promise<string | null> {
    // Let the IPC layer handle title generation for now
    return null;
  }

  async dispose(): Promise<void> {
    this.sessionMap.clear();
  }
}

// ---------------------------------------------------------------------------
// Helper: Extract the last user message content (text + image blocks)
// ---------------------------------------------------------------------------

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/**
 * Extract the last user message and return it as Anthropic content blocks,
 * preserving image parts so vision models can see attached screenshots.
 */
function extractLastUserContent(messages: unknown[]): string | AnthropicContentBlock[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: unknown } | undefined;
    if (!msg || msg.role !== 'user') continue;

    if (typeof msg.content === 'string') return msg.content;

    if (Array.isArray(msg.content)) {
      const blocks: AnthropicContentBlock[] = [];

      for (const p of msg.content as Array<{ type?: string; text?: string; image?: string; mimeType?: string }>) {
        if (p.type === 'text' && p.text) {
          blocks.push({ type: 'text', text: p.text });
          continue;
        }

        if (p.type === 'image' && p.image) {
          // image is a data URL: "data:<mime>;base64,<data>"
          const dataUrl = p.image;
          const commaIdx = dataUrl.indexOf(',');
          if (commaIdx === -1) continue;

          const header = dataUrl.slice(0, commaIdx); // "data:image/png;base64"
          const data = dataUrl.slice(commaIdx + 1);
          const mimeMatch = header.match(/data:([^;]+)/);
          const media_type = mimeMatch ? mimeMatch[1] : (p.mimeType ?? 'image/png');

          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type, data },
          });
        }
      }

      if (blocks.length > 0) return blocks;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helper: Translate SDK messages to Kai StreamEvents
// ---------------------------------------------------------------------------

/**
 * Convert PascalCase tool names from SDK to snake_case for Kai.
 * The Claude Code SDK uses PascalCase (ExitPlanMode, AskUserQuestion)
 * but Kai expects snake_case (exit_plan_mode, ask_user_question).
 * Also strips MCP namespacing (mcp__server-name__tool → tool).
 */
function normalizeToolName(name: string): string {
  // Strip MCP prefix: mcp__kai__enter_plan_mode → enter_plan_mode
  const withoutMcp = name.replace(/^mcp__[^_]+__/, '');

  // Convert PascalCase to snake_case
  return withoutMcp
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

/**
 * Rewrite Claude Code CLI-specific advice in SDK error messages.
 *
 * The SDK was designed for the interactive CLI and its error messages
 * reference CLI commands (`--model`, `claude login`, etc.) that don't
 * apply when running inside Kai's desktop UI.
 */
function rewriteSdkError(text: string): string {
  return text
    .replace(
      /Run --model to pick a different model\.?/gi,
      'Try selecting a different model in the model picker, or check that your provider endpoint and API key are configured correctly in Settings → Model Providers.',
    )
    .replace(/Run `claude login`[^.]*/gi, 'Check your API key in Settings → Model Providers.');
}

function translateSdkMessage(conversationId: string, msg: SdkMessageAny): StreamEvent[] {
  const events: StreamEvent[] = [];

  switch (msg.type) {
    // ---------------------------------------------------------------
    // Streaming text deltas (partial assistant messages)
    // ---------------------------------------------------------------
    case 'stream_event': {
      const event = msg.event as
        | {
            type?: string;
            delta?: { type?: string; text?: string };
            content_block?: { type?: string; id?: string; name?: string; input?: unknown };
            index?: number;
          }
        | undefined;
      if (!event) {
        debugLog(`[STREAM_EVENT] No event field in msg. keys=${Object.keys(msg).join(',')}`);
        break;
      }

      // Log non-text-delta events (text deltas are too noisy)
      if (event.type !== 'content_block_delta' || event.delta?.type !== 'text_delta') {
        debugLog(
          `[STREAM_EVENT] event.type=${event.type} delta.type=${event.delta?.type ?? 'none'} block.type=${event.content_block?.type ?? 'none'}`,
        );
      }

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
          toolName: normalizeToolName((block.name as string) ?? 'unknown'),
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
      const betaMessage = msg.message as
        | {
            content?: Array<{
              type: string;
              id?: string;
              text?: string;
              name?: string;
              input?: unknown;
            }>;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
          }
        | undefined;

      if (!betaMessage?.content) {
        debugLog(`[ASSISTANT] No content in message. msg keys: ${Object.keys(msg).join(',')}`);
        break;
      }

      debugLog(
        `[ASSISTANT] ${betaMessage.content.length} blocks: ${betaMessage.content.map((b) => `${b.type}${b.text ? '(text=' + b.text.slice(0, 80) + ')' : ''}`).join(', ')}`,
      );

      for (const block of betaMessage.content) {
        if (block.type === 'tool_use') {
          // Complete tool call from assistant message
          events.push({
            conversationId,
            type: 'tool-call',
            toolCallId: block.id ?? `tool-${Date.now()}`,
            toolName: normalizeToolName(block.name ?? 'unknown'),
            args: block.input ?? {},
            startedAt: new Date().toISOString(),
          });
        }
        // Text blocks are already streamed via stream_event, skip here
      }

      // Emit usage from the assistant message
      if (betaMessage.usage) {
        const u = betaMessage.usage;
        const inputTokens =
          (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
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
      debugLog(
        `[RESULT] subtype=${msg.subtype} result_type=${typeof msg.result} result=${JSON.stringify(msg.result ?? null).slice(0, 300)} structured_output=${JSON.stringify(msg.structured_output ?? null).slice(0, 300)}`,
      );
      const usage = msg.usage as
        | {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          }
        | undefined;

      if (usage) {
        const inputTokens =
          (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
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

      if (
        msg.subtype === 'error_during_execution' ||
        msg.subtype === 'error_max_turns' ||
        msg.subtype === 'error_max_budget_usd'
      ) {
        const errors = msg.errors as string[] | undefined;
        const rawError = errors?.join('; ') ?? `SDK error: ${msg.subtype}`;
        events.push({
          conversationId,
          type: 'error',
          error: rewriteSdkError(rawError),
          ...(msg.subtype === 'error_max_turns' ? { errorCategory: 'max_turns' } : {}),
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
            text:
              typeof msg.structured_output === 'string' ? msg.structured_output : JSON.stringify(msg.structured_output),
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
              claudeSdkSessionId: sessionId,
              sdkModel: msg.model as string | undefined,
              sdkTools: msg.tools as string[] | undefined,
              sdkVersion: msg.claude_code_version as string | undefined,
            },
          });
        }
      }

      // Compact boundary — let the UI know context was compacted
      if (msg.subtype === 'compact_boundary') {
        const metadata = msg.compact_metadata as
          | {
              pre_tokens?: number;
              post_tokens?: number;
              duration_ms?: number;
            }
          | undefined;
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
    // Tool results from the SDK (user messages with tool_result content)
    // The SDK executes tools internally and returns results as user messages.
    // We translate these to tool-result events so the UI can show completion.
    // ---------------------------------------------------------------
    case 'user': {
      const userMessage = msg.message as
        | {
            content?: Array<{
              type: string;
              tool_use_id?: string;
              content?: string;
              is_error?: boolean;
            }>;
          }
        | undefined;

      if (!userMessage?.content) break;

      const finishedAt = new Date().toISOString();

      for (const block of userMessage.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const resultText = block.content ?? '';
          const isError = block.is_error === true;

          debugLog(
            `[TOOL_RESULT] toolUseId=${block.tool_use_id} isError=${isError} result=${resultText.slice(0, 200)}`,
          );

          events.push({
            conversationId,
            type: 'tool-result',
            toolCallId: block.tool_use_id,
            toolName: '', // SDK doesn't include tool name in result; UI can match by toolCallId
            result: isError ? { isError: true, error: resultText } : resultText,
            finishedAt,
          });
        }
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

    // Other message types (user_replay, auth_status, etc.) are
    // informational and don't need translation to StreamEvent.
    default:
      debugLog(
        `[TRANSLATE-SKIP] Unhandled msg type=${msg.type} subtype=${msg.subtype ?? 'none'} keys=${Object.keys(msg).join(',')}`,
      );
      break;
  }

  return events;
}

// ---------------------------------------------------------------------------
// MCP bridge helpers
// ---------------------------------------------------------------------------

/**
 * Extract the ZodRawShape from a Zod schema.
 *
 * The SDK's `tool()` function expects `{ key: ZodType }` (a ZodRawShape),
 * but Kai tools store `z.object({...})` (a ZodObject). This extracts `.shape`.
 */
function extractZodShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
  // z.object() has a .shape property containing { key: ZodType }
  if (
    schema &&
    typeof schema === 'object' &&
    'shape' in schema &&
    typeof schema.shape === 'object' &&
    schema.shape !== null
  ) {
    return schema.shape as Record<string, z.ZodTypeAny>;
  }
  // Fallback for non-object schemas — wrap in a single-key object
  return { input: schema };
}

/** MCP CallToolResult shape returned by tool handlers. */
type CallToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/**
 * Create an MCP tool handler for a Kai tool definition.
 *
 * Most tools get a standard handler that calls `execute()` and wraps the
 * result. `ask_user` gets a special handler that orchestrates the UI flow.
 */
function createToolHandler(
  toolDef: ToolDefinition,
  conversationId: string,
  cwd: string | undefined,
  abortSignal: AbortSignal | undefined,
): (args: unknown, extra: unknown) => Promise<CallToolResult> {
  if (toolDef.name === 'ask_user') {
    return createAskUserHandler(conversationId, abortSignal);
  }
  if (toolDef.name === 'exit_plan_mode') {
    return createExitPlanModeHandler(toolDef, conversationId, cwd, abortSignal);
  }

  // Standard tool handler — validate args, call execute(), wrap the result
  return async (args: unknown): Promise<CallToolResult> => {
    const context: ToolExecutionContext = {
      toolCallId: `sdk-bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      conversationId,
      cwd,
      abortSignal,
    };

    try {
      // These tools run with full local privileges, so if the tool's Zod schema
      // exists and rejects, fail the call rather than executing on raw input.
      // Tools without a safeParse-capable schema pass through (nothing to check).
      let validatedArgs: unknown = args;
      const safeParse = (toolDef.inputSchema as { safeParse?: (v: unknown) => { success: boolean; data?: unknown } })
        .safeParse;
      if (typeof safeParse === 'function') {
        const parsed = safeParse.call(toolDef.inputSchema, args);
        if (!parsed.success) {
          return {
            content: [{ type: 'text', text: `Invalid arguments for tool "${toolDef.name}".` }],
            isError: true,
          };
        }
        validatedArgs = parsed.data;
      }

      const result = await toolDef.execute(validatedArgs, context);
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      // Surface an error-shaped tool result as a tool error, not a success.
      const resultIsError =
        !!result &&
        typeof result === 'object' &&
        ((result as { isError?: unknown }).isError === true ||
          (typeof (result as { error?: unknown }).error === 'string' &&
            (result as { error: string }).error.length > 0));
      return { content: [{ type: 'text', text }], ...(resultIsError ? { isError: true } : {}) };
    } catch (err) {
      return {
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  };
}

/**
 * Create a tool handler for `ask_user` that orchestrates the full UI flow.
 *
 * 1. Broadcasts `tool-approval-required` to the renderer (shows question UI)
 * 2. Registers a pending approval and awaits the user's response
 * 3. Retrieves answers from the shared `pendingQuestionAnswers` map
 * 4. Returns the answers as the MCP tool result
 *
 * The renderer doesn't need changes — it already handles `tool-approval-required`
 * events and sends answers via `agent:answer-tool-question` IPC.
 */
function createAskUserHandler(
  conversationId: string,
  abortSignal: AbortSignal | undefined,
): (args: unknown, extra: unknown) => Promise<CallToolResult> {
  return async (args: unknown): Promise<CallToolResult> => {
    const toolCallId = `sdk-ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    debugLog(`[ASK_USER] Broadcasting question toolCallId=${toolCallId}`);

    // 1. Broadcast to renderer — shows question UI
    broadcastStreamEventRaw({
      conversationId,
      type: 'tool-approval-required',
      toolCallId,
      toolName: 'ask_user',
      args,
    });

    // 2. Wait for user response via shared pending-approval infrastructure.
    //    The IPC handler (agent:answer-tool-question) stores answers in
    //    pendingQuestionAnswers and resolves the approval promise.
    const approved = await registerPendingApproval(toolCallId, abortSignal ?? undefined);

    if (approved !== true) {
      debugLog(`[ASK_USER] User dismissed/rejected toolCallId=${toolCallId}`);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'User dismissed the question.' }) }],
        isError: true,
      };
    }

    // 3. Retrieve answers (stored by agent:answer-tool-question IPC handler)
    const answers = pendingQuestionAnswers.get(toolCallId);
    pendingQuestionAnswers.delete(toolCallId);

    debugLog(
      `[ASK_USER] Got answers toolCallId=${toolCallId} keys=${answers ? Object.keys(answers).join(',') : 'none'}`,
    );

    return {
      content: [{ type: 'text', text: JSON.stringify({ success: true, answers: answers ?? {} }) }],
    };
  };
}

/**
 * Create a tool handler for `exit_plan_mode` that gates execution behind
 * user approval.
 *
 * In the Mastra runtime, `agent.ts` intercepts `exit_plan_mode` via the
 * `onToolExecutionStart` hook and broadcasts `tool-approval-required` so the
 * user can review the plan before approving. This handler replicates that
 * flow for the SDK bridge:
 *
 * 1. Broadcasts `tool-approval-required` with the plan content
 * 2. Waits for user approval (approve / reject / dismiss)
 * 3. On approve: executes the tool (writes plan file, broadcasts mode change)
 * 4. On reject: returns an error telling Claude to keep planning
 * 5. On dismiss: returns an error indicating the plan was dismissed
 */
function createExitPlanModeHandler(
  toolDef: ToolDefinition,
  conversationId: string,
  cwd: string | undefined,
  abortSignal: AbortSignal | undefined,
): (args: unknown, extra: unknown) => Promise<CallToolResult> {
  return async (args: unknown): Promise<CallToolResult> => {
    const toolCallId = `sdk-plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    debugLog(`[EXIT_PLAN_MODE] Broadcasting plan approval request toolCallId=${toolCallId}`);

    // 1. Broadcast to renderer — shows plan review UI with approve/reject
    broadcastStreamEventRaw({
      conversationId,
      type: 'tool-approval-required',
      toolCallId,
      toolName: 'exit_plan_mode',
      args,
    });

    // 2. Wait for user approval
    const approved = await registerPendingApproval(toolCallId, abortSignal ?? undefined);

    if (approved === 'dismiss') {
      debugLog(`[EXIT_PLAN_MODE] User dismissed plan toolCallId=${toolCallId}`);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'User dismissed the plan. Exiting plan mode.' }) }],
        isError: true,
      };
    }

    if (approved !== true) {
      debugLog(`[EXIT_PLAN_MODE] User rejected plan toolCallId=${toolCallId}`);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error:
                "User rejected the plan. Continue planning — refine the approach based on the user's feedback and call exit_plan_mode again when ready.",
            }),
          },
        ],
        isError: true,
      };
    }

    // 3. Approved — execute the tool (writes plan file, broadcasts mode change)
    debugLog(`[EXIT_PLAN_MODE] User approved plan toolCallId=${toolCallId}`);
    const context: ToolExecutionContext = {
      toolCallId,
      conversationId,
      cwd,
      abortSignal,
    };

    try {
      const result = await toolDef.execute(args, context);
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  };
}
