/**
 * Tests for the CLI-side local-bridge client (electron/cli/client.ts) — the `kai`
 * CLI's transport to the leader backend. Exercised against a REAL in-process net
 * server on a temp unix socket that speaks the newline-JSON envelope, so the
 * client's actual socket lifecycle (connect/auth/invoke/event/teardown) is
 * covered. The lifecycle contract locked here: in-flight calls reject on
 * disconnect, listeners survive, and intentional close() does NOT fire the
 * disconnect (recovery) handlers.
 *
 * POSIX-only (unix-domain socket); skipped on win32.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'net';
import type { Server, Socket } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalBridgeClient, tryConnect } from '../client.js';

const isWin = process.platform === 'win32';

let dir: string;
let socketPath: string;
let server: Server | null = null;
let serverSockets: Socket[] = [];
let client: LocalBridgeClient | null = null;

/**
 * Start a fake backend. `onLine(socket, msg)` is called per inbound JSON frame;
 * it can write responses. A default handler echoes auth→ok and ping→pong.
 */
function startServer(onLine?: (socket: Socket, msg: Record<string, unknown>) => void): Promise<void> {
  return new Promise((resolve) => {
    server = net.createServer((socket) => {
      serverSockets.push(socket);
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf-8');
        let i: number;
        while ((i = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as Record<string, unknown>;
          // Default protocol: auth → result ok, ping → pong.
          if (msg.type === 'auth') {
            socket.write(JSON.stringify({ id: msg.id, type: 'result', data: { ok: true } }) + '\n');
            continue;
          }
          if (msg.type === 'ping') {
            socket.write(JSON.stringify({ type: 'pong' }) + '\n');
            continue;
          }
          onLine?.(socket, msg);
        }
      });
      socket.on('error', () => {});
    });
    server.listen(socketPath, () => resolve());
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kai-cli-client-'));
  socketPath = join(dir, 'kai.sock');
  serverSockets = [];
});

