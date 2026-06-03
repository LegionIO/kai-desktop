#!/usr/bin/env node
/**
 * Fake `pi` CLI for the pi-runtime integration test.
 *
 * Stands in for the real `pi --mode json` binary so the integration test can
 * exercise the REAL spawn / stdin / stdout / exit / process-group-kill paths
 * of PiRuntime without depending on a real pi install or an LLM call.
 *
 * Behaviour is driven by env vars (the runtime forwards env to the child):
 *   PI_FAKE_MODE      'normal' (default) | 'fail' | 'hang'
 *   PI_FAKE_RECORD    if set, write {argv, stdin, hasAnthropicKey, hasOpenAiKey}
 *                     as JSON to this path (lets the test assert that the key
 *                     came via env and the prompt via stdin, on a real spawn)
 *   PI_FAKE_PIDFILE   in 'hang' mode, the spawned grandchild's pid is written
 *                     here so the test can verify it gets reaped on abort
 *
 * Emits pi-shaped JSONL events on stdout, one per line, matching the subset
 * PiRuntime.translatePiEvent understands.
 */
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  process.stdin.setEncoding('utf8');
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

const argv = process.argv.slice(2);

const stdin = await readStdin();

if (process.env.PI_FAKE_RECORD) {
  writeFileSync(
    process.env.PI_FAKE_RECORD,
    JSON.stringify({
      argv,
      stdin,
      hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
      hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
    }),
  );
}

const mode = process.env.PI_FAKE_MODE ?? 'normal';

if (mode === 'fail') {
  process.stderr.write('fake pi: simulated failure\n');
  process.exit(2);
}

if (mode === 'hang') {
  // Spawn a long-lived grandchild in the SAME process group. The runtime
  // spawned us detached (group leader), so a process-group kill on abort must
  // take this grandchild down too. Record its pid for the test to check.
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
    stdio: 'ignore',
  });
  if (process.env.PI_FAKE_PIDFILE) {
    writeFileSync(process.env.PI_FAKE_PIDFILE, String(grandchild.pid));
  }
  // Emit one event so the consumer sees a live stream, then hang forever.
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'working…' } });
  // Keep the event loop alive indefinitely (until killed).
  setInterval(() => {}, 1 << 30);
} else {
  // 'normal': a representative successful turn.
  emit({ type: 'header', sessionId: 'fake-session-header' }); // ignored by translator
  emit({ type: 'agent_start' });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello from ' } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'fake pi.' } });
  emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } });
  emit({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: 'a.txt\nb.txt', isError: false });
  emit({ type: 'turn_end', message: { usage: { inputTokens: 12, outputTokens: 7 } } });
  emit({ type: 'agent_end' });
  process.exit(0);
}
