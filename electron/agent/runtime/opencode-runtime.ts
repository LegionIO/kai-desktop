/**
 * OpenCode runtime — drives the `opencode` CLI (github.com/sst/opencode,
 * Anomaly org) as a Kai AgentRuntime.
 *
 * opencode has a clean headless JSON mode:
 *     opencode run [message] --format json --model <provider/model> --dir <cwd> [-s <session>]
 * It reads the prompt from argv (or stdin) and emits one JSON object per line on
 * stdout. The events we translate:
 *   { type:'step_start',  part:{ type:'step-start' } }
 *   { type:'text',        part:{ type:'text', text } }                → text-delta
 *   { type:'tool_use',    part:{ type:'tool', tool, callID, state:{status,input,output} } }
 *                                                                     → tool-call + tool-result
 *   { type:'step_finish', part:{ type:'step-finish', tokens, cost } } → context-usage (+ done at end)
 *   { type:'error' | ... }                                            → error
 *
 * Model auth mirrors pi/codex/claude: scrub Kai's own secret env, then overlay
 * the provider key resolved from Kai's catalog (via env — opencode reads
 * ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY, models.dev
 * convention) + `--model provider/model`, never on argv.
 *
 * Sessions: the first turn omits -s (opencode creates a session and emits its id
 * on the created/session event); we capture it and pass `-s <id>` to resume.
 *
 * Tools: opencode has a native MCP client (customTools bridging via the MCP
 * bridge is a follow-up — see TODO); for now it runs with its own built-in tools.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentRuntime, RuntimeCapabilities, StreamOptions, StreamEvent } from './types.js';
import { detectOpencodeCli, resolveOpencodeCliPath } from './detect.js';
import type { AppConfig } from '../../config/schema.js';
import type { ModelCatalogEntry } from '../model-catalog.js';
import { getResolvedProcessEnv } from '../../utils/shell-env.js';
import { scrubSecretEnv } from './confinement.js';

const OPENCODE_CAPABILITIES: RuntimeCapabilities = {
  builtInTools: true, // opencode ships bash/read/write/edit/grep/etc.
  mcpSupport: true, // native MCP client (tool bridging is a follow-up)
  toolObserver: false, // opencode manages its own tool lifecycle
  compaction: false, // opencode manages context internally
  memory: false, // no Kai memory-layer integration
  fallback: false, // no Kai-managed model fallback
  multiProvider: true, // provider/model via models.dev
  subAgents: false,
  sessions: true, // -s <id> / captured session id
  customTools: false, // TODO: bridge Kai tools via opencode's MCP config
  executesUntrustedTools: true, // spawns a CLI that runs bash/edits unsupervised
};

/** Levels opencode's --variant accepts for reasoning effort. */
const OPENCODE_VARIANTS = new Set(['low', 'medium', 'high', 'xhigh']);

export class OpencodeRuntime implements AgentRuntime {
  readonly id = 'opencode' as const;
  readonly name = 'OpenCode';
  readonly capabilities = OPENCODE_CAPABILITIES;

  async isAvailable(): Promise<boolean> {
    return detectOpencodeCli();
  }