afterEach(async () => {
  client?.close();
  client = null;
  for (const s of serverSockets) {
    try {
      s.destroy();
    } catch {
      /* ignore */
    }
  }
  serverSockets = [];
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(isWin)('LocalBridgeClient', () => {
  it('connects and completes the auth handshake when a token is provided', async () => {
    await startServer();
    client = new LocalBridgeClient(socketPath, 'the-token');
    await expect(client.connect()).resolves.toBeUndefined();
    expect(client.isConnected()).toBe(true);
  });

  it('connects without a token (skips the handshake)', async () => {
    let sawAuth = false;
    await startServer((_s, msg) => {
      if (msg.type === 'auth') sawAuth = true;
    });
    client = new LocalBridgeClient(socketPath); // no token
    await client.connect();
    expect(client.isConnected()).toBe(true);
    expect(sawAuth).toBe(false);
  });

  it('captures the backend serverVersion from the auth result', async () => {
    // A custom server whose auth reply carries a serverVersion.
    server = net.createServer((socket) => {
      serverSockets.push(socket);
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf-8');
        let i: number;
        while ((i = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.type === 'auth') {
            socket.write(
              JSON.stringify({ id: msg.id, type: 'result', data: { ok: true, serverVersion: '9.9.9' } }) + '\n',
            );
          }
        }
      });
      socket.on('error', () => {});
    });
    await new Promise<void>((r) => server!.listen(socketPath, () => r()));
    client = new LocalBridgeClient(socketPath, 'the-token');
    await client.connect();
    expect(client.serverVersion).toBe('9.9.9');
  });

  it('serverVersion is empty when the backend does not report one (older backend)', async () => {
    await startServer(); // default auth reply has no serverVersion
    client = new LocalBridgeClient(socketPath, 'the-token');
    await client.connect();
    expect(client.serverVersion).toBe('');
  });

  it('round-trips invoke → result by id', async () => {
    await startServer((socket, msg) => {
      if (msg.type === 'invoke' && msg.channel === 'echo') {
        socket.write(JSON.stringify({ id: msg.id, type: 'result', data: { got: msg.args } }) + '\n');
      }
    });
    client = new LocalBridgeClient(socketPath);
    await client.connect();
    const res = await client.invoke('echo', 1, 'two');
    expect(res).toEqual({ got: [1, 'two'] });
  });

  it('rejects invoke when the server returns an error frame', async () => {
    await startServer((socket, msg) => {
      if (msg.type === 'invoke') {
        socket.write(JSON.stringify({ id: msg.id, type: 'error', message: 'boom' }) + '\n');
      }
    });
    client = new LocalBridgeClient(socketPath);
    await client.connect();
    await expect(client.invoke('x')).rejects.toThrow('boom');
  });

  it('rejects invoke when not connected', async () => {
    client = new LocalBridgeClient(socketPath);
    await expect(client.invoke('x')).rejects.toThrow('not connected');
  });

  it('dispatches server-pushed events to on(channel) subscribers + unsubscribe works', async () => {
    let pushSocket: Socket | null = null;
    await startServer((socket, msg) => {
      if (msg.type === 'invoke' && msg.channel === 'grab') {
        pushSocket = socket;
        socket.write(JSON.stringify({ id: msg.id, type: 'result', data: null }) + '\n');
      }
    });
    client = new LocalBridgeClient(socketPath);
    await client.connect();
    await client.invoke('grab'); // capture the server socket

    const received: unknown[] = [];
    const unsub = client.on('stream:token', (d) => received.push(d));
    pushSocket!.write(JSON.stringify({ type: 'event', channel: 'stream:token', data: 'hello' }) + '\n');
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toEqual(['hello']);

    unsub();
    pushSocket!.write(JSON.stringify({ type: 'event', channel: 'stream:token', data: 'after' }) + '\n');
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toEqual(['hello']); // no new delivery after unsubscribe
  });

  it('rejects all in-flight calls when the connection drops', async () => {
    await startServer((socket, msg) => {
      // Accept the invoke but never respond, then kill the socket.
      if (msg.type === 'invoke') socket.destroy();
    });
    client = new LocalBridgeClient(socketPath);
    await client.connect();
    await expect(client.invoke('never-answered')).rejects.toThrow('connection closed');
  });

  it('fires onDisconnect on an unexpected drop but NOT on intentional close()', async () => {
    await startServer();
    // Case 1: intentional close → no disconnect handler.
    client = new LocalBridgeClient(socketPath);
    await client.connect();
    let fired = false;
    client.onDisconnect(() => (fired = true));
    client.close();
    expect(client.wasIntentionalClose()).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(fired).toBe(false);
  });

  it('fires onDisconnect + reports non-intentional when the server drops', async () => {
    await startServer();
    client = new LocalBridgeClient(socketPath);
    await client.connect();
    let fired = false;
    client.onDisconnect(() => (fired = true));
    // Server kills the client socket unexpectedly.
    serverSockets[0].destroy();
    await new Promise((r) => setTimeout(r, 40));
    expect(fired).toBe(true);
    expect(client.wasIntentionalClose()).toBe(false);
  });

  it('requestShutdown resolves on the server ack', async () => {
    await startServer((socket, msg) => {
      if (msg.type === 'shutdown') {
        socket.write(JSON.stringify({ id: msg.id, type: 'result', data: { ok: true } }) + '\n');
      }
    });
    client = new LocalBridgeClient(socketPath);
    await client.connect();
    await expect(client.requestShutdown(1000)).resolves.toBeUndefined();
  });

  it('requestShutdown resolves (does not hang) when the server never acks', async () => {
    await startServer(); // no shutdown handler
    client = new LocalBridgeClient(socketPath);
    await client.connect();
    await expect(client.requestShutdown(100)).resolves.toBeUndefined();
  });
});

describe.skipIf(isWin)('tryConnect', () => {
  it('returns a connected client when the socket is reachable', async () => {
    await startServer();
    client = await tryConnect(socketPath);
    expect(client).not.toBeNull();
    expect(client!.isConnected()).toBe(true);
  });

  it('returns null when the socket is unreachable', async () => {
    const c = await tryConnect(join(dir, 'nonexistent.sock'));
    expect(c).toBeNull();
  });
});
