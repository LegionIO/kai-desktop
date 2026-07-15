import { randomUUID } from 'crypto';
import type { LocalBridgeClient } from './client.js';
import { stripControl } from './render/markdown.js';

type StreamEvent = {
  conversationId?: string;
  type?: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  error?: string;
};

export type HeadlessOptions = {
  /** Explicit prompt (from -p/--print). When omitted, stdin is read. */
  prompt?: string;
  /** Emit a single JSON object ({ ok, text, error }) to stdout instead of streaming text. */
  json?: boolean;
  /** Model catalog key to run with (e.g. from --model). */
  modelKey?: string;
  /** Profile key (--profile). */
  profileKey?: string;
  /** Reasoning effort (--reasoning low|medium|high|xhigh). */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  /** Enable the model fallback chain (--fallback). */
  fallbackEnabled?: boolean;
  /** Force a specific agent runtime for the run (--runtime). */
  runtimeOverride?: string;
  /**
   * Recover the backend after an unexpected disconnect (reconnect to the same
   * leader, or spawn + connect a fresh one). Returns true on success. When
   * provided, a mid-run flap no longer aborts the run — it reconnects and reads
   * the persisted turn instead of giving up on the first drop.
   */
  recover?: () => Promise<boolean>;
};

/**
 * Parse the non-interactive CLI flags from an argv slice (already stripped of
 * node/electron + any launcher flag like `--kai-cli`):
 *   -p / --print [prompt]   one-shot: run PROMPT (or stdin if no value) then exit
 *   --prompt=<text>         same, inline value
 *   --json                  emit a single JSON result object instead of streaming
 *   --model <key>           model catalog key to run with (also --model=<key>)
 *   --profile <key>         profile key (also --profile=<key>)
 *   --reasoning <level>     low|medium|high|xhigh (also --reasoning=<level>)
 *   --fallback              enable the model fallback chain
 *   -h / --help             print usage and exit
 * Returns `print: true` when a one-shot run was requested (forces headless even
 * on a TTY). Shared by both the standalone (main.ts) and packaged
 * (electron-entry.ts) entrypoints.
 */
export function parseHeadlessArgs(argv: string[]): {
  print: boolean;
  prompt?: string;
  json: boolean;
  help: boolean;
  modelKey?: string;
  profileKey?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  fallbackEnabled: boolean;
  runtimeOverride?: string;
  /** A --list-* discovery request: print the list then exit (no turn). */
  list?: 'models' | 'profiles' | 'runtimes';
} {
  let print = false;
  let json = false;
  let help = false;
  let fallbackEnabled = false;
  let prompt: string | undefined;
  let modelKey: string | undefined;
  let profileKey: string | undefined;
  let reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | undefined;
  let runtimeOverride: string | undefined;
  let list: 'models' | 'profiles' | 'runtimes' | undefined;

  const REASONING = new Set(['low', 'medium', 'high', 'xhigh']);
  // Consume the value that follows a flag: prefers `--flag=value`, else the next
  // argv token when it isn't itself a flag.
  const takeValue = (arg: string, eq: string, i: number): { value?: string; nextI: number } => {
    if (arg.startsWith(eq)) return { value: arg.slice(eq.length), nextI: i };
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('-')) return { value: next, nextI: i + 1 };
    return { value: undefined, nextI: i };
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-p' || a === '--print') {
      print = true;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        prompt = next;
        i++;
      }
    } else if (a === '--json') {
      json = true;
    } else if (a === '-h' || a === '--help') {
      help = true;
    } else if (a === '--fallback') {
      fallbackEnabled = true;
    } else if (a.startsWith('--prompt=')) {
      print = true;
      prompt = a.slice('--prompt='.length);
    } else if (a === '--model' || a.startsWith('--model=')) {
      const { value, nextI } = takeValue(a, '--model=', i);
      if (value) modelKey = value;
      i = nextI;
    } else if (a === '--profile' || a.startsWith('--profile=')) {
      const { value, nextI } = takeValue(a, '--profile=', i);
      if (value) profileKey = value;
      i = nextI;
    } else if (a === '--reasoning' || a.startsWith('--reasoning=')) {
      const { value, nextI } = takeValue(a, '--reasoning=', i);
      if (value && REASONING.has(value)) reasoningEffort = value as 'low' | 'medium' | 'high' | 'xhigh';
      i = nextI;
    } else if (a === '--runtime' || a.startsWith('--runtime=')) {
      const { value, nextI } = takeValue(a, '--runtime=', i);
      if (value) runtimeOverride = value;
      i = nextI;
    } else if (a === '--list-models') {
      list = 'models';
    } else if (a === '--list-profiles') {
      list = 'profiles';
    } else if (a === '--list-runtimes') {
      list = 'runtimes';
    }
  }
  return { print, prompt, json, help, modelKey, profileKey, reasoningEffort, fallbackEnabled, runtimeOverride, list };
}

