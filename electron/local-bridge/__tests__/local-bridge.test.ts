/**
 * Local-bridge transport round-trip.
 *
 * The `kai` CLI attaches to the leader over a unix-domain socket speaking
 * newline-delimited JSON. This exercises the real server + real client end to
 * end (no Electron): invoke → invokeHandler → result, invoke error
 * propagation, and server-pushed event delivery via broadcastToLocalClients.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as NodeOs from 'node:os';

// Redirect the socket into a tmpdir-backed ~/.kai/run so tests don't collide
// with a real running leader.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('os');
  return { ...actual, homedir: () => actual.tmpdir() };
});
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return { ...actual, homedir: () => actual.tmpdir() };
});

// Controllable IPC handler stub — the local server delegates every `invoke`
// to this.
const invokeHandlerMock = vi.fn();
vi.mock('../../web-server/ipc-bridge.js', () => ({
  invokeHandler: (channel: string, ...args: unknown[]) => invokeHandlerMock(channel, ...args),
}));

import { startLocalServer, stopLocalServer, getSocketPath } from '../local-server.js';
import { getBridgeToken } from '../paths.js';
import { broadcastToLocalClients } from '../local-clients.js';
import { LocalBridgeClient } from '../../cli/client.js';

describe('local bridge transport', () => {
  let client: LocalBridgeClient | null = null;

  beforeEach(async () => {
    invokeHandlerMock.mockReset();
    await startLocalServer();
  });

  afterEach(async () => {
    client?.close();
    client = null;
    await stopLocalServer();
  });

  it('round-trips an invoke through invokeHandler', async () => {
    invokeHandlerMock.mockResolvedValue([{ id: 'c1', title: 'Hello' }]);
    client = new LocalBridgeClient(getSocketPath(), getBridgeToken());
    await client.connect();

    const result = await client.invoke('conversations:list');
    expect(invokeHandlerMock).toHaveBeenCalledWith('conversations:list');
    expect(result).toEqual([{ id: 'c1', title: 'Hello' }]);
  });

  it('forwards handler args and propagates errors', async () => {
    invokeHandlerMock.mockRejectedValue(new Error('conversation-not-found'));
    client = new LocalBridgeClient(getSocketPath(), getBridgeToken());
    await client.connect();

    await expect(client.invoke('conversations:get', 'missing')).rejects.toThrow('conversation-not-found');
    expect(invokeHandlerMock).toHaveBeenCalledWith('conversations:get', 'missing');
  });

  it('delivers server-pushed broadcasts to on(channel) subscribers', async () => {
    client = new LocalBridgeClient(getSocketPath(), getBridgeToken());
    await client.connect();

    const received: unknown[] = [];
    client.on('agent:stream-event', (data) => received.push(data));

    broadcastToLocalClients('agent:stream-event', { type: 'text-delta', conversationId: 'c1', text: 'hi' });

    // Allow the event to traverse the socket.
    await vi.waitFor(() => expect(received.length).toBe(1));
    expect(received[0]).toMatchObject({ type: 'text-delta', conversationId: 'c1', text: 'hi' });
  });

  it('rejects in-flight calls when the connection drops', async () => {
    invokeHandlerMock.mockImplementation(() => new Promise(() => {})); // never resolves
    client = new LocalBridgeClient(getSocketPath(), getBridgeToken());
    await client.connect();

    const pending = client.invoke('agent:stream', 'c1');
    await stopLocalServer(); // leader goes away mid-call

    await expect(pending).rejects.toThrow(/connection closed/);
  });

  it('reconnects to a backend that comes back, preserving event subscriptions', async () => {
    client = new LocalBridgeClient(getSocketPath(), getBridgeToken());
    await client.connect();

    const received: unknown[] = [];
    client.on('agent:stream-event', (d) => received.push(d));

    // Simulate a leader crash: stop the server out from under the client.
    let dropped = false;
    client.onDisconnect(() => (dropped = true));
    await stopLocalServer();
    await vi.waitFor(() => expect(dropped).toBe(true));

    // A new backend comes up (survivor re-election / respawn).
    await startLocalServer();
    const ok = await client.reconnect(5000);
    expect(ok).toBe(true);

    // Subscriptions survive: an event on the new server reaches the same handler.
    invokeHandlerMock.mockResolvedValue('pong-ish');
    broadcastToLocalClients('agent:stream-event', { type: 'done', conversationId: 'c1' });
    await vi.waitFor(() => expect(received.length).toBe(1));

    // And invokes work again on the new connection.
    await expect(client.invoke('conversations:list')).resolves.toBe('pong-ish');
  });

  it('does not flag intentional close as recoverable', async () => {
    client = new LocalBridgeClient(getSocketPath(), getBridgeToken());
    await client.connect();
    client.close();
    expect(client.wasIntentionalClose()).toBe(true);
  });
});

describe('local bridge run-dir hardening', () => {
  // POSIX-only: the socket's directory is the security boundary, so a loose
  // (world-accessible) run dir we own must be tightened to owner-only before
  // the handler-invoking socket is bound inside it.
  const runPosix = process.platform === 'win32' ? it.skip : it;

  afterEach(async () => {
    await stopLocalServer();
  });

  runPosix('tightens a loose (0755) run dir to 0700 before binding', async () => {
    const { getRunDir } = await import('../local-server.js');
    const { chmodSync, mkdirSync, existsSync, statSync } = await import('node:fs');
    const runDir = getRunDir();
    if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true });
    chmodSync(runDir, 0o755); // world-traversable — must be tightened, not trusted

    const socketPath = await startLocalServer();
    // Bound only after the dir was made owner-only.
    expect(statSync(runDir).mode & 0o077).toBe(0);
    expect(typeof socketPath).toBe('string');
  });
});
