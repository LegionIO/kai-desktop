/**
 * End-to-end tests for the local IPC bridge server (local-server.ts). This is a
 * security boundary: once a client passes the per-install token handshake it can
 * invoke any captured IPC handler. The tests start a REAL server on a temp
 * KAI_USER_DATA socket, connect a real net.Socket, and drive the newline-JSON
 * protocol to assert the auth gate holds — an unauthenticated peer can neither
 * invoke a handler nor stay connected.
 *
 * POSIX-only (unix-domain socket). On win32 the pipe namespace differs; skipped.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { IpcMain } from 'electron';
import { installIpcCapture } from '../../web-server/ipc-bridge.js';
import { startLocalServer, stopLocalServer } from '../local-server.js';
import { getBridgeToken, getSocketPath } from '../paths.js';

const isWin = process.platform === 'win32';

/** Fake ipcMain so we can register a probe handler that invokeHandler will find. */
function makeFakeIpcMain() {
  const ipc = {
    handle(_channel: string, _fn: (...a: unknown[]) => unknown) {
      return ipc;
    },
    on(_channel: string, _fn: (...a: unknown[]) => void) {
      return ipc;
    },
  } as unknown as IpcMain;
  return ipc;
}

let home: string;
let prevUserData: string | undefined;
let client: net.Socket | null = null;

/** Connect a client and yield a line-reader that resolves the next JSON frame. */
function connectClient(
  socketPath: string,
): Promise<{ sock: net.Socket; next: () => Promise<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    const queue: Record<string, unknown>[] = [];
    const waiters: ((v: Record<string, unknown>) => void)[] = [];
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf-8');
      let i: number;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const obj = JSON.parse(line) as Record<string, unknown>;
        const w = waiters.shift();
        if (w) w(obj);
        else queue.push(obj);
      }
    });
    const next = () =>
      new Promise<Record<string, unknown>>((res) => {
        const q = queue.shift();
        if (q) res(q);
        else waiters.push(res);
      });
    sock.on('connect', () => resolve({ sock, next }));
    sock.on('error', reject);
  });
}

const send = (sock: net.Socket, obj: unknown) => sock.write(JSON.stringify(obj) + '\n');

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'kai-localserver-'));
  prevUserData = process.env.KAI_USER_DATA;
  process.env.KAI_USER_DATA = home;
  // Register a probe handler reachable via invokeHandler('probe:echo', ...).
  // installIpcCapture wraps THIS fake's .handle so calling it stores the handler
  // in the bridge's internal map that invokeHandler reads.
  const fakeIpc = makeFakeIpcMain();
  installIpcCapture(fakeIpc);
  fakeIpc.handle('probe:echo', (_e: unknown, v: unknown) => ({ echoed: v }));
});

afterEach(async () => {
  client?.destroy();
  client = null;
  await stopLocalServer();
  if (prevUserData === undefined) delete process.env.KAI_USER_DATA;
  else process.env.KAI_USER_DATA = prevUserData;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe.skipIf(isWin)('local-server auth gate', () => {
  it('answers ping with pong before authentication', async () => {
    await startLocalServer();
    const { sock, next } = await connectClient(getSocketPath());
    client = sock;
    send(sock, { type: 'ping' });
    expect((await next()).type).toBe('pong');
  });

  it('refuses invoke from an unauthenticated socket and does not run the handler', async () => {
    await startLocalServer();
    const { sock, next } = await connectClient(getSocketPath());
    client = sock;
    let closed = false;
    sock.on('close', () => (closed = true));
    send(sock, { id: '1', type: 'invoke', channel: 'probe:echo', args: ['hi'] });
    const reply = await next();
    expect(reply.type).toBe('error');
    expect(reply.message).toBe('unauthenticated');
    // The server destroys an unauthenticated invoker.
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(true);
  });

  it('rejects a wrong token and destroys the socket', async () => {
    await startLocalServer();
    const { sock, next } = await connectClient(getSocketPath());
    client = sock;
    send(sock, { id: 'a', type: 'auth', token: 'definitely-the-wrong-token' });
    const reply = await next();
    expect(reply.type).toBe('error');
    expect(reply.message).toBe('auth failed');
  });

  it('authenticates with the correct token, then dispatches invoke to the handler', async () => {
    await startLocalServer();
    const token = getBridgeToken();
    const { sock, next } = await connectClient(getSocketPath());
    client = sock;
    send(sock, { id: 'auth1', type: 'auth', token });
    const authReply = await next();
    expect(authReply.type).toBe('result');
    expect(authReply.data).toEqual({ ok: true });

    send(sock, { id: 'inv1', type: 'invoke', channel: 'probe:echo', args: ['payload'] });
    const invReply = await next();
    expect(invReply.type).toBe('result');
    expect(invReply.data).toEqual({ echoed: 'payload' });
  });

  it('rejects invoke with non-array or oversized args after auth', async () => {
    await startLocalServer();
    const token = getBridgeToken();
    const { sock, next } = await connectClient(getSocketPath());
    client = sock;
    send(sock, { id: 'auth1', type: 'auth', token });
    await next(); // auth ok

    send(sock, { id: 'bad1', type: 'invoke', channel: 'probe:echo', args: 'not-an-array' });
    expect((await next()).message).toBe('invalid args');

    send(sock, { id: 'bad2', type: 'invoke', channel: 'probe:echo', args: new Array(65).fill(0) });
    expect((await next()).message).toBe('invalid args');
  });

  it('ignores a malformed JSON line without crashing the connection', async () => {
    await startLocalServer();
    const { sock, next } = await connectClient(getSocketPath());
    client = sock;
    sock.write('this is not json\n');
    // The connection must still be alive and responsive.
    send(sock, { type: 'ping' });
    expect((await next()).type).toBe('pong');
  });

  it('is idempotent: a second startLocalServer resolves the same socket path', async () => {
    const p1 = await startLocalServer();
    const p2 = await startLocalServer();
    expect(p2).toBe(p1);
  });
});
