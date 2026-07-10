import { homedir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';

/**
 * Base app-home directory. Honors `KAI_USER_DATA` so a dev/headless instance
 * pointed at an isolated home serves its socket from THAT home — never the real
 * `~/.kai` of a separately-running production app. Mirrors `resolveUserDataDir`
 * in main.ts.
 */
export function getAppHome(): string {
  const override = process.env.KAI_USER_DATA;
  if (override && override.length > 0) return override;
  return join(homedir(), '.' + __BRAND_APP_SLUG);
}

/** Directory holding leader runtime state (socket + pidfile). */
export function getRunDir(): string {
  return join(getAppHome(), 'run');
}

/** Path to the leader's local IPC socket (unix domain socket / win32 named pipe). */
export function getSocketPath(): string {
  if (process.platform === 'win32') {
    const tag = createHash('sha256').update(getAppHome()).digest('hex').slice(0, 12);
    return '\\\\.\\pipe\\' + __BRAND_APP_SLUG + '-leader-' + tag;
  }
  return join(getRunDir(), 'kai.sock');
}
