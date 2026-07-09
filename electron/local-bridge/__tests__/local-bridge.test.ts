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
    client = new LocalBridgeClient(getSocketPath());
    await client.connect();

    const result = await client.invoke('conversations:list');
    expect(invokeHandlerMock).toHaveBeenCalledWith('conversations:list');
    expect(result).toEqual([{ id: 'c1', title: 'Hello' }]);
  });

  it('forwards handler args and propagates errors', async () => {
    invokeHandlerMock.mockRejectedValue(new Error('conversation-not-found'));
    client = new LocalBridgeClient(getSocketPath());
    await client.connect();

    await expect(client.invoke('conversations:get', 'missing')).rejects.toThrow('conversation-not-found');
    expect(invokeHandlerMock).toHaveBeenCalledWith('conversations:get', 'missing');
  });

  it('delivers server-pushed broadcasts to on(channel) subscribers', async () => {
    client = new LocalBridgeClient(getSocketPath());
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
    client = new LocalBridgeClient(getSocketPath());
    await client.connect();

    const pending = client.invoke('agent:stream', 'c1');
    await stopLocalServer(); // leader goes away mid-call

    await expect(pending).rejects.toThrow(/connection closed/);
  });
});
