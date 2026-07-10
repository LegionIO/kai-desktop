import { getSocketPath, getBridgeToken } from '../local-bridge/paths.js';
import { tryConnect } from './client.js';
import { startRepl } from './ui.js';
import { runHeadlessOnce } from './headless-run.js';
import { spawnHeadlessBackend, waitForSocket, recoverBackend, cliLog, BOOT_TIMEOUT_MS } from './spawn-backend.js';

/**
 * Standalone (dev) `kai` entry: run with system node against the built bundle
 * (`node out/main/cli.js`). Spawns the DEV electron binary for the backend. The
 * packaged CLI uses `cli/electron-entry.ts` instead (re-execs the app binary).
 */
async function main(): Promise<void> {
  const socketPath = getSocketPath();
  const token = getBridgeToken();

  let client = await tryConnect(socketPath, token);
  if (!client) {
    cliLog('no running Kai backend found — starting a headless one…');
    if (!spawnHeadlessBackend(false)) process.exit(1);
    client = await waitForSocket(socketPath, BOOT_TIMEOUT_MS, token);
    if (!client) {
      cliLog('timed out waiting for the headless backend to come up');
      process.exit(1);
    }
    cliLog('headless backend ready');
  } else {
    cliLog('attached to running Kai backend');
  }

  const activeClient = client;
  process.on('exit', () => activeClient.close());

  if (process.stdin.isTTY && process.stdout.isTTY) {
    await startRepl(activeClient, () => recoverBackend(activeClient, false));
    process.exit(0);
  } else {
    await runHeadlessOnce(activeClient);
    await activeClient.requestShutdown();
    activeClient.close();
    process.exit(0);
  }
}

main().catch((err) => {
  cliLog(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