/** The `kai --help` usage manual. */
export function helpText(): string {
  return [
    'kai — terminal client for the Kai desktop assistant',
    '',
    'USAGE:',
    '  kai                          Start the interactive chat REPL (needs a TTY).',
    '  kai -p "<prompt>"            One-shot: run the prompt, stream the reply, exit.',
    '  echo "<prompt>" | kai -p     One-shot from stdin.',
    '  kai -p "<prompt>" --json     One-shot, emit a single JSON result object.',
    '',
    'OPTIONS:',
    '  -p, --print [prompt]         Run headless (one-shot). Prompt value optional;',
    '                               falls back to stdin when omitted.',
    '      --prompt=<text>          Same as -p with an inline value.',
    '      --json                   Emit {"ok","text","error"} instead of streaming.',
    '      --model <key>            Model catalog key to run with.',
    '      --profile <key>          Profile key to run with.',
    '      --reasoning <level>      Reasoning effort: low | medium | high | xhigh.',
    '      --runtime <id>           Agent runtime: mastra | claude-agent-sdk | codex-sdk | pi.',
    '      --fallback               Enable the model fallback chain.',
    '      --list-models            Print available model catalog keys, then exit.',
    '      --list-profiles          Print available profile keys, then exit.',
    '      --list-runtimes          Print available runtimes (+ availability), then exit.',
    '  -h, --help                   Print this help and exit.',
    '',
    'NOTES:',
    '  • Headless runs require a trusted folder and auto-deny tool approvals',
    '    (no interactive terminal to confirm them).',
    '  • A backend is attached if one is running, else a headless one is spawned.',
    '  • A mid-run backend reconnect is recovered automatically; the reply is read',
    '    from the persisted conversation if stream events were missed.',
  ].join('\n');
}

/**
 * Handle a `--list-models|--list-profiles|--list-runtimes` request: query the
 * backend and print the keys (one per line) to stdout, then return. Used for
 * headless discovery of valid --model/--profile/--runtime values. Best-effort:
 * a backend/IPC error prints a short note to stderr and returns (no throw).
 */
