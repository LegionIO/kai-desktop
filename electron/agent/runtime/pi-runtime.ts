/**
 * pi coding-agent runtime adapter.
 *
 * Unlike the Claude/Codex runtimes (which wrap an official "drive-the-CLI" SDK),
 * pi has no such SDK — its own CLI exposes a headless JSON mode. We therefore
 * spawn the `pi` binary directly, one process per turn:
 *
 *     pi --mode json [--session <id>] [--session-dir <dir>] [--provider/--model …] [--tools <allow>]
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
 *   - Session continuity: the FIRST turn omits --session (pi creates a session
 *     and emits its id, which we capture + persist); later turns pass
 *     `--session <id>` to resume. (pi's --session REUSES an existing session — it
 *     does not create one for an unknown id.)
 *   - pi has no per-tool approval hook in any headless mode, so it runs bash +
 *     file edits unsupervised. The Kai approval mode maps to spawn-time tool
 *     scoping via pi's `--tools` allowlist (read | read,write,edit | all).
 *   - pi only drives models in its own registry at their official endpoints (no
 *     `--base-url`), so Kai's custom-endpoint models are unmappable — we then
 *     let pi use its own configured default and surface a one-line note.
 *   - No MCP: Kai skill/plugin/custom tools cannot be bridged.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';

import type { AgentRuntime, RuntimeCapabilities, StreamOptions, StreamEvent } from './types.js';
import { detectPiCli, resolvePiCliPath } from './detect.js';
import type { AppConfig } from '../../config/schema.js';
import type { ModelCatalogEntry } from '../model-catalog.js';
import { getResolvedProcessEnv } from '../../utils/shell-env.js';
import { scrubSecretEnv } from './confinement.js';

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
  sessions: true, // session resume via captured pi session id + --session
  customTools: false, // no MCP bridge possible — Kai custom tools unavailable
  executesUntrustedTools: true, // pi has NO per-tool hook in headless mode — runs bash/edits unsupervised
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
  /** Bedrock via the ambient AWS credential chain — the env scrub must keep AWS_*. */
  preserveAwsChain?: boolean;
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
    // 3. Session id — pi's `--session <id>` REUSES an existing session (it does
    // NOT create one for an unknown id; passing a fresh UUID errors "No session
    // found"). So: on the FIRST turn we pass no --session (pi creates one and
    // emits its id in the `{type:'session',id}` event, captured below + persisted);
    // on later turns we pass the captured id to resume.
    // -----------------------------------------------------------------------
    const existingPiSessionId = conversationMetadata?.piSessionId as string | undefined;

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

    // Session: reuse an existing pi session id if we captured one on a prior
    // turn; otherwise let pi create a fresh session (its id is captured from the
    // session event + persisted below). `--session-dir` pins storage under ~/.kai.
    if (existingPiSessionId) {
      args.push('--session', existingPiSessionId);
    }
    args.push('--session-dir', join(appHome, 'pi-sessions'));

    // Env: when the IPC chokepoint pre-built a scrubbed childEnv (confinement
    // enabled), use it as the base — it already excludes app secrets and carries
    // only the allowlisted vars. Otherwise inherit Kai's resolved env BUT scrub
    // the app's secret-bearing keys first (denylist) — pi runs model-directed
    // shell commands and must not inherit Kai's own provider/credential env even
    // when confinement is off. Either way overlay the ONE provider key pi needs
    // (never on argv). Never log.
    const baseEnv =
      options.childEnv ?? scrubSecretEnv(getResolvedProcessEnv(), { preserveAwsChain: mapping.preserveAwsChain });
    const env: NodeJS.ProcessEnv = { ...baseEnv, ...mapping.env };

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
      cwd: options.confinedCwd || cwd || process.cwd(),
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
      if (stderrBuf.length < STDERR_CAP) {
        // Hard-cap on append: a single large stderr chunk must not push the
        // buffer well past STDERR_CAP.
        stderrBuf = (stderrBuf + d.toString('utf8')).slice(0, STDERR_CAP);
      }
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
          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            continue; // skip non-JSON / partial garbage
          }
          // A pi event is always a JSON object; a bare primitive (null, number,
          // string) from a hostile/buggy stream would crash translatePiEvent on
          // `event.type`. Skip it.
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
          // Capture pi's session id on the FIRST turn so the next turn can resume
          // it via --session. pi emits {type:'session',id,...} at stream start.
          if (!existingPiSessionId) {
            const p = parsed as { type?: unknown; id?: unknown };
            if (p.type === 'session' && typeof p.id === 'string' && p.id) {
              yield { conversationId, type: 'enrichment', data: { piSessionId: p.id } };
            }
          }
          for (const evt of translatePiEvent(conversationId, parsed as PiEvent)) {
            if (evt.type === 'error') errorYielded = true;
            yield evt;
          }
        }
        // Enforce the per-line cap DURING buffering too: a newline-free hostile
        // line must not grow `buf` up to the whole-turn ceiling. Once the pending
        // (unterminated) buffer exceeds the line cap it can't become a valid line,
        // so drop it.
        if (buf.length > MAX_LINE_BYTES) buf = '';
      }
      // Flush any trailing line without a newline.
      const tail = buf.trim();
      if (!abortSignal?.aborted && tail && tail.length <= MAX_LINE_BYTES) {
        try {
          const parsedTail: unknown = JSON.parse(tail);
          if (parsedTail && typeof parsedTail === 'object' && !Array.isArray(parsedTail)) {
            for (const evt of translatePiEvent(conversationId, parsedTail as PiEvent)) {
              if (evt.type === 'error') errorYielded = true;
              yield evt;
            }
          }
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
      } else if (!abortSignal?.aborted && !errorYielded && exitCode && exitCode !== 0) {
        errorYielded = true;
        yield {
          conversationId,
          type: 'error',
          error: redactSecretsFromText(stderrBuf.trim()) || `pi exited with code ${exitCode}`,
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
  // NOTE: do NOT early-return when the LEADER (pi) has already exited. The whole
  // point of a process-GROUP signal is to reap bash grandchildren that the pi
  // leader spawned and outlived — those survive the leader's exit. Signaling an
  // already-empty group is a harmless ESRCH (caught below).
  try {
    if (child.pid && process.platform !== 'win32') {
      // Negative pid → signal the entire process group (child was spawned detached).
      process.kill(-child.pid, 'SIGTERM');
      const pid = child.pid;
      const timer = setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* group already gone (ESRCH) */
        }
      }, 2000);
      timer.unref?.();
    } else if (child.exitCode === null && child.signalCode === null) {
      // No process group (win32 / no pid): only the leader to signal, and only
      // if it's still alive.
      child.kill('SIGTERM');
    }
  } catch {
    /* process/group already exited */
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
  // pi has NO --exclude-tools; it only supports an ALLOWLIST via --tools, or
  // --no-tools / --no-builtin-tools. pi's built-in tools are: read, write, edit,
  // bash. Map Kai's approval mode to the allowed built-in set. Default full-auto
  // (a coding agent must run bash/tests/git) → no flag (all tools on).
  const approval = (piConfig.approval as string) ?? 'full-auto';
  const BUILTINS = ['read', 'write', 'edit', 'bash'];

  // An explicit excludeTools list (Kai config semantics: "deny these") is
  // translated to pi's allowlist = the built-ins NOT excluded.
  const explicit = piConfig.excludeTools;
  if (Array.isArray(explicit) && explicit.length > 0) {
    const denied = new Set(explicit.map(String));
    const allowed = BUILTINS.filter((t) => !denied.has(t));
    // Everything denied → disable built-ins entirely (keep extension tools).
    return allowed.length === 0 ? ['--no-builtin-tools'] : ['--tools', allowed.join(',')];
  }

  switch (approval) {
    case 'suggest':
      return ['--tools', 'read']; // read-only
    case 'auto-edit':
      return ['--tools', 'read,write,edit']; // file edits allowed, no shell
    case 'full-auto':
    default:
      return []; // all built-in tools enabled
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
        // No --api-key: rely on pi's ambient AWS credential chain. The env scrub
        // must therefore KEEP AWS_* (preserveAwsChain), unlike other providers.
        return {
          args: ['--provider', 'bedrock', '--model', `bedrock/${mc.modelName}`],
          env: {},
          preserveAwsChain: true,
        };
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

/**
 * Redact secret-shaped tokens from subprocess stderr before it's surfaced to
 * the renderer as an error. API keys are passed via env (not argv), but pi or a
 * provider may echo a key / bearer token / connection string in a diagnostic;
 * strip common secret shapes so a hostile-or-buggy error line can't leak them.
 */
export function redactSecretsFromText(text: string): string {
  if (!text) return text;
  return (
    text
      // provider key prefixes: sk-..., sk-ant-..., ghp_/gho_/github_pat_, AKIA...
      .replace(
        /\b(sk-[A-Za-z0-9-]{8,}|ghp_[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{12,})\b/g,
        '[redacted]',
      )
      // Authorization: Bearer <token>
      .replace(/(authorization|bearer)\s*[:=]?\s*[A-Za-z0-9._-]{12,}/gi, '$1 [redacted]')
      // KEY/TOKEN/SECRET/PASSWORD = value (env-echo style)
      .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*\S+/g, '$1=[redacted]')
  );
}
