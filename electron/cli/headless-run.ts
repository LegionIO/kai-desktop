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

/**
 * Non-interactive fallback for when stdin is not a TTY (piped input, CI). Reads
 * all of stdin as a single prompt, submits it to a fresh cwd-scoped chat,
 * streams the assistant reply to stdout, and exits. Ink's full TUI needs raw
 * mode (a real terminal); this keeps `echo "hi" | kai` and scripts working.
 */
export async function runHeadlessOnce(client: LocalBridgeClient): Promise<void> {
  const prompt = await readStdin();
  if (!prompt.trim()) {
    process.stderr.write('[kai] no input on stdin\n');
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
      if (e.type === 'text-delta' && e.text) process.stdout.write(stripControl(e.text));
      else if (e.type === 'tool-call') process.stderr.write(`\n[tool: ${stripControl(e.toolName ?? 'tool')}]\n`);
      else if (e.type === 'tool-approval-required' && e.toolCallId) {
        // Non-interactive: can't prompt. Auto-reject so the run doesn't hang
        // forever waiting on an approval no one can give.
        process.stderr.write(
          `\n[auto-denied ${stripControl(e.toolName ?? 'tool')} — approval needs an interactive terminal]\n`,
        );
        void client.invoke('agent:reject-tool', e.toolCallId).catch(() => {});
      } else if (e.type === 'error') process.stderr.write(`\n[error: ${stripControl(e.error ?? 'unknown')}]\n`);
      else if (e.type === 'done') {
        process.stdout.write('\n');
        finish();
      }
    });
    // If the backend dies after submit resolves, don't hang forever.
    const offDisc = client.onDisconnect(() => {
      process.stderr.write('\n[backend disconnected]\n');
      finish();
    });
    void client.invoke('agent:submit', id, prompt.trim(), { cwd }).catch((err) => {
      process.stderr.write(`\n[submit failed: ${err?.message ?? err}]\n`);
      finish();
    });
  });
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    // If stdin is already closed/empty, resolve promptly.
    if (process.stdin.readableEnded) resolve(data);
  });
}
