import net from 'net';
import { mkdirSync, existsSync, unlinkSync, chmodSync } from 'fs';
import type { Socket, Server } from 'net';
import { localClients, broadcastToLocalClients } from './local-clients.js';
import { registerBroadcastSink } from '../web-server/web-clients.js';
import { invokeHandler } from '../web-server/ipc-bridge.js';
import { getRunDir, getSocketPath } from './paths.js';

export { getRunDir, getSocketPath } from './paths.js';

let server: Server | null = null;
let unregisterSink: (() => void) | null = null;

/**
 * Backend lifetime for a headless (CLI-spawned) leader. It must NOT outlive its
 * clients — an orphaned leader keeps firing automations/hooks and holding the
 * singleton lock. Two mechanisms:
 *
 *  1. Client-initiated (primary): the last client, on quit, sends
 *     `{type:'shutdown'}`. The backend confirms no other clients remain, lets
 *     in-flight work settle very briefly, and exits — near-immediate.
 *  2. Idle safety-net (fallback for crashes where no shutdown is sent): if the
 *     backend has zero clients it exits after a short grace. Kept well under
 *     10s so a killed client doesn't leave the backend lingering long.
 *
 * A windowed/GUI leader passes `idleShutdown: false` so it persists as normal.
 */
const IDLE_SHUTDOWN_GRACE_MS = 4000;
/** Grace at startup so a slow first client connect doesn't kill the backend. */
const INITIAL_IDLE_GRACE_MS = 8000;
/** Brief settle window after an explicit shutdown request for in-flight work. */
const SHUTDOWN_SETTLE_MS = 400;
/** No inbound traffic for this long ⇒ client considered dead, socket destroyed.
 *  Kept low so a half-open socket (Ctrl-C / crash where no FIN is delivered) is
 *  detected quickly and the backend can reap itself. The client pings ~5s. */
const HEARTBEAT_TIMEOUT_MS = 12000;
let idleShutdownEnabled = false;
let idleTimer: NodeJS.Timeout | null = null;
let hasOtherClients: (() => boolean) | null = null;
let onIdleExit: (() => void) | null = null;
/** Set when a client explicitly requested shutdown — triggers fast exit on disconnect. */
let shutdownRequested = false;

function clientCount(): number {
  return localClients.size + (hasOtherClients?.() ? 1 : 0);
}

function cancelIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function maybeScheduleIdleShutdown(): void {
  if (!idleShutdownEnabled) return;
  cancelIdleTimer();
  if (clientCount() > 0) return;
  // Explicit shutdown request ⇒ near-immediate exit (short settle for in-flight
  // automations/hooks). Otherwise the longer idle safety-net grace.
  const delay = shutdownRequested ? SHUTDOWN_SETTLE_MS : IDLE_SHUTDOWN_GRACE_MS;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    // Re-check under the timer in case a client reconnected during the grace window.
    if (clientCount() === 0) {
      onIdleExit?.();
    }
  }, delay);
}

/**
 * A single client connection's inbound buffer. The bridge speaks
 * newline-delimited JSON: each line is one `{id,type,channel,args}` request.
 */
function attachClient(socket: Socket): void {
  localClients.add(socket);
  socket.setNoDelay(true);
  cancelIdleTimer(); // a client is present — cancel any pending idle shutdown

  // Heartbeat: the client is expected to send {type:'ping'} periodically. If we
  // see no traffic for HEARTBEAT_TIMEOUT_MS we consider the client dead and
  // destroy the socket — this catches force-kills / crashes / sleep where the
  // OS never delivers a clean close, so an orphaned backend can still notice
  // its client vanished and (if idle-shutdown is on) exit.
  let alive = true;
  const beat = setInterval(() => {
    if (!alive) {
      clearInterval(beat);
      socket.destroy();
      return;
    }
    alive = false;
  }, HEARTBEAT_TIMEOUT_MS);

  let buffer = '';
  socket.on('data', (chunk: Buffer) => {
    alive = true; // any inbound traffic counts as liveness
    buffer += chunk.toString('utf-8');
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim()) void handleMessage(socket, line);
    }
  });

  const onGone = (): void => {
    clearInterval(beat);
    localClients.delete(socket);
    maybeScheduleIdleShutdown();
  };
  socket.on('close', onGone);
  socket.on('error', onGone);
}

