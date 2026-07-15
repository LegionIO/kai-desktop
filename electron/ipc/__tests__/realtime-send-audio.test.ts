/**
 * Focused test for the realtime IPC send-audio guard: a non-string/empty frame
 * is dropped, and a throw from sendAudio never propagates out of the (catch-less)
 * ipcMain.on handler. Full session lifecycle (start supersession etc.) is covered
 * by the session-level review; here we lock the input-hygiene fix.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const onHandlers = new Map<string, (event: unknown, arg: unknown) => void>();
const invokeHandlers = new Map<string, (event: unknown, arg: unknown) => unknown>();
const fakeIpc = {
  on: (ch: string, fn: (e: unknown, a: unknown) => void) => onHandlers.set(ch, fn),
  handle: (ch: string, fn: (e: unknown, a: unknown) => unknown) => invokeHandlers.set(ch, fn),
};

// A controllable RealtimeSession stand-in whose sendAudio we can make throw.
let sendAudioImpl: (b: string) => void = () => {};
const sessionInstance = {
  status: 'connected',
  sendAudio: (b: string) => sendAudioImpl(b),
  start: vi.fn(async () => {}),
  close: vi.fn(),
};
vi.mock('../../realtime/realtime-session.js', () => ({
  RealtimeSession: vi.fn(() => sessionInstance),
}));
vi.mock('../../realtime/realtime-context.js', () => ({ buildRealtimeMemoryContext: async () => '' }));
vi.mock('../usage.js', () => ({ recordUsageEvent: vi.fn() }));

import { registerRealtimeHandlers } from '../realtime.js';
import type { AppConfig } from '../../config/schema.js';

const config = { realtime: { memoryContext: { enabled: false } } } as unknown as AppConfig;

beforeEach(() => {
  onHandlers.clear();
  invokeHandlers.clear();
  sendAudioImpl = () => {};
  registerRealtimeHandlers(
    fakeIpc as never,
    () => config,
    () => [],
    '/tmp/db',
  );
});

describe('realtime:send-audio guard', () => {
  const send = (arg: unknown) => onHandlers.get('realtime:send-audio')!(null, arg);

  it('drops a non-string / empty frame without calling into a session', () => {
    const spy = vi.fn();
    sendAudioImpl = spy;
    // No active session yet + bad inputs: must not throw.
    expect(() => send(undefined)).not.toThrow();
    expect(() => send(123)).not.toThrow();
    expect(() => send('')).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it('swallows a sendAudio throw (fire-and-forget handler has no caller catch)', async () => {
    // Start a session so activeSession is set.
    await invokeHandlers.get('realtime:start-session')!(null, 'conv-1');
    sendAudioImpl = () => {
      throw new Error('socket closed');
    };
    expect(() => send('AAAA')).not.toThrow();
  });
});
