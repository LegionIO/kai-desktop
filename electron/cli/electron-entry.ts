import { getSocketPath, getBridgeToken } from '../local-bridge/paths.js';
import { tryConnect } from './client.js';
import { startRepl } from './ui.js';
import { runHeadlessOnce, parseHeadlessArgs } from './headless-run.js';
import { spawnHeadlessBackend, waitForSocket, recoverBackend, cliLog, BOOT_TIMEOUT_MS } from './spawn-backend.js';

/**
 * Run the `kai` CLI client from inside the packaged Electron main process
 * (launched via `--kai-cli`). Connects to the backend over the local socket,
 * spawning a headless backend (this same signed binary, re-exec'd with
 * `--kai-headless`) if none is running, then runs the Ink REPL against the
 * inherited terminal TTY. On exit it terminates the Electron process.
 *
 * A `-p/--print [prompt]` / `--prompt=` / `--json` flag (parsed from argv, which
 * still carries `--kai-cli` — harmlessly ignored) runs one-shot headless instead
 * of the REPL, matching the standalone `kai` entry.
 */
export async function runCliClient(): Promise<void> {
  // Silence Node's own deprecation warnings (e.g. the `punycode` DEP0040 a
  // transitive dep triggers) — printed to stderr before our UI draws and pure
  // noise to a `kai` user who can't act on them.
  process.noDeprecation = true;

  const { print, prompt, json } = parseHeadlessArgs(process.argv.slice(2));

  const socketPath = getSocketPath();
  const token = getBridgeToken();
  // In the interactive Ink REPL the banner UI draws immediately, so transient
  // "attached"/"ready" status lines only orphan above it. Keep them for
  // headless/scripting (stderr) where there's no UI to replace them.
  const interactive = !print && process.stdin.isTTY && process.stdout.isTTY;

  let client = await tryConnect(socketPath, token);
  if (!client) {
    if (!interactive) cliLog('no running Kai backend found — starting a headless one…');
    if (!spawnHeadlessBackend(true)) {
      process.exit(1);
    }
    client = await waitForSocket(socketPath, BOOT_TIMEOUT_MS, token);
    if (!client) {
      cliLog('timed out waiting for the headless backend to come up');
      process.exit(1);
    }
    if (!interactive) cliLog('headless backend ready');
  } else {
    if (!interactive) cliLog('attached to running Kai backend');
  }

  // On any exit, close the socket so the backend can reap itself promptly.
  const activeClient = client;
  process.on('exit', () => activeClient.close());

  if (interactive) {
    await startRepl(activeClient, () => recoverBackend(activeClient, true));
    process.exit(0);
  } else {
    await runHeadlessOnce(activeClient, { prompt, json });
    await activeClient.requestShutdown();
    activeClient.close();
    process.exit(0);
  }
}