  async *stream(options: StreamOptions): AsyncGenerator<StreamEvent> {
    const { conversationId, cwd, reasoningEffort, abortSignal, primaryModel, conversationMetadata } = options;

    const binPath = await resolveOpencodeCliPath();
    if (!binPath) {
      yield {
        conversationId,
        type: 'text-delta',
        text: 'The opencode CLI was not found on your PATH. Install it with `npm i -g opencode-ai`, then reopen this chat.',
      };
      yield { conversationId, type: 'done' };
      return;
    }

    let promptText = extractLastUserText(options.messages);
    if (!promptText) {
      yield { conversationId, type: 'text-delta', text: 'No user message found to send to opencode.' };
      yield { conversationId, type: 'done' };
      return;
    }
    // On a cross-runtime switch, opencode has no prior session: prepend context.
    if (options.switchContext) promptText = `${options.switchContext}\n\n${promptText}`;

    const existingSessionId = conversationMetadata?.opencodeSessionId as string | undefined;

    const args: string[] = ['run', '--format', 'json'];
    const mapping = mapModel(primaryModel);
    if (mapping.model) args.push('--model', mapping.model);
    if (reasoningEffort && OPENCODE_VARIANTS.has(reasoningEffort)) args.push('--variant', reasoningEffort);
    if (existingSessionId) args.push('-s', existingSessionId);
    const runDir = options.confinedCwd || cwd || process.cwd();
    args.push('--dir', runDir);
    // Prompt via stdin (avoid argv @/-/ambiguity + very long prompts).
    args.push('-');

    if (mapping.unmappableReason) {
      yield {
        conversationId,
        type: 'text-delta',
        text:
          `> Note: opencode couldn't be pointed at "${primaryModel?.displayName ?? 'the selected model'}" ` +
          `(${mapping.unmappableReason}); using opencode's own default model. Configure the provider in ` +
          `opencode (\`opencode auth login\`) or pick a first-party model.\n\n`,
      };
    }

    const baseEnv =
      options.childEnv ?? scrubSecretEnv(getResolvedProcessEnv(), { preserveAwsChain: mapping.preserveAwsChain });
    const env: NodeJS.ProcessEnv = { ...baseEnv, ...mapping.env };

    const child = spawn(binPath, args, {
      cwd: runDir,
      env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    let spawnError: NodeJS.ErrnoException | undefined;
    let stderrBuf = '';
    let errorYielded = false;
    child.on('error', (err) => {
      spawnError = err as NodeJS.ErrnoException;
    });
    child.stdin.on('error', () => {});
    child.stderr.on('data', (d: Buffer) => {
      if (stderrBuf.length < 64 * 1024) stderrBuf = (stderrBuf + d.toString('utf8')).slice(0, 64 * 1024);
    });

    const onAbort = (): void => killProcessGroup(child);
    abortSignal?.addEventListener('abort', onAbort, { once: true });

    const exited = new Promise<void>((resolve) => {
      child.on('close', () => resolve());
    });

    try {
      // Send the prompt on stdin.
      child.stdin.write(promptText);
      child.stdin.end();

      let buf = '';
      let sessionIdEmitted = false;
      const MAX_LINE = 4 * 1024 * 1024;
      for await (const chunk of child.stdout) {
        if (abortSignal?.aborted) break;
        buf += (chunk as Buffer).toString('utf8');
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line || line.length > MAX_LINE || !line.startsWith('{')) continue;
          let evt: unknown;
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }
          if (!evt || typeof evt !== 'object') continue;
          // Capture opencode's session id ONCE (first turn) for resume — every
          // event carries sessionID, so guard against re-emitting the enrichment.
          if (!existingSessionId && !sessionIdEmitted) {
            const sid = extractSessionId(evt);
            if (sid) {
              sessionIdEmitted = true;
              yield { conversationId, type: 'enrichment', data: { opencodeSessionId: sid } };
            }
          }
          for (const out of translateOpencodeEvent(conversationId, evt as OpencodeEvent)) {
            if (out.type === 'error') errorYielded = true;
            yield out;
          }
        }
        if (buf.length > MAX_LINE) buf = '';
      }

      await exited;
      // Surface a spawn/exit failure that produced no error event.
      if (spawnError && !errorYielded) {
        yield {
          conversationId,
          type: 'error',
          error:
            spawnError.code === 'ENOENT'
              ? 'The opencode CLI could not be launched (ENOENT).'
              : `opencode failed to start: ${spawnError.message}`,
        };
      } else if (!errorYielded && stderrBuf.trim() && child.exitCode && child.exitCode !== 0) {
        yield {
          conversationId,
          type: 'error',
          error: `opencode exited (${child.exitCode}): ${stderrBuf.trim().slice(0, 500)}`,
        };
      }
    } catch (err) {
      if (!errorYielded)
        yield { conversationId, type: 'error', error: err instanceof Error ? err.message : String(err) };
    } finally {
      abortSignal?.removeEventListener('abort', onAbort);
      killProcessGroup(child);
      yield { conversationId, type: 'done' };
    }
  }

  async generateTitle(_messages: unknown[], _config: AppConfig): Promise<string | null> {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Event translation
// ---------------------------------------------------------------------------

type OpencodeEvent = {
  type?: string;
  sessionID?: string;
  part?: {
    type?: string;
    text?: string;
    tool?: string;
    callID?: string;
    id?: string;
    state?: { status?: string; input?: unknown; output?: unknown; metadata?: unknown };
    tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
    cost?: number;
  };
};

/** Extract opencode's session id from an event (the created/session event). */
function extractSessionId(evt: unknown): string | undefined {
  const e = evt as { sessionID?: unknown; part?: { sessionID?: unknown } };
  if (typeof e.sessionID === 'string' && e.sessionID) return e.sessionID;
  if (e.part && typeof e.part.sessionID === 'string' && e.part.sessionID) return e.part.sessionID;
  return undefined;
}

/** Translate one opencode JSON event into zero or more Kai StreamEvents. */
export function translateOpencodeEvent(conversationId: string, evt: OpencodeEvent): StreamEvent[] {
  const out: StreamEvent[] = [];
  const part = evt.part;
  switch (evt.type) {
    case 'text':
      if (part?.type === 'text' && typeof part.text === 'string' && part.text) {
        out.push({ conversationId, type: 'text-delta', text: part.text });
      }
      break;
    case 'tool_use':
      if (part && part.tool) {
        const toolCallId = part.callID ?? part.id ?? `opencode-${Date.now()}`;
        out.push({ conversationId, type: 'tool-call', toolCallId, toolName: part.tool, args: part.state?.input });
        // opencode emits tool_use with a completed state (input + output); surface
        // the result too so the turn shows the tool's output inline.
        if (part.state?.status === 'completed') {
          out.push({ conversationId, type: 'tool-result', toolCallId, toolName: part.tool, result: part.state.output });
        } else if (part.state?.status === 'error') {
          out.push({
            conversationId,
            type: 'tool-result',
            toolCallId,
            toolName: part.tool,
            result: { isError: true, error: String(part.state.output ?? 'tool error') },
          });
        }
      }
      break;
    case 'step_finish':
      if (part?.tokens) {
        out.push({
          conversationId,
          type: 'context-usage',
          data: {
            inputTokens: part.tokens.input,
            outputTokens: part.tokens.output,
            cacheReadTokens: part.tokens.cache?.read,
            cacheWriteTokens: part.tokens.cache?.write,
          },
        });
      }
      break;
    case 'error':
      out.push({ conversationId, type: 'error', error: describeOpencodeError(evt) });
      break;
    default:
      break; // step_start and others: no Kai event
  }
  return out;
}

function describeOpencodeError(evt: OpencodeEvent): string {
  const e = evt as { error?: unknown; message?: unknown; part?: { error?: unknown } };
  const msg = e.error ?? e.message ?? e.part?.error;
  return typeof msg === 'string' && msg ? msg : 'opencode reported an error';
}

// ---------------------------------------------------------------------------
// Model mapping (Kai catalog → opencode provider/model + env key)
// ---------------------------------------------------------------------------

type OpencodeModelMapping = {
  model?: string;
  env: NodeJS.ProcessEnv;
  preserveAwsChain?: boolean;
  unmappableReason?: string;
};

function endpointHost(endpoint: string | undefined): string | null {
  if (!endpoint) return '';
  try {
    return new URL(endpoint).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function mapModel(primaryModel: ModelCatalogEntry | null | undefined): OpencodeModelMapping {
  const mc = primaryModel?.modelConfig;
  if (!mc) return { env: {} };
  // opencode can't express Azure / Responses-API / custom-header auth via a
  // simple provider/model + env key.
  if (
    mc.deploymentName ||
    mc.apiVersion ||
    mc.useResponsesApi ||
    (mc.extraHeaders && Object.keys(mc.extraHeaders).length > 0)
  ) {
    return { env: {}, unmappableReason: 'Azure / Responses-API / custom-header configuration' };
  }
  const host = endpointHost(mc.endpoint);
  const firstParty = host === '';
  const key = mc.apiKey;
  switch (mc.provider) {
    case 'anthropic':
      if ((firstParty || host === 'api.anthropic.com') && key) {
        return { model: `anthropic/${mc.modelName}`, env: { ANTHROPIC_API_KEY: key } };
      }
      break;
    case 'google':
      if ((firstParty || host === 'generativelanguage.googleapis.com') && key) {
        return { model: `google/${mc.modelName}`, env: { GOOGLE_GENERATIVE_AI_API_KEY: key } };
      }
      break;
    case 'openai-compatible':
      if ((firstParty || host === 'api.openai.com') && key) {
        return { model: `openai/${mc.modelName}`, env: { OPENAI_API_KEY: key } };
      }
      break;
    case 'amazon-bedrock':
      if (firstParty) {
        return { model: `amazon-bedrock/${mc.modelName}`, env: {}, preserveAwsChain: true };
      }
      break;
    default:
      break;
  }
  return { env: {}, unmappableReason: 'custom endpoint or provider opencode cannot target directly' };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractLastUserText(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: unknown } | undefined;
    if (msg?.role !== 'user') continue;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      const text = (msg.content as Array<{ type?: string; text?: string }>)
        .filter((p) => p?.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n');
      if (text) return text;
    }
  }
  return null;
}

/** Kill the child's whole process group (reaps grandchildren spawned by tools). */
function killProcessGroup(child: ChildProcessWithoutNullStreams): void {
  try {
    if (child.exitCode !== null || child.signalCode) return;
    if (process.platform !== 'win32' && typeof child.pid === 'number') {
      try {
        process.kill(-child.pid, 'SIGTERM');
        return;
      } catch {
        /* fall through to direct kill */
      }
    }
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
}
