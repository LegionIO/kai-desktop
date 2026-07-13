import { getSocketPath, getBridgeToken } from '../local-bridge/paths.js';
import { tryConnect } from './client.js';
import { startRepl } from './ui.js';
import { runHeadlessOnce, parseHeadlessArgs } from './headless-run.js';
import { spawnHeadlessBackend, waitForSocket, recoverBackend, cliLog, BOOT_TIMEOUT_MS } from './spawn-backend.js';
import { confirmFolderTrust } from './folder-trust.js';

/**
 * Standalone (dev) `kai` entry: run with system node against the built bundle
 * (`node out/main/cli.js`). Spawns the DEV electron binary for the backend. The
 * packaged CLI uses `cli/electron-entry.ts` instead (re-execs the app binary).
 */
async function main(): Promise<void> {
  process.noDeprecation = true; // silence Node DEP warnings (e.g. punycode) — noise to a `kai` user
  const { print, prompt, json } = parseHeadlessArgs(process.argv.slice(2));

  const socketPath = getSocketPath();
  const token = getBridgeToken();
  // Interactive REPL only when we have a real terminal AND no one-shot flag. In
  // the REPL the banner UI replaces these status lines, so keep them for the
  // headless/scripting path only (stderr).
  const interactive = !print && process.stdin.isTTY && process.stdout.isTTY;

  // Workspace trust: gate an unfamiliar folder behind an explicit prompt before
  // spawning/attaching a backend (the interactive REPL can run tools scoped to
  // the cwd). HOME + already-trusted dirs pass silently; declining exits.
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
    if (!spawnHeadlessBackend(false)) process.exit(1);
    client = await waitForSocket(socketPath, BOOT_TIMEOUT_MS, token);
    if (!client) {
      cliLog('timed out waiting for the headless backend to come up');
      process.exit(1);
    }
    if (!interactive) cliLog('headless backend ready');
  } else {
    if (!interactive) cliLog('attached to running Kai backend');
  }

  const activeClient = client;
  process.on('exit', () => activeClient.close());

  if (interactive) {
    await startRepl(activeClient, () => recoverBackend(activeClient, false));
    process.exit(0);
  } else {
    await runHeadlessOnce(activeClient, { prompt, json });
    await activeClient.requestShutdown();
    activeClient.close();
    process.exit(0);
  }
}

main().catch((err) => {
  cliLog(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
