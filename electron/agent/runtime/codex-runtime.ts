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
import { buildCodexMcpPrompt, buildCodexMcpServerConfig, CodexMcpBridge } from './codex-mcp-bridge.js';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join, sep } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Binary path resolution
// ---------------------------------------------------------------------------
//
// The SDK resolves the bundled Codex CLI via require.resolve() relative to
// import.meta.url. In a packaged app that URL is inside app.asar, so the
// resulting path is …/app.asar/node_modules/@openai/codex-<platform>-<arch>/…
// which spawn() rejects with ENOTDIR (app.asar is a file). Resolve the same
// path here, redirect it to app.asar.unpacked, and hand it to the SDK as
// codexPathOverride. Returns undefined in any case where the SDK's own
// resolver should be left to run (dev mode, unknown platform, missing pkg).

const CODEX_TARGET_TRIPLE: Partial<Record<NodeJS.Platform, Partial<Record<NodeJS.Architecture, string>>>> = {
  darwin: { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' },
  linux: { arm64: 'aarch64-unknown-linux-musl', x64: 'x86_64-unknown-linux-musl' },
  win32: { arm64: 'aarch64-pc-windows-msvc', x64: 'x86_64-pc-windows-msvc' },
};

const CODEX_PLATFORM_PACKAGE: Record<string, string> = {
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64',
  'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
};

function resolveCodexExecutable(): string | undefined {
  const triple = CODEX_TARGET_TRIPLE[process.platform]?.[process.arch];
  const platformPackage = triple ? CODEX_PLATFORM_PACKAGE[triple] : undefined;
  if (!triple || !platformPackage) return undefined;

  try {
    const req = createRequire(import.meta.url);
    const codexPkg = req.resolve('@openai/codex/package.json');
    const platformPkg = createRequire(codexPkg).resolve(`${platformPackage}/package.json`);
    const binName = process.platform === 'win32' ? 'codex.exe' : 'codex';
    let binaryPath = join(dirname(platformPkg), 'vendor', triple, 'codex', binName);

    const asarSegment = `${sep}app.asar${sep}`;
    if (binaryPath.includes(asarSegment)) {
      binaryPath = binaryPath.replace(asarSegment, `${sep}app.asar.unpacked${sep}`);
    }

    return existsSync(binaryPath) ? binaryPath : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

const CODEX_CAPABILITIES: RuntimeCapabilities = {
  builtInTools: true, // Codex has built-in shell, file editing, web search
  mcpSupport: true, // Codex supports MCP tool calls
  toolObserver: false, // Codex manages its own tool lifecycle
  compaction: false, // Codex manages context internally
  memory: false, // No Kai memory layer integration
  fallback: false, // No model fallback chain
  multiProvider: false, // OpenAI models only
  subAgents: false, // No sub-agent delegation
  sessions: true, // Thread resume via thread ID
  customTools: true, // Custom Kai tools via local MCP bridge
};

// ---------------------------------------------------------------------------
// Types for the dynamic SDK import (avoids hard compile-time dependency)
// ---------------------------------------------------------------------------

/** Minimal typing for Codex SDK classes we use. */
type CodexClass = new (options?: {
  apiKey?: string;
  baseUrl?: string;
  codexPathOverride?: string;
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
  resumeThread(
    id: string,
    options?: {
      model?: string;
      sandboxMode?: string;
      workingDirectory?: string;
      modelReasoningEffort?: string;
      approvalPolicy?: string;
      skipGitRepoCheck?: boolean;
    },
  ): ThreadInstance;
};

type CodexUserInput = { type: 'text'; text: string } | { type: 'local_image'; path: string };
type CodexInput = string | CodexUserInput[];

type ThreadInstance = {
  id: string | null;
  runStreamed(
    input: CodexInput,
    options?: { signal?: AbortSignal },
  ): Promise<{
    events: AsyncGenerator<ThreadEventAny>;
  }>;
  run(
    input: CodexInput,
    options?: { signal?: AbortSignal },
  ): Promise<{
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
    const { conversationId, config, tools, cwd, reasoningEffort, abortSignal, modelAuth } = options;

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
      suggest: 'on-request',
      'auto-edit': 'on-failure',
      'full-auto': 'never',
    };
    const approvalPolicy = approvalMap[(sdkConfig.approval as string) ?? 'suggest'] ?? 'on-request';

    // Map reasoning effort
    const effortMap: Record<string, string> = {
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
    };
    const modelEffort = effortMap[reasoningEffort ?? 'high'] ?? 'high';

    // Extract API key + base URL from modelAuth (pre-resolved by the IPC layer)
    // or fall back to scanning the provider config for an openai-compatible entry.
    const apiKey = modelAuth?.apiKey ?? extractOpenAiApiKey(config);
    const baseUrl = modelAuth?.baseUrl ?? undefined;

    // -----------------------------------------------------------------------
    // 3. Extract prompt from messages
    // -----------------------------------------------------------------------
    const { textPrompt, imagePaths, tempImageDir } = extractLastUserInput(options.messages);
    if (!textPrompt && imagePaths.length === 0) {
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

    const customTools = tools?.filter((t) => t.source === 'plugin' || t.source === 'skill' || t.source === 'mcp');

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
    // Pass the bridge bearer token to the Codex CLI via the SDK's `env`
    // option (scoped to the spawned child process) so the CLI can read it
    // via the `bearer_token_env_var` config key. The env var name is unique
    // per bridge instance, and using the SDK's env option instead of
    // mutating process.env avoids leaking the token to other child
    // processes and avoids races between concurrent Codex runs.
    const bridgeAuthToken = bridge.getAuthToken();
    const bridgeAuthTokenEnvVar = bridge.getAuthTokenEnvVar();
    const codexPathOverride = resolveCodexExecutable();

    // Declared before the try so the catch/retry handler below can still see
    // them; assigned inside the try so a throw during construction / thread
    // creation is caught and converted to an error+done event with cleanup,
    // rather than leaking the temp image dir + MCP bridge and throwing out of
    // the generator.
    let resumeId: string | undefined;
    let thread: ThreadInstance;
    let codex: InstanceType<CodexClass>;
    let threadOptions: Parameters<InstanceType<CodexClass>['startThread']>[0];

    // -----------------------------------------------------------------------
    // 5. Create Codex instance and thread, then stream + translate events
    // -----------------------------------------------------------------------
    try {
      codex = new CodexCtor({
        ...(codexPathOverride ? { codexPathOverride } : {}),
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        ...(bridgeAuthToken && bridgeAuthTokenEnvVar
          ? {
              // The SDK's `env` option replaces the child environment entirely,
              // so spread process.env and overlay only the bridge token —
              // otherwise the Codex CLI loses HOME/PATH/cert vars.
              env: {
                ...(process.env as Record<string, string>),
                [bridgeAuthTokenEnvVar]: bridgeAuthToken,
              },
            }
          : {}),
        ...(bridgeUrl
          ? {
              config: {
                features: {
                  tool_search_always_defer_mcp_tools: false,
                },
                mcp_servers: {
                  kai: buildCodexMcpServerConfig(bridgeUrl, customTools ?? [], bridgeAuthToken, bridgeAuthTokenEnvVar),
                },
              },
            }
          : {}),
      });

      threadOptions = {
        ...(modelAuth?.modelName ? { model: modelAuth.modelName } : {}),
        workingDirectory: cwd ?? process.cwd(),
        modelReasoningEffort: modelEffort,
        approvalPolicy,
        skipGitRepoCheck: true,
      };

      // Resume or start new thread.
      // `codexSdkThreadId` is written to conversation.metadata when the `thread.started`
      // enrichment event is persisted by the renderer — see RuntimeProvider applyEnrichments.
      // This makes context persist across both turns within a session and app restarts.
      resumeId =
        (options.conversationMetadata?.codexSdkThreadId as string | undefined) ??
        (sdkConfig.resumeThreadId as string | undefined) ??
        undefined;
      thread = resumeId ? codex.resumeThread(resumeId, threadOptions) : codex.startThread(threadOptions);

      // -----------------------------------------------------------------------
      // 6. Stream and translate events
      // -----------------------------------------------------------------------
      // Build the effective text (with MCP tool hints if needed)
      let effectiveText =
        bridgeUrl && customTools ? buildCodexMcpPrompt(textPrompt ?? '', customTools) : (textPrompt ?? '');

      // Inject prior context on runtime switch (Codex has no system prompt API)
      if (options.switchContext) {
        effectiveText = `${options.switchContext}\n\n${effectiveText}`;
      }

      // If there are images, use structured input; otherwise plain string
      const codexInput: CodexInput =
        imagePaths.length > 0
          ? [
              ...(effectiveText ? [{ type: 'text' as const, text: effectiveText }] : []),
              ...imagePaths.map((p) => ({ type: 'local_image' as const, path: p })),
            ]
          : effectiveText;

      const { events } = await thread.runStreamed(codexInput, {
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

      // If resume failed (thread expired/deleted), retry with a fresh thread
      const isThreadNotFound =
        resumeId &&
        err instanceof Error &&
        (err.message.includes('not found') ||
          err.message.includes('expired') ||
          err.message.includes('No thread') ||
          err.message.includes('invalid_thread'));

      if (isThreadNotFound) {
        console.warn(`[codex-runtime] Thread resume failed (id=${resumeId}), retrying with fresh thread`);
        try {
          const freshThread = codex!.startThread(threadOptions);

          const effectiveText =
            bridgeUrl && customTools ? buildCodexMcpPrompt(textPrompt ?? '', customTools) : (textPrompt ?? '');

          const codexInput: CodexInput =
            imagePaths.length > 0
              ? [
                  ...(effectiveText ? [{ type: 'text' as const, text: effectiveText }] : []),
                  ...imagePaths.map((p) => ({ type: 'local_image' as const, path: p })),
                ]
              : effectiveText;

          const { events: retryEvents } = await freshThread.runStreamed(codexInput, {
            signal: abortSignal,
          });

          for await (const event of retryEvents) {
            if (abortSignal?.aborted) break;

            const translated = translateCodexEvent(conversationId, event);
            for (const evt of translated) {
              yield evt;
            }
          }

          yield { conversationId, type: 'done' };
        } catch (retryErr) {
          if (abortSignal?.aborted) {
            yield { conversationId, type: 'done' };
            return;
          }
          yield {
            conversationId,
            type: 'error',
            error: retryErr instanceof Error ? retryErr.message : String(retryErr),
          };
          yield { conversationId, type: 'done' };
        }
        return;
      }

      yield {
        conversationId,
        type: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
      yield { conversationId, type: 'done' };
    } finally {
      if (tempImageDir) {
        try {
          rmSync(tempImageDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
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

  async generateTitle(_messages: unknown[], _config: AppConfig): Promise<string | null> {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helper: Extract the last user prompt and any image attachments
// ---------------------------------------------------------------------------

/**
 * Extract the last user message as a text prompt + temp file paths for images.
 * The Codex SDK accepts `local_image` inputs via file path, so we write each
 * base64 data URL to a temp file and return the paths. The caller is
 * responsible for deleting them after the stream completes.
 */
function extractLastUserInput(messages: unknown[]): {
  textPrompt: string | null;
  imagePaths: string[];
  tempImageDir: string | null;
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: unknown } | undefined;
    if (!msg || msg.role !== 'user') continue;

    if (typeof msg.content === 'string') {
      return { textPrompt: msg.content, imagePaths: [], tempImageDir: null };
    }

    if (Array.isArray(msg.content)) {
      let textPrompt: string | null = null;
      const imagePaths: string[] = [];
      let tempImageDir: string | null = null;

      try {
        for (const p of msg.content as Array<{ type?: string; text?: string; image?: string; mimeType?: string }>) {
          if (p.type === 'text' && p.text) {
            textPrompt = (textPrompt ?? '') + (textPrompt ? '\n' : '') + p.text;
            continue;
          }

          if (p.type === 'image' && p.image) {
            // Parse data URL: "data:<mime>;base64,<data>"
            const dataUrl = p.image;
            const commaIdx = dataUrl.indexOf(',');
            if (commaIdx === -1) continue;

            const header = dataUrl.slice(0, commaIdx);
            const base64Data = dataUrl.slice(commaIdx + 1);
            const mimeMatch = header.match(/data:([^;]+)/);
            const mime = mimeMatch ? mimeMatch[1] : (p.mimeType ?? 'image/png');
            const ext = mime.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';

            // Write to a per-turn temp directory — Codex SDK requires local paths.
            tempImageDir ??= mkdtempSync(join(tmpdir(), 'kai-codex-images-'));
            const tmpPath = join(tempImageDir, `img-${imagePaths.length}.${ext}`);
            writeFileSync(tmpPath, Buffer.from(base64Data, 'base64'));
            imagePaths.push(tmpPath);
          }
        }
      } catch (error) {
        if (tempImageDir) {
          try {
            rmSync(tempImageDir, { recursive: true, force: true });
          } catch {
            /* best-effort */
          }
        }
        throw error;
      }

      if (textPrompt !== null || imagePaths.length > 0) {
        return { textPrompt, imagePaths, tempImageDir };
      }
    }
  }
  return { textPrompt: null, imagePaths: [], tempImageDir: null };
}

// ---------------------------------------------------------------------------
// Helper: Extract OpenAI API key from config
// ---------------------------------------------------------------------------

function extractOpenAiApiKey(config: AppConfig): string | undefined {
  const providers = (config as Record<string, unknown>).models as Record<string, unknown> | undefined;
  const providerMap = (providers?.providers ?? {}) as Record<
    string,
    { type?: string; apiKey?: string; enabled?: boolean }
  >;

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
          data: { codexSdkThreadId: event.thread_id },
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
            const summary = item.changes.map((c) => `${c.kind}: ${c.path}`).join('\n');
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
            const resultText =
              item.result?.content
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