export async function listResources(
  client: LocalBridgeClient,
  what: 'models' | 'profiles' | 'runtimes',
): Promise<void> {
  try {
    if (what === 'models') {
      const res = (await client.invoke('agent:model-catalog')) as {
        models?: Array<{ key: string; label?: string }>;
        defaultKey?: string | null;
      };
      for (const m of res?.models ?? []) {
        process.stdout.write(`${m.key}${m.key === res.defaultKey ? '  (default)' : ''}\n`);
      }
    } else if (what === 'profiles') {
      const res = (await client.invoke('agent:profiles')) as {
        profiles?: Array<{ key: string; label?: string }>;
      };
      for (const p of res?.profiles ?? []) process.stdout.write(`${p.key}\n`);
    } else {
      const runtimes = (await client.invoke('agent:get-available-runtimes')) as Array<{
        id: string;
        name: string;
        available: boolean;
        reason?: string;
      }>;
      for (const r of runtimes ?? []) {
        const status = r.available ? 'available' : `unavailable${r.reason ? ` — ${r.reason}` : ''}`;
        process.stdout.write(`${r.id}  (${r.name}) — ${status}\n`);
      }
    }
  } catch (err) {
    process.stderr.write(`kai: could not list ${what}: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/**
 * Non-interactive run: submit a single prompt to a fresh cwd-scoped chat and
 * either stream the assistant reply to stdout (default) or, with `json`,
 * collect the full reply and print one JSON object at the end. The prompt comes
 * from `opts.prompt` (-p/--print) or, if absent, all of stdin — so both
 * `kai -p "hi"` and `echo hi | kai` work. Ink's TUI needs a real terminal;
 * this path keeps scripting/CI working.
 */
export async function runHeadlessOnce(client: LocalBridgeClient, opts: HeadlessOptions = {}): Promise<void> {
  const prompt = opts.prompt !== undefined ? opts.prompt : await readStdin();
  const json = opts.json === true;
  if (!prompt.trim()) {
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: 'no input' }) + '\n');
    else process.stderr.write('[kai] no input (pass -p "prompt" or pipe stdin)\n');
    return;
  }

  const cwd = process.cwd();
  const id = randomUUID();
  const now = new Date().toISOString();
  await client.invoke('conversations:put', {
    id,
    title: null,
    fallbackTitle: null,
    messages: [],
    messageTree: [],
    headId: null,
    conversationCompaction: null,
    lastContextUsage: null,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: null,
    titleStatus: 'idle',
    titleUpdatedAt: null,
    messageCount: 0,
    userMessageCount: 0,
    runStatus: 'idle',
    hasUnread: false,
    lastAssistantUpdateAt: null,
    selectedModelKey: opts.modelKey ?? null,
    selectedProfileKey: opts.profileKey ?? null,
    currentWorkingDirectory: cwd,
  });

  const submitOpts = {
    cwd,
    ...(opts.modelKey ? { modelKey: opts.modelKey } : {}),
    ...(opts.profileKey ? { profileKey: opts.profileKey } : {}),
    ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
    ...(opts.fallbackEnabled ? { fallbackEnabled: true } : {}),
    ...(opts.runtimeOverride ? { runtimeOverride: opts.runtimeOverride } : {}),
  };

  let collected = ''; // full reply (for --json)
  let sawDelta = false; // did we stream any text this run (vs. reading it from the store)?
  let errored: string | null = null;
  let recovering = false; // suppress the disconnect handler while we drive recovery

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      off();
      offDisc();
      resolve();
    };
    const off = client.on('agent:stream-event', (raw) => {
      const e = raw as StreamEvent;
      if (e.conversationId !== id) return;
      if (e.type === 'text-delta' && e.text) {
        sawDelta = true;
        if (json) collected += e.text;
        else process.stdout.write(stripControl(e.text));
      } else if (e.type === 'tool-call') {
        if (!json) process.stderr.write(`\n[tool: ${stripControl(e.toolName ?? 'tool')}]\n`);
      } else if (e.type === 'tool-approval-required' && e.toolCallId) {
        // Non-interactive: can't prompt. Auto-reject so the run doesn't hang
        // forever waiting on an approval no one can give.
        if (!json) {
          process.stderr.write(
            `\n[auto-denied ${stripControl(e.toolName ?? 'tool')} — approval needs an interactive terminal]\n`,
          );
        }
        void client.invoke('agent:reject-tool', e.toolCallId).catch(() => {});
      } else if (e.type === 'error') {
        errored = e.error ?? 'unknown';
        if (!json) process.stderr.write(`\n[error: ${stripControl(errored)}]\n`);
        // An error is terminal for a one-shot run. Finish now so a backend that
        // emits `error` WITHOUT a following `done` can't leave us hanging. (The
        // `settled` guard makes a later `done` a no-op if one does arrive.)
        finish();
      } else if (e.type === 'done') {
        if (!json) process.stdout.write('\n');
        finish();
      }
    });
    // A mid-run backend drop used to abort the whole run on the FIRST flap. Now,
    // if a recover fn is available, reconnect and read the persisted turn instead
    // of giving up — a transient flap (or even a leader crash where the turn
    // survives in the store) no longer loses the reply. Only give up when
    // recovery genuinely fails.
    const offDisc = client.onDisconnect(() => {
      if (settled || recovering) return;
      if (client.wasIntentionalClose() || !opts.recover) {
        errored = errored ?? 'backend disconnected';
        if (!json) process.stderr.write('\n[backend disconnected]\n');
        finish();
        return;
      }
      recovering = true;
      if (!json) process.stderr.write('\n[backend disconnected — reconnecting…]\n');
      void (async () => {
        try {
          const ok = await opts.recover!();
          if (settled) return;
          if (!ok) {
            errored = errored ?? 'backend disconnected (could not reconnect)';
            if (!json) process.stderr.write('[could not reconnect]\n');
            finish();
            return;
          }
          // Re-assert the active conversation on the (possibly new) backend, then
          // wait for the turn to settle and read the persisted reply. Stream
          // events emitted during the gap were missed, so the store is the
          // source of truth for the final text.
          await client.invoke('conversations:set-active-id', id).catch(() => {});
          const finalText = await waitForPersistedReply(client, id);
          if (settled) return;
          if (finalText !== null && !sawDelta) {
            if (json) collected = finalText;
            else process.stdout.write(stripControl(finalText) + '\n');
          } else if (!json && sawDelta) {
            process.stdout.write('\n');
          }
          if (finalText === null) errored = errored ?? 'reconnected but no reply was persisted';
          finish();
        } catch (err) {
          if (settled) return;
          errored = errored ?? (err instanceof Error ? err.message : String(err));
          finish();
        } finally {
          recovering = false;
        }
      })();
    });
    void client.invoke('agent:submit', id, prompt.trim(), submitOpts).catch((err) => {
      // A submit that fails because the socket dropped is handled by the
      // disconnect path (recover). Only treat it as terminal here if we're not
      // already recovering.
      if (recovering || settled) return;
      errored = err?.message ?? String(err);
      if (!json) process.stderr.write(`\n[submit failed: ${errored}]\n`);
      finish();
    });
  });

  if (json) {
    process.stdout.write(
      JSON.stringify(errored ? { ok: false, error: errored, text: collected } : { ok: true, text: collected }) + '\n',
    );
  }
}

/**
 * After a reconnect, wait for the in-flight turn to settle and return the final
 * assistant text from the persisted conversation. Polls `agent:in-flight` until
 * the run is no longer active (or a timeout), then reads the last assistant
 * message from the store. Returns null if nothing was persisted.
 */
async function waitForPersistedReply(client: LocalBridgeClient, conversationId: string): Promise<string | null> {
  const deadline = Date.now() + 120_000; // generous — a long turn may still be running
  for (;;) {
    let running = false;
    try {
      running = (await client.invoke<boolean>('agent:in-flight', conversationId)) === true;
    } catch {
      // A drop while polling — the outer recover loop owns reconnection; treat as
      // not-running so we fall through to read whatever was persisted.
      running = false;
    }
    if (!running || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  try {
    const conv = await client.invoke<{ messages?: Array<{ role?: string; content?: unknown }> } | null>(
      'conversations:get',
      conversationId,
    );
    const messages = conv?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'assistant') {
        const text = contentToText(messages[i].content).trim();
        return text || null;
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Flatten a stored message `content` (string or content-part array) to plain text. */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
        const t = (part as { text?: unknown }).text;
        return typeof t === 'string' ? t : '';
      }
      return '';
    })
    .join('');
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    // A stdin read error must still settle the promise (with whatever was read)
    // rather than hang the one-shot run forever.
    process.stdin.on('error', () => resolve(data));
    // If stdin is already closed/empty, resolve promptly.
    if (process.stdin.readableEnded) resolve(data);
  });
}
