import { parseMcpCommand, runMcpCommand } from './mcp-auth.js';
import { parseMcpServe, serveMcp } from './mcp-serve.js';
import { getSocketPath, getBridgeToken } from '../local-bridge/paths.js';
import { tryConnect } from './client.js';
import { startRepl } from './ui.js';
import { runHeadlessOnce, parseHeadlessArgs, helpText, listResources } from './headless-run.js';
import {
  spawnHeadlessBackend,
  waitForSocket,
  recoverBackend,
  cliLog,
  checkVersionMismatch,
  BOOT_TIMEOUT_MS,
} from './spawn-backend.js';
import { confirmFolderTrust } from './folder-trust.js';
import { parseEventsArgs, runEvents, runEventsCommand } from './events.js';

/**
 * Standalone (dev) `kai` entry: run with system node against the built bundle
 * (`node out/main/cli.js`). Spawns the DEV electron binary for the backend. The
 * packaged CLI uses `cli/electron-entry.ts` instead (re-execs the app binary).
 */
async function main(): Promise<void> {
  const connector = parseMcpServe(process.argv.slice(2));
  if (connector) {
    await serveMcp(connector.credential, false);
    return;
  }
  process.noDeprecation = true; // silence Node DEP warnings (e.g. punycode) — noise to a `kai` user
  const { print, prompt, json, help, modelKey, profileKey, reasoningEffort, fallbackEnabled, runtimeOverride, list } =
    parseHeadlessArgs(process.argv.slice(2));

  if (help) {
    process.stdout.write(helpText() + '\n');
    return process.exit(0);
  }

  const mcpCommand = parseMcpCommand(process.argv.slice(2));
  const eventsCommand = parseEventsArgs(process.argv.slice(2));
  const eventsFilter = eventsCommand?.kind === 'stream' ? eventsCommand.filter : undefined;
  const socketPath = getSocketPath();
  const token = getBridgeToken();
  // Interactive REPL only when we have a real terminal AND no one-shot flag. In
  // the REPL the banner UI replaces these status lines, so keep them for the
  // headless/scripting path only (stderr).
  const interactive = !print && !eventsCommand && process.stdin.isTTY && process.stdout.isTTY;

  // Workspace trust: gate an unfamiliar folder behind an explicit prompt before
  // spawning/attaching a backend (the interactive REPL can run tools scoped to
  // the cwd). HOME + already-trusted dirs pass silently; declining exits.
  if (interactive) {
    const trusted = await confirmFolderTrust(process.cwd());
    if (!trusted) {
      cliLog('folder not trusted — exiting. Re-run and choose trust, or cd to a trusted folder.');
      return process.exit(0);
    }
  }

  // Hook commands run on every session/turn: stay silent and never boot a backend for them.
  const hookMode = !!(eventsFilter?.rewake || eventsFilter?.drain || eventsCommand?.kind === 'hint');
  const quiet = interactive || hookMode;
  let client = await tryConnect(socketPath, token);
  // Agent wake hooks fire on every session/turn: never boot a backend for them.
  if (!client && hookMode) return process.exit(0);
  if (!client) {
    if (!quiet) cliLog('no running Kai backend found — starting a headless one…');
    if (!(await spawnHeadlessBackend(false))) return process.exit(1);
    client = await waitForSocket(socketPath, BOOT_TIMEOUT_MS, token);
    if (!client) {
      cliLog('timed out waiting for the headless backend to come up');
      return process.exit(1);
    }
    if (!quiet) cliLog('headless backend ready');
  } else {
    if (!quiet) cliLog('attached to running Kai backend');
  }

  const activeClient = client;
  process.on('exit', () => activeClient.close());

  const mismatch = checkVersionMismatch(activeClient);
  if (mismatch && !hookMode) cliLog(mismatch);

  if (mcpCommand) {
    try {
      await runMcpCommand(activeClient, mcpCommand);
    } finally {
      activeClient.close();
    }
    return process.exit(0);
  }

  if (eventsCommand) {
    const code =
      eventsCommand.kind === 'stream'
        ? await runEvents(activeClient, eventsCommand.filter, () => recoverBackend(activeClient, false))
        : await runEventsCommand(activeClient, eventsCommand);
    await activeClient.requestShutdown().catch(() => {});
    activeClient.close();
    return process.exit(code);
  }

  if (list) {
    await listResources(activeClient, list);
    activeClient.close();
    return process.exit(0);
  }

  if (interactive) {
    await startRepl(activeClient, () => recoverBackend(activeClient, false));
    return process.exit(0);
  } else {
    await runHeadlessOnce(activeClient, {
      prompt,
      json,
      modelKey,
      profileKey,
      reasoningEffort,
      fallbackEnabled,
      runtimeOverride,
      recover: () => recoverBackend(activeClient, false),
    });
    await activeClient.requestShutdown();
    activeClient.close();
    return process.exit(0);
  }
}

main().catch((err) => {
  cliLog(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
