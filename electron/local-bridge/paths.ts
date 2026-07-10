import { homedir } from 'os';
import { join } from 'path';
import { createHash, randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs';

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

/**
 * Per-install bridge auth token. On POSIX the 0700 run-dir already gates the
 * socket, but win32 named pipes have no equivalent owner-only ACL, so a
 * predictable pipe name would let any local process invoke the handler surface.
 * A random token stored in the (owner-only on POSIX) run dir, required in the
 * client's connect handshake, closes that gap portably and adds defense-in-depth
 * everywhere. Generated once, reused by every client + the server.
 */
export function getBridgeToken(): string {
  const runDir = getRunDir();
  const tokenPath = join(runDir, 'bridge.token');
  if (existsSync(tokenPath)) {
    try {
      const t = readFileSync(tokenPath, 'utf-8').trim();
      if (t) return t;
    } catch {
      /* fall through to regenerate */
    }
  }
  if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  writeFileSync(tokenPath, token, { encoding: 'utf-8', mode: 0o600 });
  try {
    chmodSync(tokenPath, 0o600);
  } catch {
    /* best-effort on platforms without POSIX modes */
  }
  return token;
}
