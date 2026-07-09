import { spawn } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';
import { tryConnect, type LocalBridgeClient } from './client.js';
import { getSocketPath } from '../local-bridge/paths.js';
import { startRepl } from './ui.js';

const CONNECT_RETRY_MS = 300;
const BOOT_TIMEOUT_MS = 30_000;

function log(msg: string): void {
  process.stderr.write(`[kai] ${msg}\n`);
}

/** Resolve the Electron binary + main bundle for spawning a headless leader. */
function resolveElectron(): { electron: string; mainBundle: string } | null {
  // In dev/packaged the main bundle sits at out/main/index.js relative to the
  // repo/app root. `import.meta.dirname` for this file is out/cli, so root is two up.
  const root = join(import.meta.dirname, '..', '..');
  const mainBundle = join(root, 'out', 'main', 'index.js');
  const electron =
    process.platform === 'win32'
      ? join(root, 'node_modules', '.bin', 'electron.cmd')
      : join(root, 'node_modules', '.bin', 'electron');
  if (!existsSync(mainBundle)) return null;
  return { electron, mainBundle };
}

/**
 * Spawn a detached headless Electron leader. Returns once spawned; the caller
 * then polls the socket until the backend is listening.
 */
function spawnHeadlessLeader(): boolean {
  const resolved = resolveElectron();
  if (!resolved) {
    log('cannot locate the Electron main bundle (out/main/index.js) — run `pnpm build` first');
    return false;
  }
  const child = spawn(resolved.electron, [resolved.mainBundle, '--kai-headless'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, KAI_HEADLESS: '1' },
  });
  child.unref();
  return true;
}

async function waitForSocket(socketPath: string, deadlineMs: number): Promise<LocalBridgeClient | null> {
  const start = Date.now();
  for (;;) {
    const client = await tryConnect(socketPath);
    if (client) return client;
    if (Date.now() - start > deadlineMs) return null;
    await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS));
  }
}

async function main(): Promise<void> {
  const socketPath = getSocketPath();

  // 1. Try to attach to an existing leader (GUI or another CLI's headless backend).
  let client = await tryConnect(socketPath);

  // 2. None running — boot our own headless leader, then wait for its socket.
  if (!client) {
    log('no running Kai backend found — starting a headless one…');
    if (!spawnHeadlessLeader()) process.exit(1);
    client = await waitForSocket(socketPath, BOOT_TIMEOUT_MS);
    if (!client) {
      log('timed out waiting for the headless backend to come up');
      process.exit(1);
    }
    log('headless backend ready');
  } else {
    log('attached to running Kai backend');
  }

  // Interactive TTY → full Ink TUI. Non-TTY (piped/CI) → one-shot text mode,
  // since Ink's input needs raw mode (a real terminal).
  if (process.stdin.isTTY && process.stdout.isTTY) {
    await startRepl(client);
  } else {
    const { runHeadlessOnce } = await import('./headless-run.js');
    await runHeadlessOnce(client);
    process.exit(0);
  }
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