async function handleMessage(socket: Socket, line: string): Promise<void> {
  let msg: { id?: string; type?: string; channel?: string; args?: unknown[]; data?: unknown };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.type === 'ping') {
    writeLine(socket, { type: 'pong' });
    return;
  }

  // Client-initiated shutdown: the last client asks the backend to exit. Ack
  // so the client can show "Cleaning up…" and close its socket; once it's gone
  // (and no other clients remain) we exit after a brief settle window. If other
  // clients are still attached, this is a no-op — another front-end needs it.
  if (msg.type === 'shutdown') {
    writeLine(socket, { id: msg.id, type: 'result', data: { ok: true } });
    if (idleShutdownEnabled) shutdownRequested = true;
    return;
  }

  if (msg.type === 'invoke' && msg.channel && msg.id) {
    try {
      const result = await invokeHandler(msg.channel, ...(msg.args ?? []));
      writeLine(socket, { id: msg.id, type: 'result', data: result });
    } catch (err) {
      writeLine(socket, {
        id: msg.id,
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // Fire-and-forget sends (e.g. realtime audio), mirroring the web bridge.
  if (msg.type === 'send' && msg.channel) {
    try {
      await invokeHandler(msg.channel, msg.data);
    } catch {
      // Ignore errors on fire-and-forget
    }
  }
}

function writeLine(socket: Socket, obj: unknown): void {
  try {
    if (socket.writable) socket.write(JSON.stringify(obj) + '\n');
  } catch {
    // stale socket — will be cleaned up on close/error
  }
}

/**
 * Options controlling backend lifetime.
 * - `idleShutdown`: when true (headless CLI-spawned leader), the process exits
 *   a grace period after its last client disconnects. A windowed/GUI leader
 *   omits this so it persists.
 * - `hasOtherClients`: optional predicate for non-local client surfaces (e.g.
 *   open GUI windows, connected web clients) so idle-shutdown only fires when
 *   truly nobody is attached.
 * - `onIdleExit`: invoked when the idle grace period elapses with no clients;
 *   main.ts wires this to `app.quit()`.
 */
export interface LocalServerOptions {
  idleShutdown?: boolean;
  hasOtherClients?: () => boolean;
  onIdleExit?: () => void;
}

/**
 * Start the leader's local IPC socket. Always called by the leader process
 * (windowed GUI or headless), independent of the user-facing web server toggle.
 * Idempotent: a second call is a no-op while a server is already listening.
 */
export function startLocalServer(options: LocalServerOptions = {}): Promise<string> {
  if (server) return Promise.resolve(getSocketPath());

  idleShutdownEnabled = options.idleShutdown ?? false;
  hasOtherClients = options.hasOtherClients ?? null;
  onIdleExit = options.onIdleExit ?? null;

  const socketPath = getSocketPath();
  const runDir = getRunDir();
  if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true });

  // Remove a stale socket file left by a previous (crashed) leader. On win32
  // named pipes are not filesystem entries, so this only applies elsewhere.
  if (process.platform !== 'win32' && existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      // If we can't remove it, listen() will surface EADDRINUSE below.
    }
  }

  // Fan every web-client broadcast out to local clients too.
  unregisterSink = registerBroadcastSink(broadcastToLocalClients);

  const srv = net.createServer(attachClient);
  server = srv;

  return new Promise<string>((resolve, reject) => {
    srv.once('error', (err) => {
      server = null;
      unregisterSink?.();
      unregisterSink = null;
      reject(err);
    });
    srv.listen(socketPath, () => {
      // Restrict the socket to the current user (best-effort; no-op on win32).
      if (process.platform !== 'win32') {
        try {
          chmodSync(socketPath, 0o600);
        } catch {
          // non-fatal
        }
      }
      resolve(socketPath);
      // A headless backend boots with zero clients (the spawning CLI connects a
      // moment later). Schedule an initial idle check with a longer grace so a
      // backend that never gets a client still exits instead of lingering.
      if (idleShutdownEnabled) {
        idleTimer = setTimeout(() => {
          idleTimer = null;
          if (clientCount() === 0) onIdleExit?.();
        }, INITIAL_IDLE_GRACE_MS);
      }
    });
  });
}

/**
 * Turn off idle self-shutdown at runtime. Called when a headless backend is
 * promoted to windowed (a GUI attached), so the backend now persists like a
 * normal GUI leader instead of reaping itself when socket clients disconnect.
 */
export function disableIdleShutdown(): void {
  idleShutdownEnabled = false;
  cancelIdleTimer();
}

/**
 * Re-arm idle self-shutdown at runtime. Called when a windowed backend is
 * demoted back to headless (its last GUI window closed while CLIs remain): the
 * backend should reap itself once the last socket client disconnects. Schedules
 * an immediate idle check in case there are already no clients.
 */
export function restartIdleShutdown(): void {
  idleShutdownEnabled = true;
  maybeScheduleIdleShutdown();
}

export async function stopLocalServer(): Promise<void> {
  // Cancel any pending idle-shutdown and reset lifecycle state FIRST, so a
  // stale timer can't fire an old onIdleExit after stop (or after a restart
  // reconfigures these). Everything is re-set by the next startLocalServer.
  idleShutdownEnabled = false;
  cancelIdleTimer();
  shutdownRequested = false;
  hasOtherClients = null;
  onIdleExit = null;

  unregisterSink?.();
  unregisterSink = null;

  for (const socket of localClients) {
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  }
  localClients.clear();

  const srv = server;
  server = null;
  if (!srv) return;

  await new Promise<void>((resolve) => srv.close(() => resolve()));

  if (process.platform !== 'win32' && existsSync(getSocketPath())) {
    try {
      unlinkSync(getSocketPath());
    } catch {
      /* ignore */
    }
  }
}
