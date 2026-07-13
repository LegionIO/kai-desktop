/**
 * Tests for local-clients.ts — the broadcast fan-out to connected local-socket
 * (CLI) clients. Security/robustness-relevant: the backpressure guard drops a
 * client that isn't draining its socket so a stalled CLI can't OOM the singleton
 * backend, and an unserializable payload must be swallowed (logged) rather than
 * thrown back to the broadcast call site.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Socket } from 'net';
import { localClients, broadcastToLocalClients, markSocketActivity, msSinceActivity } from '../local-clients.js';

const MAX_BACKLOG = 16 * 1024 * 1024;

type FakeSocket = {
  writable: boolean;
  writableLength: number;
  write: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};

function fakeSocket(overrides: Partial<FakeSocket> = {}): FakeSocket {
  return {
    writable: true,
    writableLength: 0,
    write: vi.fn(),
    destroy: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  localClients.clear();
});

describe('broadcastToLocalClients', () => {
  it('is a no-op when there are no clients', () => {
    // Just must not throw.
    expect(() => broadcastToLocalClients('some:channel', { a: 1 })).not.toThrow();
  });

  it('writes a newline-delimited event envelope to each writable client', () => {
    const a = fakeSocket();
    const b = fakeSocket();
    localClients.add(a as unknown as Socket);
    localClients.add(b as unknown as Socket);

    broadcastToLocalClients('stream:token', { text: 'hi' });

    const expected = JSON.stringify({ type: 'event', channel: 'stream:token', data: { text: 'hi' } }) + '\n';
    expect(a.write).toHaveBeenCalledWith(expected);
    expect(b.write).toHaveBeenCalledWith(expected);
  });

  it('skips a non-writable socket', () => {
    const dead = fakeSocket({ writable: false });
    localClients.add(dead as unknown as Socket);
    broadcastToLocalClients('x', 1);
    expect(dead.write).not.toHaveBeenCalled();
  });

  it('drops and destroys a client whose outbound backlog exceeds the cap', () => {
    const slow = fakeSocket({ writableLength: MAX_BACKLOG + 1 });
    localClients.add(slow as unknown as Socket);
    broadcastToLocalClients('flood', 'data');
    expect(slow.destroy).toHaveBeenCalledTimes(1);
    expect(slow.write).not.toHaveBeenCalled(); // dropped before write
    expect(localClients.has(slow as unknown as Socket)).toBe(false); // removed from set
  });

  it('keeps a client exactly at the cap boundary (only strictly-over is dropped)', () => {
    const atCap = fakeSocket({ writableLength: MAX_BACKLOG });
    localClients.add(atCap as unknown as Socket);
    broadcastToLocalClients('x', 1);
    expect(atCap.destroy).not.toHaveBeenCalled();
    expect(atCap.write).toHaveBeenCalled();
  });

  it('a per-socket write throw does not stop delivery to the others', () => {
    const bad = fakeSocket();
    bad.write.mockImplementation(() => {
      throw new Error('EPIPE');
    });
    const good = fakeSocket();
    localClients.add(bad as unknown as Socket);
    localClients.add(good as unknown as Socket);

    expect(() => broadcastToLocalClients('x', 1)).not.toThrow();
    expect(good.write).toHaveBeenCalled();
  });

  it('swallows an unserializable payload (cyclic) without throwing to the caller', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sock = fakeSocket();
    localClients.add(sock as unknown as Socket);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => broadcastToLocalClients('x', cyclic)).not.toThrow();
    expect(sock.write).not.toHaveBeenCalled(); // serialization failed before any write
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('serializes the payload once even with many clients (no per-client re-encode error)', () => {
    const socks = Array.from({ length: 5 }, () => fakeSocket());
    for (const s of socks) localClients.add(s as unknown as Socket);
    broadcastToLocalClients('multi', { n: 1 });
    for (const s of socks) expect(s.write).toHaveBeenCalledTimes(1);
  });
});

describe('socket activity tracking (server-heartbeat liveness)', () => {
  it('msSinceActivity is Infinity before any activity is marked', () => {
    const s = fakeSocket();
    expect(msSinceActivity(s as unknown as Socket)).toBe(Infinity);
  });

  it('markSocketActivity resets the elapsed time to ~0', () => {
    const s = fakeSocket();
    markSocketActivity(s as unknown as Socket);
    expect(msSinceActivity(s as unknown as Socket)).toBeLessThan(1000);
  });

  it('a successful broadcast write marks the socket active (outbound counts as liveness)', () => {
    // This is the #206 fix: streaming TO the client refreshes liveness so the
    // server heartbeat can't reap it mid-stream on a delayed inbound ping.
    const s = fakeSocket();
    localClients.add(s as unknown as Socket);
    expect(msSinceActivity(s as unknown as Socket)).toBe(Infinity); // no activity yet
    broadcastToLocalClients('stream:token', { text: 'chunk' });
    expect(s.write).toHaveBeenCalled();
    expect(msSinceActivity(s as unknown as Socket)).toBeLessThan(1000); // now marked active
  });

  it('a DROPPED (over-backlog) client is not marked active by the broadcast', () => {
    const slow = fakeSocket({ writableLength: MAX_BACKLOG + 1 });
    localClients.add(slow as unknown as Socket);
    broadcastToLocalClients('flood', 'data');
    // Destroyed before write → never marked active (it's gone, not alive).
    expect(msSinceActivity(slow as unknown as Socket)).toBe(Infinity);
  });
});
