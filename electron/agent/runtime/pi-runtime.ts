/**
 * pi coding-agent runtime adapter.
 *
 * Unlike the Claude/Codex runtimes (which wrap an official "drive-the-CLI" SDK),
 * pi has no such SDK — its own CLI exposes a headless JSON mode. We therefore
 * spawn the `pi` binary directly, one process per turn:
 *
 *     pi --mode json --session-id <id> [--provider/--model …] [--exclude-tools …]
 *
 * pi reads the prompt from piped stdin, then emits a JSONL stream on stdout: a
 * header line followed by one JSON object per session event. Those events are
 * pi's `AgentSessionEvent` union (embedding `AgentEvent` + `AssistantMessageEvent`),
 * which we translate to Kai's `StreamEvent` format.
 *
 * Design notes (see plan + security review):
 *   - Prompt via stdin, NOT argv: pi treats a leading `@` as a file-read and a
 *     leading `-` as a flag, and has no `--` separator.
 *   - API key via the provider-specific env var, NEVER on argv (argv is visible
 *     via `ps`). pi has no generic key env var.
 *   - Session continuity via a Kai-owned id passed as `--session-id` (idempotent
 *     create-or-open in pi); no need to scrape pi's stdout header.
 *   - pi has no per-tool approval hook in any headless mode, so it runs bash +
 *     file edits unsupervised. The Kai approval mode maps to spawn-time tool
 *     scoping (the only gate available).
 *   - pi only drives models in its own registry at their official endpoints (no
 *     `--base-url`), so Kai's custom-endpoint models are unmappable — we then
 *     let pi use its own configured default and surface a one-line note.
 *   - No MCP: Kai skill/plugin/custom tools cannot be bridged.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { AgentRuntime, RuntimeCapabilities, StreamOptions, StreamEvent } from './types.js';
import { detectPiCli, resolvePiCliPath } from './detect.js';
import type { AppConfig } from '../../config/schema.js';
import type { ModelCatalogEntry } from '../model-catalog.js';
import { getResolvedProcessEnv } from '../../utils/shell-env.js';

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

const PI_CAPABILITIES: RuntimeCapabilities = {
  builtInTools: true, // pi has built-in bash, read, write, edit, grep, find, ls
  mcpSupport: false, // pi has no MCP client
  toolObserver: false, // pi manages its own tool lifecycle
  compaction: false, // pi manages context internally
  memory: false, // no Kai memory layer integration
  fallback: false, // pi has no model fallback-chain flag
  multiProvider: true, // pi-ai is multi-provider (mapped where reachable)
  subAgents: false, // no sub-agent delegation
  sessions: true, // session resume via --session-id
  customTools: false, // no MCP bridge possible — Kai custom tools unavailable
  perActionApproval: false, // pi has NO per-tool hook in headless mode — runs unsupervised
};

// Guard against pathological/garbage output on stdout.
const MAX_LINE_BYTES = 1024 * 1024; // 1 MiB per line
const MAX_TOTAL_BYTES = 64 * 1024 * 1024; // 64 MiB aggregate ceiling per turn
const STDERR_CAP = 64 * 1024;

// pi's accepted --thinking levels; anything else is dropped rather than passed
// through (defense-in-depth against an upstream reasoning-effort enum widening).
const PI_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

// ---------------------------------------------------------------------------
// Loose typings for pi's JSON event stream (avoids any compile-time pi dep)
// ---------------------------------------------------------------------------

type PiAssistantMessageEvent = {
  type?: string;
  delta?: string;
};

type PiUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  input_tokens?: number;
  output_tokens?: number;
};

type PiEvent = {
  type?: string;
  // message_update carries streaming assistant deltas
  assistantMessageEvent?: PiAssistantMessageEvent;
  // tool_execution_* events
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  // turn_end / message events
  message?: { usage?: PiUsage; stopReason?: string; errorMessage?: string } & Record<string, unknown>;
  [k: string]: unknown;
};

type PiModelMapping = {
  args: string[];
  env: Record<string, string>;
  unmappableReason?: string;
};

// ---------------------------------------------------------------------------
// Runtime implementation
// ---------------------------------------------------------------------------

export class PiRuntime implements AgentRuntime {
  readonly id = 'pi' as const;
  readonly name = 'Pi';
  readonly capabilities = PI_CAPABILITIES;

  async isAvailable(): Promise<boolean> {
    return detectPiCli();
  }

  async *stream(options: StreamOptions): AsyncGenerator<StreamEvent> {
    const { conversationId, config, cwd, reasoningEffort, abortSignal, appHome, primaryModel, conversationMetadata } =
      options;

    // -----------------------------------------------------------------------
    // 1. Resolve the pi binary on PATH
    // -----------------------------------------------------------------------
    const piPath = await resolvePiCliPath();
    if (!piPath) {
      yield {
        conversationId,
        type: 'text-delta',
        text: 'The pi CLI was not found on your PATH. Install it with `npm i -g @earendil-works/pi-coding-agent`, then reopen this chat.',
      };
      yield { conversationId, type: 'done' };
      return;
    }

    // -----------------------------------------------------------------------
    // 2. Extract the prompt (text only — images are out of scope for v1)
    // -----------------------------------------------------------------------
    let promptText = extractLastUserText(options.messages);
    if (!promptText) {
      yield { conversationId, type: 'text-delta', text: 'No user message found to send to pi.' };
      yield { conversationId, type: 'done' };
      return;
    }

    // On a cross-runtime switch, pi has no prior session: prepend the context.
    if (options.switchContext) {
      promptText = `${options.switchContext}\n\n${promptText}`;
    }

    // -----------------------------------------------------------------------
    // 3. Session id (Kai-owned; idempotent create-or-open in pi)
    // -----------------------------------------------------------------------
    const piSessionId = (conversationMetadata?.piSessionId as string | undefined) ?? randomUUID();

    // Persist the id on the conversation so the next turn resumes the session.
    yield { conversationId, type: 'enrichment', data: { piSessionId } };

    // -----------------------------------------------------------------------
    // 4. Build args + env
    // -----------------------------------------------------------------------
    const agentConfig = (config as Record<string, unknown>).agent as Record<string, unknown> | undefined;
    const piConfig = (agentConfig?.piSdk ?? {}) as Record<string, unknown>;

    const args: string[] = ['--mode', 'json'];

    // Model / provider mapping (or fallback to pi's own default).
    const mapping = buildPiModelArgs(primaryModel);
    args.push(...mapping.args);

    // Tool scoping from the Kai approval mode (pi has no mid-stream gating).
    args.push(...buildToolScopingArgs(piConfig));

    // Reasoning effort → pi --thinking. Only forward values pi actually accepts.
    if (reasoningEffort && PI_THINKING_LEVELS.has(reasoningEffort)) {
      args.push('--thinking', reasoningEffort);
    }

    // Session: Kai-owned id + a pi session dir under ~/.kai. Do NOT combine with
    // --continue/--resume/--session/--fork (pi rejects the combination).
    args.push('--session-id', piSessionId);
    args.push('--session-dir', join(appHome, 'pi-sessions'));

    // Env: inherit Kai's resolved PATH/env, plus the provider-specific API key
    // (never on argv). We never log this object.
    const env: NodeJS.ProcessEnv = { ...getResolvedProcessEnv(), ...mapping.env };

    // -----------------------------------------------------------------------
    // 5. Spawn + stream
    // -----------------------------------------------------------------------
    if (mapping.unmappableReason) {
      yield {
        conversationId,
        type: 'text-delta',
        text:
          `> Note: the pi runtime only drives models from its own known providers at their ` +
          `official endpoints (no custom-endpoint support). Your selected model ` +
          `"${primaryModel?.displayName ?? 'current model'}" uses a configuration pi can't target ` +
          `(${mapping.unmappableReason}), so pi is using its own configured default model. Pick a ` +
          `first-party Anthropic/OpenAI/Google/Bedrock model, set a default in ~/.pi, or switch to ` +
          `the Claude/Codex runtime for this model.\n\n`,
      };
    }

    const child = spawn(piPath, args, {
      cwd: cwd || process.cwd(),
      env,
      shell: false,
      detached: process.platform !== 'win32', // own process group → reap bash grandchildren
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    let spawnError: NodeJS.ErrnoException | undefined;
    let stderrBuf = '';
    let exitCode: number | null = null;
    let errorYielded = false;

    child.on('error', (err) => {
      spawnError = err as NodeJS.ErrnoException;
    });
    // Writing the prompt to a child that has already exited (e.g. an abort
    // landed during spawn) emits an async EPIPE 'error' on stdin that a
    // synchronous try/catch can't catch — swallow it to avoid an unhandled error.
    child.stdin.on('error', () => {});
    child.stderr.on('data', (d: Buffer) => {
      if (stderrBuf.length < STDERR_CAP) stderrBuf += d.toString('utf8');
    });
    const exited = new Promise<void>((resolve) => {
      child.on('close', (code) => {
        exitCode = code;
        resolve();
      });
    });

    const onAbort = () => {
      killProcessGroup(child);
      // Unblock the `for await (… of child.stdout)` loop even when the child has
      // emitted nothing yet — otherwise an abort against a hung, silent child
      // would never reach the `finally` that reaps it.
      child.stdout.destroy();
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    // If the signal was already aborted before we attached (abort landed during
    // spawn), `{ once: true }` won't fire — reap immediately.
    if (abortSignal?.aborted) onAbort();

    // Send the prompt via stdin, then close it so pi runs single-shot.
    try {
      child.stdin.write(promptText);
      child.stdin.end();
    } catch {
      /* if the process already failed to spawn, the error path below handles it */
    }

    try {
      let buf = '';
      let totalBytes = 0;
      for await (const chunk of child.stdout) {
        if (abortSignal?.aborted) break;
        const bytes = chunk as Buffer;
        totalBytes += bytes.length;
        if (totalBytes > MAX_TOTAL_BYTES) {
          errorYielded = true;
          killProcessGroup(child);
          yield {
            conversationId,
            type: 'error',
            error: 'pi produced an excessive amount of output; the stream was stopped.',
          };
          break;
        }
        buf += bytes.toString('utf8');
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const trimmed = line.trim();
          if (!trimmed || trimmed.length > MAX_LINE_BYTES) continue;
          let parsed: PiEvent;
          try {
            parsed = JSON.parse(trimmed) as PiEvent;
          } catch {
            continue; // skip non-JSON / partial garbage
          }
          for (const evt of translatePiEvent(conversationId, parsed)) yield evt;
        }
      }
      // Flush any trailing line without a newline.
      const tail = buf.trim();
      if (!abortSignal?.aborted && tail && tail.length <= MAX_LINE_BYTES) {
        try {
          for (const evt of translatePiEvent(conversationId, JSON.parse(tail) as PiEvent)) yield evt;
        } catch {
          /* ignore */
        }
      }

      await exited;

      if (spawnError) {
        errorYielded = true;
        yield {
          conversationId,
          type: 'error',
          error:
            spawnError.code === 'ENOENT'
              ? `pi CLI could not be launched (not found at ${piPath}). Reinstall with \`npm i -g @earendil-works/pi-coding-agent\`.`
              : `pi CLI failed to start: ${spawnError.message}`,
        };
      } else if (!abortSignal?.aborted && exitCode && exitCode !== 0) {
        errorYielded = true;
        yield {
          conversationId,
          type: 'error',
          error: stderrBuf.trim() || `pi exited with code ${exitCode}`,
        };
      }
    } catch (err) {
      if (!abortSignal?.aborted && !errorYielded) {
        const msg =
          spawnError?.code === 'ENOENT'
            ? `pi CLI could not be launched (not found at ${piPath}).`
            : err instanceof Error
              ? err.message
              : String(err);
        yield { conversationId, type: 'error', error: msg };
      }
    } finally {
      abortSignal?.removeEventListener('abort', onAbort);
      killProcessGroup(child); // ensure no orphan pi/bash processes survive
      yield { conversationId, type: 'done' };
    }
  }

  async generateTitle(_messages: unknown[], _config: AppConfig): Promise<string | null> {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helper: kill the child's whole process group (reaps bash grandchildren)
// ---------------------------------------------------------------------------

function killProcessGroup(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (child.pid && process.platform !== 'win32') {
      // Negative pid → signal the entire process group (child was spawned detached).
      process.kill(-child.pid, 'SIGTERM');
      const timer = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null && child.pid) {
            process.kill(-child.pid, 'SIGKILL');
          }
        } catch {
          /* already gone */
        }
      }, 2000);
      timer.unref?.();
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    /* process already exited */
  }
}

