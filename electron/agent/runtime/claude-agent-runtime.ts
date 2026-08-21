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
 *   - Permissions: the SDK runs in `bypassPermissions` mode. IMPORTANT trust
 *     boundary — the SDK's BUILT-IN tools (Read/Write/Edit/Bash/Glob/Grep/
 *     WebFetch/etc., see the `tools:` list below) execute INSIDE the Claude Code
 *     subprocess and are NOT routed through Kai's per-tool approval (`execute()`
 *     / the tool-approval UX). Only Kai's own MCP-bridged custom tools go through
 *     Kai gating. `confinedCwd` sets the subprocess CWD but is NOT a sandbox —
 *     the built-in tools can still reach paths outside it. Choosing the
 *     claude-agent-sdk runtime therefore grants the model direct filesystem/exec
 *     authority; this is an accepted, deliberate posture (Kai defers permission
 *     UX to the SDK for this runtime), not an oversight.
 *   - Session resume supported via `resume` / `sessionId` options
 */

import type { AgentRuntime, RuntimeCapabilities, StreamOptions, StreamEvent } from './types.js';
import { detectClaudeAgentSdk, resolveClaudeCliPath } from './detect.js';
import type { AppConfig } from '../../config/schema.js';
import type { ToolDefinition, ToolExecutionContext } from '../../tools/types.js';
import { buildMcpToolContent } from '../tool-model-content.js';
import { MAX_TOOL_NAME_LENGTH } from '../../tools/naming.js';
import { resolveStreamConfig } from '../model-catalog.js';
import { withWorkingDirectoryPrompt } from '../instructions.js';
import { registerPendingApproval, broadcastStreamEventRaw } from '../../ipc/tool-approval.js';
import type { ApprovalSettleSource } from '../../ipc/tool-approval.js';
import {
  pendingQuestionAnswers,
  getAskUserRecoveryRouter,
  getActiveStreamTokenForConversation,
  makeAnswerKey,
} from '../../tools/ask-user.js';
import { appendFileSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { homedir } from 'os';
import type { z } from 'zod';
import { redactBrowserToolErrorForExposure } from '../../../shared/browser.js';
import { executeToolWithLifecycleHooks } from '../hooks/tool-lifecycle.js';

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
function buildScrubbedClaudeEnv(
  auth: { apiKey?: string; baseUrl?: string } | null,
  /** When the IPC chokepoint pre-built a fail-closed childEnv (#71), use it as
   *  the base instead of scrubbing process.env here. Auth vars are still overlaid
   *  after so the CLI can authenticate. */
  baseEnv?: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (baseEnv) {
    for (const [key, value] of Object.entries(baseEnv)) {
      if (value !== undefined) out[key] = value;
    }
  } else {
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (CLAUDE_ENV_SECRET_DENYLIST.some((pat) => claudeEnvKeyMatches(key, pat))) continue;
      out[key] = value;
    }
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

/** Diagnostics must describe SDK payload structure without copying payload
 * content. Browser tools can carry typed passwords, scripts, authenticated
 * URLs, and page text through any SDK message field. */
function diagnosticValueShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(length=${value.length})`;
  if (typeof value === 'string') return `string(length=${value.length})`;
  if (typeof value === 'object') return `object(fields=${Object.keys(value).length})`;
  return typeof value;
}

function diagnosticErrorShape(error: unknown): string {
  if (!(error instanceof Error)) return diagnosticValueShape(error);
  return `error(messageLength=${error.message.length},stackLength=${error.stack?.length ?? 0})`;
}

function diagnosticSdkMessageShape(msg: SdkMessageAny): string {
  const event = msg.event as { content_block?: unknown; delta?: unknown } | undefined;
  const message = msg.message as { content?: unknown } | undefined;
  return [
    `type=${diagnosticValueShape(msg.type)}`,
    `subtype=${diagnosticValueShape(msg.subtype)}`,
    `fields=${Object.keys(msg).length}`,
    `event=${diagnosticValueShape(event)}`,
    `content=${diagnosticValueShape(message?.content)}`,
    `result=${diagnosticValueShape(msg.result)}`,
    `structuredOutput=${diagnosticValueShape(msg.structured_output)}`,
  ].join(' ');
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
  executesUntrustedTools: true, // SDK subprocess runs Bash/Write unsupervised
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
            debugLog(
              `[BRIDGE] Collision-resolved tool name lengths source=${t.name.length} resolved=${safeName.length}`,
            );
          }
          usedNames.add(safeName);
          if (safeName !== t.name) {
            debugLog(`[BRIDGE] Truncated tool name lengths source=${t.name.length} resolved=${safeName.length}`);
          }
          const rawShape = extractZodShape(t.inputSchema);
          return sdkTool(
            safeName,
            t.description ?? '',
            rawShape,
            createToolHandler(t, conversationId, cwd, abortSignal, options.browserOwnerId),
          );
        });

        const kaiServer = sdkCreateMcpServer({
          name: 'kai',
          version: '1.0.0',
          tools: sdkTools,
        });

        mcpServers = { kai: kaiServer };
        debugLog(`[BRIDGE] Created MCP bridge toolCount=${sdkTools.length}`);
      } catch (bridgeErr) {
        debugLog(`[BRIDGE] Failed to create MCP bridge error=${diagnosticErrorShape(bridgeErr)}`);
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
        debugLog(`[SESSION] Seeding sessionMap from persisted metadata sessionIdLength=${persistedSessionId.length}`);
        this.sessionMap.set(conversationId, persistedSessionId);
      }
      existingSessionId = this.sessionMap.get(conversationId);
    }

    // Use pre-resolved auth from the model-runtime compatibility layer.
    // This ensures Kai is always in control of which model + endpoint is used,
    // rather than silently falling back to ~/.claude/settings.json.
    const auth = options.modelAuth ?? null;

    debugLog(`[STREAM] prompt=${diagnosticValueShape(prompt)} hasImages=${hasImages}`);
    debugLog(`[STREAM] hasExistingSession=${existingSessionId !== undefined} sessionMapSize=${this.sessionMap.size}`);
    debugLog(
      `[STREAM] hasCwd=${cwd !== undefined} maxTurns=${maxTurns} hasEffort=${effort !== undefined} permissionBypass=${permissionMode === 'bypassPermissions'} hasModel=${auth?.modelName !== undefined} hasBaseUrl=${auth?.baseUrl !== undefined}`,
    );

    const sdkOptions: SdkOptions = {
      abortController,
      // Default to homedir when no working directory is set. Using process.cwd()
      // would point at the kai-desktop source tree, causing the Claude Code
      // subprocess to walk up and load kai-desktop's CLAUDE.md + AGENTS.md
      // (~5.8 KB / ~1400 tokens) on every request.
      cwd: options.confinedCwd ?? cwd ?? homedir(),
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
      env: buildScrubbedClaudeEnv(auth, options.childEnv),
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
      debugLog(`[QUERY] Starting query hasResume=${existingSessionId !== undefined}`);
      const queryIter = sdkQuery({ prompt, options: sdkOptions });

      let msgCount = 0;
      for await (const msg of queryIter) {
        if (abortSignal?.aborted) {
          debugLog(`[QUERY] Aborted after ${msgCount} messages`);
          break;
        }

        msgCount++;
        debugLog(`[MSG ${msgCount}] ${diagnosticSdkMessageShape(msg)}`);

        // Detect session resume failure — retry without resume
        if (
          existingSessionId &&
          msg.type === 'result' &&
          msg.subtype === 'error_during_execution' &&
          msgCount <= 2 // Error on first real message = resume failed
        ) {
          const rawStr = JSON.stringify(msg);
          if (rawStr.includes('No conversation found with session ID')) {
            debugLog(`[SESSION] Resume failed; retrying without resume`);
            this.sessionMap.delete(conversationId);
            retryWithoutResume = true;
            break;
          }
        }

        // Capture session ID for future resume within this conversation
        const msgSessionId = (msg as { session_id?: string }).session_id;
        if (msgSessionId && !this.sessionMap.has(conversationId)) {
          debugLog(`[SESSION] Captured session id length=${msgSessionId.length}`);
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
      debugLog(`[ERROR] ${diagnosticErrorShape(err)}`);

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
      debugLog(`[RETRY] Retrying without resume`);
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
          debugLog(`[RETRY-MSG ${msgCount}] ${diagnosticSdkMessageShape(msg)}`);

          // Capture new session ID
          const msgSessionId = (msg as { session_id?: string }).session_id;
          if (msgSessionId && !this.sessionMap.has(conversationId)) {
            debugLog(`[SESSION] Captured new session id length=${msgSessionId.length}`);
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
        debugLog(`[RETRY-ERROR] ${diagnosticErrorShape(retryErr)}`);
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

// enter_plan_mode interception (agent.ts) matches on toolName. Record tool_use_id → name at the
// tool-CALL block so the result event can be stamped with the real name (R138 f-4) — otherwise
// an SDK enter_plan_mode never triggers the plan-first restart and the query keeps its mutating
// tools. Bounded: tool_use_ids are unique + short-lived (one turn); evict oldest.
const sdkToolNameById = new Map<string, string>();
const SDK_TOOL_NAME_MAP_MAX = 500;
function recordSdkToolName(toolUseId: string, name: string): void {
  sdkToolNameById.set(toolUseId, name);
  while (sdkToolNameById.size > SDK_TOOL_NAME_MAP_MAX) {
    const oldest = sdkToolNameById.keys().next().value;
    if (oldest === undefined) break;
    sdkToolNameById.delete(oldest);
  }
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
        debugLog(`[STREAM_EVENT] No event field messageFieldCount=${Object.keys(msg).length}`);
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
        const toolCallId = (block.id as string) ?? `tool-${Date.now()}`;
        const toolName = normalizeToolName((block.name as string) ?? 'unknown');
        // Record id → name so the later `user`-message tool_result block (which carries no name)
        // can be stamped with the real tool name (R138 f-4).
        if (block.id) recordSdkToolName(block.id as string, toolName);
        events.push({
          conversationId,
          type: 'tool-call',
          toolCallId,
          toolName,
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
        debugLog(`[ASSISTANT] No content messageFieldCount=${Object.keys(msg).length}`);
        break;
      }

      debugLog(`[ASSISTANT] blockCount=${betaMessage.content.length}`);

      for (const block of betaMessage.content) {
        if (block.type === 'tool_use') {
          // Complete tool call from assistant message
          const toolName = normalizeToolName(block.name ?? 'unknown');
          if (block.id) recordSdkToolName(block.id, toolName);
          events.push({
            conversationId,
            type: 'tool-call',
            toolCallId: block.id ?? `tool-${Date.now()}`,
            toolName,
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
        `[RESULT] subtype=${diagnosticValueShape(msg.subtype)} result=${diagnosticValueShape(msg.result)} structuredOutput=${diagnosticValueShape(msg.structured_output)}`,
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
            `[TOOL_RESULT] toolUseIdLength=${block.tool_use_id.length} isError=${isError} result=${diagnosticValueShape(resultText)}`,
          );

          events.push({
            conversationId,
            type: 'tool-result',
            toolCallId: block.tool_use_id,
            toolName: sdkToolNameById.get(block.tool_use_id) ?? '', // stamped from the tool-CALL block (R138 f-4)
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
        `[TRANSLATE-SKIP] Unhandled message type=${diagnosticValueShape(msg.type)} subtype=${diagnosticValueShape(msg.subtype)} fieldCount=${Object.keys(msg).length}`,
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
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | { type: 'resource'; resource: { blob: string; mimeType: string; uri: string } }
  >;
  isError?: boolean;
};

type ClaudeToolExecutionContext = ToolExecutionContext & {
  conversationId: string;
  /** The OWNING run's stream token, captured at handler creation (bound to THIS run). Lets the
   *  ask_user path classify an abort-driven recovery as terminal (Stop/dismiss) vs recoverable
   *  supersession (R95/R100 f-6) without re-reading activeStreams (which may be torn down). */
  owningStreamToken?: string;
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
  browserOwnerId: string | undefined,
): (args: unknown, extra: unknown) => Promise<CallToolResult> {
  // Bind the owning run's stream token at creation (NOT re-read later): a post-Stop queued callback
  // must still classify correctly even after activeStreams is torn down (R100 f-6).
  const owningStreamToken = getActiveStreamTokenForConversation(conversationId);
  // Approval-backed special tools stay inside this wrapper so lifecycle hooks
  // can deny or rewrite their input and sanitize their result.
  return async (args: unknown): Promise<CallToolResult> => {
    // If THIS run was already aborted (superseded / Stopped) before a queued callback fires, do NOT
    // execute enter_plan_mode (R144 f-1): it would persist plan-first but never emit the result
    // MAIN's mid-stream interception needs to restart, so the SUCCESSOR run continues with its
    // mutating tool set while disk/UI show Plan-First. The turn is over — refuse.
    if (toolDef.name === 'enter_plan_mode' && abortSignal?.aborted) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'The turn was stopped.' }) }],
        isError: true,
      };
    }
    const toolCallPrefix =
      toolDef.name === 'ask_user' ? 'sdk-ask' : toolDef.name === 'exit_plan_mode' ? 'sdk-plan' : 'sdk-bridge';
    const toolCallId = `${toolCallPrefix}-${randomUUID()}`;
    const context: ClaudeToolExecutionContext = {
      toolCallId,
      conversationId,
      browserOwnerId,
      cwd,
      abortSignal,
      owningStreamToken,
      // The SDK runtime IS a gateable plan-mode context: enter_plan_mode restarts via MAIN's
      // name-stamped mid-stream interception (R139) and exit_plan_mode is gated below. So the plan
      // tools may execute here (R141).
      planModeGateable: true,
    };

    try {
      const result = await executeToolWithLifecycleHooks({
        conversationId,
        toolCallId,
        toolName: toolDef.name,
        args,
        validate: (candidate) => {
          const safeParse = (
            toolDef.inputSchema as { safeParse?: (value: unknown) => { success: boolean; data?: unknown } }
          ).safeParse;
          if (typeof safeParse !== 'function') return candidate;
          const parsed = safeParse.call(toolDef.inputSchema, candidate);
          if (!parsed.success) throw new Error(`Invalid arguments for tool "${toolDef.name}".`);
          return parsed.data;
        },
        execute: (validatedArgs) => {
          if (toolDef.name === 'ask_user') return executeAskUserTool(validatedArgs, context);
          if (toolDef.name === 'exit_plan_mode') return executeExitPlanModeTool(toolDef, validatedArgs, context);
          return toolDef.execute(validatedArgs, context);
        },
      });
      // Surface an error-shaped tool result as a tool error, not a success.
      const resultIsError =
        !!result &&
        typeof result === 'object' &&
        ((result as { isError?: unknown }).isError === true ||
          (typeof (result as { error?: unknown }).error === 'string' &&
            (result as { error: string }).error.length > 0));

      // Peel off any model-visible media (images / files) into native MCP
      // content blocks (shared helper — unique resource URIs, size caps).
      const content = buildMcpToolContent(result);
      return { content, ...(resultIsError ? { isError: true } : {}) };
    } catch (err) {
      return {
        content: [{ type: 'text', text: redactBrowserToolErrorForExposure(toolDef.name, err) }],
        isError: true,
      };
    }
  };
}

/**
 * Execute `ask_user` after schema validation and PreToolUse have produced the
 * effective question. Its raw answer then passes through PostToolUse.
 *
 * 1. Broadcasts `tool-approval-required` to the renderer (shows question UI)
 * 2. Registers a pending approval and awaits the user's response
 * 3. Retrieves answers from the shared `pendingQuestionAnswers` map
 * 4. Returns the answers as the MCP tool result
 *
 * The renderer doesn't need changes — it already handles `tool-approval-required`
 * events and sends answers via `agent:answer-tool-question` IPC.
 */
async function executeAskUserTool(args: unknown, context: ClaudeToolExecutionContext): Promise<unknown> {
  const { toolCallId, conversationId, abortSignal, browserOwnerId, owningStreamToken } = context;

  // Reject a callback that fires AFTER this run was already aborted/stopped (R100 f-6): the SDK may
  // invoke a queued tool callback post-abort, which would broadcast a stale question card and record
  // a post-Stop recovery tombstone a later answer could use to resurrect the stopped conversation.
  // Bail before any broadcast/stash.
  if (abortSignal?.aborted) {
    return { error: 'The turn was stopped before this question ran.' };
  }

  debugLog(`[ASK_USER] Broadcasting question toolCallIdLength=${toolCallId.length}`);

  // Capture the CATEGORICAL settle source (R94): abort resolves with the same 'dismiss' VALUE as a
  // real user dismiss, so only onSettle can tell a recoverable abort (turn torn down mid-answer)
  // apart from a deliberate reject/dismiss (user said no — must NOT be resurrected).
  let settleSource: ApprovalSettleSource | undefined;
  // Register before broadcasting so a synchronous response cannot beat the
  // waiter, and so a dedicated pop-out can be bound to this exact request.
  const approvalDecision = registerPendingApproval(
    toolCallId,
    abortSignal ?? undefined,
    'any-renderer',
    { conversationId, browserOwnerId },
    {
      conversationId,
      toolName: 'ask_user',
      onSettle: (source) => {
        settleSource = source;
      },
    },
  );

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
  const approved = await approvalDecision;

  if (approved !== true) {
    // Route the durable recovered-answer path ONLY for a genuine ABORT (turn superseded / torn down
    // while an answer raced in). A deliberate reject/dismiss means the user declined THIS question —
    // resurrecting a late answer would override that, and on explicit Stop the cancel-generation
    // bump could let a stale surface's answer restart a stopped turn. (R93 routing; R94 abort-scope.)
    debugLog(`[ASK_USER] settled non-approve toolCallId=${toolCallId} source=${settleSource ?? 'unknown'}`);
    if (settleSource === 'abort') {
      try {
        // Recovery is keyed by the run-scoped answerKey (R191 conversation + R249 run), matching how
        // agent:answer-tool-question stashes the answer (R250: include this run's browserOwnerId nonce).
        getAskUserRecoveryRouter()?.(
          conversationId,
          makeAnswerKey(conversationId, toolCallId, browserOwnerId),
          owningStreamToken,
        );
      } catch {
        /* best-effort — the bounded stash copy remains as the last resort */
      }
    }
    return { error: 'User dismissed the question.' };
  }

  // 3. Retrieve answers (stored by agent:answer-tool-question IPC handler under the run-scoped answerKey —
  //    R191 conversation + R249 run). The run nonce is this run's browserOwnerId (the SAME value passed to
  //    registerPendingApproval above), so the handler's stash key and this read key agree (R250).
  const answerKey = makeAnswerKey(conversationId, toolCallId, browserOwnerId);
  const answers =
    pendingQuestionAnswers.get(answerKey) ?? pendingQuestionAnswers.get(makeAnswerKey(conversationId, toolCallId));
  pendingQuestionAnswers.delete(answerKey);
  pendingQuestionAnswers.delete(makeAnswerKey(conversationId, toolCallId));

  debugLog(`[ASK_USER] Got answers answerCount=${answers ? Object.keys(answers).length : 0}`);

  return { success: true, answers: answers ?? {} };
}

/**
 * Execute `exit_plan_mode` after schema validation and PreToolUse have
 * produced the effective plan, then gate it behind user approval.
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
async function executeExitPlanModeTool(
  toolDef: ToolDefinition,
  args: unknown,
  context: ClaudeToolExecutionContext,
): Promise<unknown> {
  const { toolCallId, conversationId, abortSignal, browserOwnerId } = context;

  // If THIS run was already aborted (a superseding GUI/CLI run replaced it) before the queued
  // exit_plan_mode callback fires, do NOT broadcast an approval request (R128 f-3). The broadcast is
  // UNTAGGED (no owning stream token), so the renderer would apply it to the SUCCESSOR run — wedging
  // it at 'awaiting-approval' with no pending approval to resolve. Bail before broadcasting.
  if (abortSignal?.aborted) {
    return { error: 'The turn was stopped before the plan could be reviewed.' };
  }

  debugLog(`[EXIT_PLAN_MODE] Broadcasting plan approval request toolCallIdLength=${toolCallId.length}`);

  const approvalDecision = registerPendingApproval(
    toolCallId,
    abortSignal ?? undefined,
    'any-renderer',
    { conversationId, browserOwnerId },
    { conversationId, toolName: 'exit_plan_mode' },
  );

  // 1. Broadcast to renderer — shows plan review UI with approve/reject
  broadcastStreamEventRaw({
    conversationId,
    type: 'tool-approval-required',
    toolCallId,
    toolName: 'exit_plan_mode',
    args,
  });

  // 2. Wait for user approval
  const approved = await approvalDecision;

  if (approved === 'dismiss') {
    debugLog(`[EXIT_PLAN_MODE] User dismissed plan`);
    return { error: 'User dismissed the plan. Exiting plan mode.' };
  }

  if (approved !== true) {
    debugLog(`[EXIT_PLAN_MODE] User rejected plan`);
    return {
      error:
        "User rejected the plan. Continue planning — refine the approach based on the user's feedback and call exit_plan_mode again when ready.",
    };
  }

  // 3. Approved — execute the tool (writes plan file, broadcasts mode change)
  debugLog(`[EXIT_PLAN_MODE] User approved plan`);
  return toolDef.execute(args, context);
}
