import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { tryConnect, type LocalBridgeClient } from './client.js';

export const CONNECT_RETRY_MS = 300;
export const BOOT_TIMEOUT_MS = 30_000;

export function cliLog(msg: string): void {
  process.stderr.write(`[kai] ${msg}\n`);
}

/**
 * Spawn a detached headless backend.
 *
 * Two launch shapes:
 *  - **Packaged / in-Electron** (`fromElectron: true`): re-exec THIS Electron
 *    binary (`process.execPath`) with `--kai-headless`. The app's own signed
 *    binary is the backend; no separate Node runtime needed and the security
 *    fuses stay locked (normal main-process Node, not RunAsNode).
 *  - **Dev / standalone node** (`fromElectron: false`): run the dev electron
 *    binary against `out/main/index.js`.
 */
export function spawnHeadlessBackend(fromElectron: boolean): boolean {
  if (fromElectron) {
    const child = spawn(process.execPath, ['--kai-headless'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, KAI_HEADLESS: '1', KAI_CLI: '' },
    });
    child.on('error', (err) => {
      cliLog(`failed to spawn headless backend: ${err instanceof Error ? err.message : String(err)}`);
    });
    child.unref();
    return true;
  }

  // Dev: locate the built main bundle + node_modules/.bin/electron. Resolve
  // from the CLI ENTRY path (process.argv[1] = .../out/main/cli.js), NOT
  // import.meta.dirname — bundling emits shared code into out/main/chunks/, so
  // import.meta.dirname would point there and mis-resolve the paths.
  const entryDir = dirname(process.argv[1] ?? ''); // .../out/main
  const mainBundle = join(entryDir, 'index.js'); // sibling of cli.js
  const root = join(entryDir, '..', '..'); // repo root (out/main → up 2)
  // On Windows, node_modules/.bin/electron is a .cmd shim that CreateProcess
  // cannot exec directly (spawn without a shell → ENOENT/EINVAL). Spawn the real
  // electron.exe from the package's dist dir instead; fall back to the POSIX bin.
  const electron =
    process.platform === 'win32'
      ? join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
      : join(root, 'node_modules', '.bin', 'electron');
  if (!existsSync(mainBundle)) {
    cliLog('cannot locate the Electron main bundle (out/main/index.js) — run `pnpm build` first');
    return false;
  }
  if (!existsSync(electron)) {
    cliLog(`cannot locate the dev Electron binary at ${electron} — run \`pnpm install\` first`);
    return false;
  }
  const child = spawn(electron, [mainBundle, '--kai-headless'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, KAI_HEADLESS: '1', KAI_CLI: '' },
  });
  child.on('error', (err) => {
    cliLog(`failed to spawn dev backend: ${err instanceof Error ? err.message : String(err)}`);
  });
  child.unref();
  return true;
}

/** Poll the socket until a backend is listening, or the deadline passes. */
export async function waitForSocket(
  socketPath: string,
  deadlineMs: number,
  authToken?: string,
): Promise<LocalBridgeClient | null> {
  const start = Date.now();
  for (;;) {
    const client = await tryConnect(socketPath, authToken);
    if (client) return client;
    if (Date.now() - start > deadlineMs) return null;
    await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS));
  }
}

/**
 * Recover from an unexpected backend disconnect (leader crash): reconnect to a
 * surviving/re-elected leader first, else spawn a fresh headless backend and
 * reconnect. Preserves the client's event subscriptions.
 */
export async function recoverBackend(client: LocalBridgeClient, fromElectron: boolean): Promise<boolean> {
  if (await client.reconnect(6000)) return true;
  cliLog('backend gone — starting a new headless one…');
  if (!spawnHeadlessBackend(fromElectron)) return false;
  return client.reconnect(BOOT_TIMEOUT_MS);
}
