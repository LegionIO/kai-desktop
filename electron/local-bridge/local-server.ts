import net from 'net';
import { mkdirSync, existsSync, unlinkSync, chmodSync, statSync } from 'fs';
import { timingSafeEqual } from 'crypto';
import type { Socket, Server } from 'net';
import { localClients, broadcastToLocalClients, markSocketActivity, msSinceActivity } from './local-clients.js';
import { registerBroadcastSink } from '../web-server/web-clients.js';
import { invokeHandler } from '../web-server/ipc-bridge.js';
import { getRunDir, getSocketPath, getBridgeToken } from './paths.js';

export { getRunDir, getSocketPath } from './paths.js';

/** Sockets that have completed the auth handshake ({type:'auth', token}).
 *  invoke/send are refused until a socket is in this set. */
const authedClients = new WeakSet<Socket>();

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
/** Hard cap on a single newline-delimited inbound frame (and on total buffered
 *  bytes before a newline). A malformed/malicious same-user client must not be
 *  able to grow the singleton backend's memory without bound. 8 MiB comfortably
 *  covers legitimate payloads (image data URLs, large prompts) while bounding abuse. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
let idleShutdownEnabled = false;
let idleTimer: NodeJS.Timeout | null = null;
let hasOtherClients: (() => boolean) | null = null;
let onIdleExit: (() => void) | null = null;
/** Backend (app) version, sent in the auth result so a client can detect a
 *  CLI-vs-backend version mismatch (e.g. after an app update while an old
 *  backend is still running). Empty string when unknown. */
let serverVersion = '';
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
/** Auth handshake deadline: a socket that doesn't authenticate within this is
 *  destroyed. Prevents an unauthenticated socket from holding a slot / keeping a
 *  headless backend alive with pre-auth pings. */
const AUTH_TIMEOUT_MS = 5000;

function attachClient(socket: Socket): void {
  // Do NOT add to localClients yet — an unauthenticated socket must not receive
  // broadcasts (info leak) or count toward keeping the backend alive. It joins
  // the client set only after a successful auth handshake (see handleMessage).
  socket.setNoDelay(true);

  // Destroy the socket if it doesn't complete the auth handshake in time.
  const authTimer = setTimeout(() => {
    if (!authedClients.has(socket)) {
      writeLine(socket, { type: 'error', message: 'auth timeout' });
      socket.destroy();
    }
  }, AUTH_TIMEOUT_MS);

  // Heartbeat: the client is expected to send {type:'ping'} periodically. If we
  // see NO traffic in EITHER direction for HEARTBEAT_TIMEOUT_MS we consider the
  // client dead and destroy the socket — catching force-kills / crashes / sleep
  // where the OS never delivers a clean close. Timestamp-based (not a per-tick
  // boolean flip) and counting OUTBOUND writes too (markSocketActivity in
  // broadcastToLocalClients): during a heavy agent stream the client's ping can
  // be delayed by its own busy event loop, but we're actively streaming TO it —
  // so it's plainly alive and must not be reaped mid-stream.
  markSocketActivity(socket);
  const beat = setInterval(() => {
    if (msSinceActivity(socket) > HEARTBEAT_TIMEOUT_MS) {
      clearInterval(beat);
      socket.destroy();
    }
  }, HEARTBEAT_TIMEOUT_MS);

  let buffer = '';
  socket.on('data', (chunk: Buffer) => {
    markSocketActivity(socket); // any inbound traffic counts as liveness
    buffer += chunk.toString('utf-8');
    // Bound the pre-newline buffer: a client that never sends a newline (or sends
    // an oversized frame) must not grow backend memory without limit.
    if (buffer.length > MAX_FRAME_BYTES) {
      console.warn('[local-bridge] inbound frame exceeded MAX_FRAME_BYTES; destroying socket');
      socket.destroy();
      return;
    }
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim()) void handleMessage(socket, line);
    }
  });

  const onGone = (): void => {
    clearInterval(beat);
    clearTimeout(authTimer);
    authedClients.delete(socket);
    localClients.delete(socket);
    maybeScheduleIdleShutdown();
  };
  socket.on('close', onGone);
  socket.on('error', onGone);
}

