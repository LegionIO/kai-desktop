/**
 * Tests for broadcastToWebClients fan-out (electron/web-server/web-clients.ts).
 *
 * This is the plumbing that delivers every agent stream event to BOTH the web
 * UI clients AND every registered "extra sink" — most importantly the local
 * bridge sink that forwards events to the `kai` CLI. The GUI->CLI mirroring
 * contract depends on these invariants:
 *   - extra sinks receive the event even when NO web clients are connected
 *     (the common GUI+CLI, no-browser case),
 *   - sinks get the RAW data object (so conversationId etc. survive),
 *   - one throwing sink cannot starve the others or the caller.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { webClients, registerBroadcastSink, broadcastToWebClients } from '../web-clients.js';

type FakeWs = {
  readyState: number;
  OPEN: number;
  CLOSED: number;
  CLOSING: number;
  bufferedAmount: number;
  send: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
};

function makeWs(overrides: Partial<FakeWs> = {}): FakeWs {
  return {
    readyState: 1,
    OPEN: 1,
    CLOSED: 3,
    CLOSING: 2,
    bufferedAmount: 0,
    send: vi.fn(),
    terminate: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  webClients.clear();
});

describe('broadcastToWebClients — extra-sink fan-out (GUI->CLI delivery)', () => {
  it('forwards to an extra sink even when there are NO web clients', () => {
    const sink = vi.fn();
    const off = registerBroadcastSink(sink);
    try {
      broadcastToWebClients('agent:stream-event', { conversationId: 'c1', type: 'text-delta', text: 'hi' });
      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink).toHaveBeenCalledWith('agent:stream-event', {
        conversationId: 'c1',
        type: 'text-delta',
        text: 'hi',
      });
    } finally {
      off();
    }
  });

  it('passes the RAW data object to sinks (not a serialized string), preserving conversationId', () => {
    let received: unknown;
    const off = registerBroadcastSink((_channel, data) => {
      received = data;
    });
    try {
      const payload = { conversationId: 'abc', type: 'done' as const };
      broadcastToWebClients('agent:stream-event', payload);
      expect(received).toEqual(payload);
      expect(typeof received).toBe('object');
    } finally {
      off();
    }
  });

  it('still delivers to sinks AND sends the serialized envelope to a connected web client', () => {
    const ws = makeWs();
    webClients.add(ws as unknown as never);
    const sink = vi.fn();
    const off = registerBroadcastSink(sink);
    try {
      broadcastToWebClients('agent:stream-event', { conversationId: 'c1', type: 'text-delta' });
      expect(ws.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(ws.send.mock.calls[0][0] as string);
      expect(sent).toEqual({
        type: 'event',
        channel: 'agent:stream-event',
        data: { conversationId: 'c1', type: 'text-delta' },
      });
      expect(sink).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it('a throwing sink does not starve other sinks or throw to the caller', () => {
    const bad = vi.fn(() => {
      throw new Error('sink boom');
    });
    const good = vi.fn();
    const offBad = registerBroadcastSink(bad);
    const offGood = registerBroadcastSink(good);
    try {
      expect(() => broadcastToWebClients('agent:stream-event', { conversationId: 'c1' })).not.toThrow();
      expect(bad).toHaveBeenCalledTimes(1);
      expect(good).toHaveBeenCalledTimes(1);
    } finally {
      offBad();
      offGood();
    }
  });

  it('unregister stops further delivery to that sink', () => {
    const sink = vi.fn();
    const off = registerBroadcastSink(sink);
    broadcastToWebClients('c', { a: 1 });
    off();
    broadcastToWebClients('c', { a: 2 });
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('drops a web client whose buffer exceeds the backpressure cap, but still fans out to sinks', () => {
    const stuck = makeWs({ bufferedAmount: 32 * 1024 * 1024 });
    webClients.add(stuck as unknown as never);
    const sink = vi.fn();
    const off = registerBroadcastSink(sink);
    try {
      broadcastToWebClients('agent:stream-event', { conversationId: 'c1' });
      expect(stuck.terminate).toHaveBeenCalledTimes(1);
      expect(stuck.send).not.toHaveBeenCalled();
      expect(webClients.has(stuck as unknown as never)).toBe(false);
      expect(sink).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it('does not send to a CLOSED web client and prunes it, still fanning out to sinks', () => {
    const closed = makeWs({ readyState: 3 });
    webClients.add(closed as unknown as never);
    const sink = vi.fn();
    const off = registerBroadcastSink(sink);
    try {
      broadcastToWebClients('agent:stream-event', { conversationId: 'c1' });
      expect(closed.send).not.toHaveBeenCalled();
      expect(webClients.has(closed as unknown as never)).toBe(false);
      expect(sink).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it('an unserializable web-client payload is dropped for web clients but sinks still get the raw object', () => {
    const ws = makeWs();
    webClients.add(ws as unknown as never);
    const sink = vi.fn();
    const off = registerBroadcastSink(sink);
    const cyclic: Record<string, unknown> = { conversationId: 'c1' };
    cyclic.self = cyclic; // JSON.stringify throws
    try {
      expect(() => broadcastToWebClients('agent:stream-event', cyclic)).not.toThrow();
      // web client got nothing (serialize failed), but the sink got the raw object
      expect(ws.send).not.toHaveBeenCalled();
      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink).toHaveBeenCalledWith('agent:stream-event', cyclic);
    } finally {
      off();
    }
  });
});
