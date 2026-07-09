import { spawn } from 'child_process';
import { join } from 'path';
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
    child.unref();
    return true;
  }

  // Dev: locate node_modules/.bin/electron + the built main bundle.
  const root = join(import.meta.dirname, '..', '..');
  const mainBundle = join(root, 'out', 'main', 'index.js');
  const electron =
    process.platform === 'win32'
      ? join(root, 'node_modules', '.bin', 'electron.cmd')
      : join(root, 'node_modules', '.bin', 'electron');
  if (!existsSync(mainBundle)) {
    cliLog('cannot locate the Electron main bundle (out/main/index.js) — run `pnpm build` first');
    return false;
  }
  const child = spawn(electron, [mainBundle, '--kai-headless'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, KAI_HEADLESS: '1', KAI_CLI: '' },
  });
  child.unref();
  return true;
}

/** Poll the socket until a backend is listening, or the deadline passes. */
export async function waitForSocket(socketPath: string, deadlineMs: number): Promise<LocalBridgeClient | null> {
  const start = Date.now();
  for (;;) {
    const client = await tryConnect(socketPath);
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