async function handleMessage(socket: Socket, line: string): Promise<void> {
  let msg: { id?: string; type?: string; channel?: string; args?: unknown[]; data?: unknown; token?: string };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.type === 'ping') {
    writeLine(socket, { type: 'pong' });
    return;
  }

  // Auth handshake: a client must present the per-install bridge token before it
  // can invoke handlers or send events. This gates the win32 named pipe (which
  // has no owner-only ACL) and is defense-in-depth on POSIX. Compare in constant
  // time to avoid a timing oracle on the token.
  if (msg.type === 'auth') {
    const expected = getBridgeToken();
    const provided = typeof msg.token === 'string' ? msg.token : '';
    const ok = provided.length === expected.length && timingSafeEqualStr(provided, expected);
    if (ok) {
      authedClients.add(socket);
      // Now (and only now) join the broadcast set + count toward liveness.
      localClients.add(socket);
      cancelIdleTimer();
      // Include the backend version so the client can flag a mismatch with its
      // own build (a stale backend still running after an app update).
      writeLine(socket, { id: msg.id, type: 'result', data: { ok: true, serverVersion } });
    } else {
      writeLine(socket, { id: msg.id, type: 'error', message: 'auth failed' });
      socket.destroy();
    }
    return;
  }

  // Everything below requires authentication.
  if (!authedClients.has(socket)) {
    if (msg.id) writeLine(socket, { id: msg.id, type: 'error', message: 'unauthenticated' });
    socket.destroy();
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
    // Validate args is a bounded array before spreading into the handler.
    if (msg.args !== undefined && (!Array.isArray(msg.args) || msg.args.length > 64)) {
      writeLine(socket, { id: msg.id, type: 'error', message: 'invalid args' });
      return;
    }
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

/** Constant-time string compare for the auth token (avoids a timing oracle). */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
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
  /** Backend/app version, echoed in the auth result for client mismatch detection. */
  serverVersion?: string;
}

/**
 * Ensure `runDir` exists as a private (0700), self-owned directory before we
 * bind the IPC socket inside it. Throws (fail-closed) if the dir exists but is
 * owned by another uid or is group/world-accessible — we must not host the
 * handler-invoking socket in a directory another user could plant entries in or
 * traverse. POSIX-only; win32 named pipes use a different namespace.
 */
function ensurePrivateRunDir(runDir: string): void {
  if (!existsSync(runDir)) {
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
  }
  // mkdir's mode is masked by umask, and a pre-existing dir keeps its old mode,
  // so tighten explicitly, then verify.
  chmodSync(runDir, 0o700);
  const st = statSync(runDir);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`Run dir ${runDir} is owned by uid ${st.uid}, not this user — refusing to bind IPC socket.`);
  }
  if ((st.mode & 0o077) !== 0) {
    throw new Error(
      `Run dir ${runDir} is group/world-accessible (mode ${(st.mode & 0o777).toString(8)}) — refusing to bind IPC socket.`,
    );
  }
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
  serverVersion = options.serverVersion ?? '';

  const socketPath = getSocketPath();
  const runDir = getRunDir();
  // The socket is our IPC boundary: anyone who can connect can invoke captured
  // handlers. Socket-inode perms are racy (they only apply after listen()) and
  // not portable, so the DIRECTORY is the real gate. Create/verify it as an
  // owner-only (0700), self-owned dir BEFORE binding, and fail closed otherwise
  // — refusing to serve is safer than exposing the handler surface. Reject
  // (don't throw synchronously) so the caller's .catch() runs its fail path.
  try {
    if (process.platform !== 'win32') {
      ensurePrivateRunDir(runDir);
    } else if (!existsSync(runDir)) {
      mkdirSync(runDir, { recursive: true });
    }
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }

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

/**
 * Re-evaluate idle shutdown after a NON-local client surface changed (e.g. a
 * web-UI client connected/disconnected). The idle scheduler otherwise only runs
 * on local-socket close, so without this a demoted backend serving only web
 * clients would never reap after the last browser disconnects. No-op unless
 * idle-shutdown is enabled.
 */
export function notifyClientCountChanged(): void {
  if (idleShutdownEnabled) maybeScheduleIdleShutdown();
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
