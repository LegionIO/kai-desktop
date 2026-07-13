import { getSocketPath, getBridgeToken } from '../local-bridge/paths.js';
import { tryConnect } from './client.js';
import { startRepl } from './ui.js';
import { runHeadlessOnce, parseHeadlessArgs } from './headless-run.js';
import {
  spawnHeadlessBackend,
  waitForSocket,
  recoverBackend,
  cliLog,
  checkVersionMismatch,
  BOOT_TIMEOUT_MS,
} from './spawn-backend.js';
import { confirmFolderTrust } from './folder-trust.js';

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

  // Workspace trust: in the interactive REPL the agent can run tools scoped to
  // this directory, so gate an unfamiliar folder behind an explicit "do you
  // trust this folder?" before we spawn/attach a backend. HOME + already-trusted
  // dirs pass silently. Declining exits (conservative v1). Headless (-p) does not
  // prompt — it requires an already-trusted folder.
  if (interactive) {
    const trusted = await confirmFolderTrust(process.cwd());
    if (!trusted) {
      cliLog('folder not trusted — exiting. Re-run and choose trust, or cd to a trusted folder.');
      process.exit(0);
    }
  }

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

  // Surface a CLI↔backend version mismatch (a stale backend still running after
  // an app update is the usual cause of "the fixes aren't in my build").
  const mismatch = checkVersionMismatch(activeClient);
  if (mismatch) cliLog(mismatch);

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