// ---------------------------------------------------------------------------
// Helper: extract the last user message as plain text
// ---------------------------------------------------------------------------

function extractLastUserText(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: unknown } | undefined;
    if (!msg || msg.role !== 'user') continue;

    if (typeof msg.content === 'string') {
      return msg.content.length > 0 ? msg.content : null;
    }

    if (Array.isArray(msg.content)) {
      let text: string | null = null;
      for (const part of msg.content as Array<{ type?: string; text?: string }>) {
        if (part.type === 'text' && part.text) {
          text = (text ?? '') + (text ? '\n' : '') + part.text;
        }
      }
      if (text) return text;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helper: Kai approval mode → pi spawn-time tool scoping
// ---------------------------------------------------------------------------

function buildToolScopingArgs(piConfig: Record<string, unknown>): string[] {
  // Default = full autonomy (matches Codex full-auto; a coding agent must run
  // bash/tests/git). suggest/auto-edit opt INTO restrictions.
  const approval = (piConfig.approval as string) ?? 'full-auto';

  // An explicit excludeTools list always wins.
  const explicit = piConfig.excludeTools;
  if (Array.isArray(explicit) && explicit.length > 0) {
    return ['--exclude-tools', explicit.join(',')];
  }

  switch (approval) {
    case 'suggest':
      return ['--exclude-tools', 'bash,edit,write']; // read-only
    case 'auto-edit':
      return ['--exclude-tools', 'bash']; // file edits allowed, no shell
    case 'full-auto':
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Helper: map Kai's selected model → pi --provider/--model + key env var
// ---------------------------------------------------------------------------

function endpointHost(endpoint: string | undefined): string | null {
  if (!endpoint) return ''; // empty = provider's first-party default endpoint
  try {
    return new URL(endpoint).hostname.toLowerCase();
  } catch {
    return null; // unparseable → treat as unmappable
  }
}

function buildPiModelArgs(primaryModel: ModelCatalogEntry | null | undefined): PiModelMapping {
  const mc = primaryModel?.modelConfig;
  if (!mc) {
    // No model resolved — let pi use its own default; no note needed.
    return { args: [], env: {} };
  }

  // Hard vetoes pi cannot express (Azure / Responses-API / header-auth).
  if (
    mc.deploymentName ||
    mc.apiVersion ||
    mc.useResponsesApi ||
    (mc.extraHeaders && Object.keys(mc.extraHeaders).length > 0)
  ) {
    return { args: [], env: {}, unmappableReason: 'Azure / Responses-API / custom-header configuration' };
  }

  const host = endpointHost(mc.endpoint);
  const firstParty = host === '';
  const key = mc.apiKey;

  switch (mc.provider) {
    case 'anthropic':
      if ((firstParty || host === 'api.anthropic.com') && key) {
        return {
          args: ['--provider', 'anthropic', '--model', `anthropic/${mc.modelName}`],
          env: { ANTHROPIC_API_KEY: key },
        };
      }
      break;
    case 'google':
      if ((firstParty || host === 'generativelanguage.googleapis.com') && key) {
        return {
          args: ['--provider', 'google', '--model', `google/${mc.modelName}`],
          env: { GEMINI_API_KEY: key },
        };
      }
      break;
    case 'openai-compatible':
      if ((firstParty || host === 'api.openai.com') && key) {
        return {
          args: ['--provider', 'openai', '--model', `openai/${mc.modelName}`],
          env: { OPENAI_API_KEY: key },
        };
      }
      break;
    case 'amazon-bedrock':
      if (firstParty) {
        // No --api-key: rely on pi's ambient AWS credential chain.
        return { args: ['--provider', 'bedrock', '--model', `bedrock/${mc.modelName}`], env: {} };
      }
      break;
    default:
      break;
  }

  return {
    args: [],
    env: {},
    unmappableReason: `a "${mc.provider}" endpoint pi can't target`,
  };
}

// ---------------------------------------------------------------------------
// Helper: translate a pi JSON event → Kai StreamEvent(s)
// ---------------------------------------------------------------------------

function translatePiEvent(conversationId: string, event: PiEvent): StreamEvent[] {
  const events: StreamEvent[] = [];

  switch (event.type) {
    // Streaming assistant output lives inside message_update.
    case 'message_update': {
      const ame = event.assistantMessageEvent;
      if (!ame) break;
      if (ame.type === 'text_delta' && ame.delta) {
        events.push({ conversationId, type: 'text-delta', text: ame.delta });
      } else if (ame.type === 'thinking_delta' && ame.delta) {
        events.push({
          conversationId,
          type: 'observer-message',
          data: { toolName: 'reasoning', message: ame.delta },
        });
      } else if (ame.type === 'error') {
        events.push({
          conversationId,
          type: 'error',
          error: extractAssistantError(event) ?? 'pi assistant error',
        });
      }
      break;
    }

    case 'tool_execution_start': {
      if (event.toolCallId && event.toolName) {
        events.push({
          conversationId,
          type: 'tool-call',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args ?? {},
          startedAt: new Date().toISOString(),
        });
      }
      break;
    }

    case 'tool_execution_end': {
      if (event.toolCallId && event.toolName) {
        const resultText = stringifyToolResult(event.result);
        events.push({
          conversationId,
          type: 'tool-result',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.isError ? `Error: ${resultText}` : resultText,
          finishedAt: new Date().toISOString(),
        });
      }
      break;
    }

    // Per-turn token usage (best-effort — pi's usage shape may vary).
    case 'turn_end': {
      const usage = extractUsage(event.message?.usage);
      if (usage) {
        events.push({ conversationId, type: 'context-usage', data: usage });
      }
      break;
    }

    // agent_start, turn_start, message_start, message_end, agent_end,
    // toolcall_* deltas, compaction/retry — no direct mapping (text deltas +
    // tool_execution_* are the source of truth; `done` is emitted on exit).
    default:
      break;
  }

  return events;
}

function extractAssistantError(event: PiEvent): string | undefined {
  const err = (event as Record<string, unknown>).error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const m = err as { errorMessage?: string; message?: string };
    return m.errorMessage ?? m.message;
  }
  return event.message?.errorMessage;
}

function stringifyToolResult(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function extractUsage(
  usage: PiUsage | undefined,
): { inputTokens: number; outputTokens: number; totalTokens: number } | null {
  if (!usage) return null;
  const inputTokens = usage.inputTokens ?? usage.input_tokens;
  const outputTokens = usage.outputTokens ?? usage.output_tokens;
  if (typeof inputTokens !== 'number' && typeof outputTokens !== 'number') return null;
  const inT = inputTokens ?? 0;
  const outT = outputTokens ?? 0;
  return { inputTokens: inT, outputTokens: outT, totalTokens: usage.totalTokens ?? inT + outT };
}
