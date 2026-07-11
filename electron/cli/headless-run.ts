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
};

/**
 * Parse the non-interactive CLI flags from an argv slice (already stripped of
 * node/electron + any launcher flag like `--kai-cli`):
 *   -p / --print [prompt]   one-shot: run PROMPT (or stdin if no value) then exit
 *   --prompt=<text>         same, inline value
 *   --json                  emit a single JSON result object instead of streaming
 * Returns `print: true` when a one-shot run was requested (forces headless even
 * on a TTY). Shared by both the standalone (main.ts) and packaged
 * (electron-entry.ts) entrypoints.
 */
export function parseHeadlessArgs(argv: string[]): { print: boolean; prompt?: string; json: boolean } {
  let print = false;
  let json = false;
  let prompt: string | undefined;
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
    } else if (a.startsWith('--prompt=')) {
      print = true;
      prompt = a.slice('--prompt='.length);
    }
  }
  return { print, prompt, json };
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
    selectedModelKey: null,
    currentWorkingDirectory: cwd,
  });

  let collected = ''; // full reply (for --json)
  let errored: string | null = null;

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
    // If the backend dies after submit resolves, don't hang forever.
    const offDisc = client.onDisconnect(() => {
      errored = errored ?? 'backend disconnected';
      if (!json) process.stderr.write('\n[backend disconnected]\n');
      finish();
    });
    void client.invoke('agent:submit', id, prompt.trim(), { cwd }).catch((err) => {
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
