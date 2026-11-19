import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type EventsFilter, matchesEvent, parseEventsArgs, WakeState, wakeMessage, wakeSessionKey } from '../events.js';

const msg = {
  pluginName: 'msgraph',
  eventName: 'message-received',
  data: { chatId: 'c1', from: { id: 'u1', displayName: 'Jane Doe' }, isActiveChat: false },
};
const f = (over: Partial<EventsFilter> = {}): EventsFilter => ({
  where: [],
  once: false,
  rewake: false,
  drain: false,
  shared: false,
  ...over,
});

describe('parseEventsArgs', () => {
  it('ignores non-events argv', () => {
    expect(parseEventsArgs(['-p', 'hi'])).toBeUndefined();
  });
  it('parses all flags in both forms', () => {
    expect(
      parseEventsArgs([
        '--kai-cli',
        'events',
        '--plugin=plugin.msgraph',
        '--event',
        'message-received',
        '--where',
        'from.displayName=Jane',
        '--where=chatId=c1',
        '--once',
        '--shared',
      ]),
    ).toEqual(
      f({
        plugin: 'msgraph',
        event: 'message-received',
        where: [
          { path: 'from.displayName', value: 'Jane' },
          { path: 'chatId', value: 'c1' },
        ],
        once: true,
        shared: true,
      }),
    );
  });
  it('--rewake implies --once; --drain is exclusive with it', () => {
    expect(parseEventsArgs(['events', '--rewake'])).toMatchObject({ once: true, rewake: true });
    expect(() => parseEventsArgs(['events', '--rewake', '--drain'])).toThrow();
  });
  it('rejects bad input', () => {
    expect(() => parseEventsArgs(['events', '--where', 'nope'])).toThrow();
    expect(() => parseEventsArgs(['events', '--plugin'])).toThrow();
    expect(() => parseEventsArgs(['events', '--bogus'])).toThrow();
  });
});

describe('matchesEvent', () => {
  it('matches by plugin and event', () => {
    expect(matchesEvent(msg, f({ plugin: 'msgraph', event: 'message-received' }))).toBe(true);
    expect(matchesEvent(msg, f({ plugin: 'other' }))).toBe(false);
    expect(matchesEvent(msg, f({ event: 'typing-started' }))).toBe(false);
  });
  it('where: case-insensitive substring on strings, exact on scalars, AND across clauses', () => {
    expect(matchesEvent(msg, f({ where: [{ path: 'from.displayName', value: 'jane' }] }))).toBe(true);
    expect(matchesEvent(msg, f({ where: [{ path: 'from.displayName', value: 'bob' }] }))).toBe(false);
    expect(matchesEvent(msg, f({ where: [{ path: 'isActiveChat', value: 'false' }] }))).toBe(true);
    expect(matchesEvent(msg, f({ where: [{ path: 'missing.path', value: 'x' }] }))).toBe(false);
    expect(
      matchesEvent(
        msg,
        f({
          where: [
            { path: 'from.displayName', value: 'jane' },
            { path: 'chatId', value: 'c2' },
          ],
        }),
      ),
    ).toBe(false);
  });
  it('shared triggers OR together; an empty list matches nothing', () => {
    const jane = {
      source: 'plugin.msgraph',
      event: 'message-received',
      where: [{ path: 'from.displayName', value: 'jane' }],
    };
    const bob = { source: 'plugin.msgraph', where: [{ path: 'from.displayName', value: 'bob' }] };
    expect(matchesEvent(msg, f(), [bob, jane])).toBe(true);
    expect(matchesEvent(msg, f(), [bob])).toBe(false);
    expect(matchesEvent(msg, f(), [])).toBe(false);
    expect(matchesEvent(msg, f(), [{ source: 'plugin.msgraph', where: [] }])).toBe(true); // any event
    expect(matchesEvent(msg, f(), [{ source: 'plugin.pim', where: [] }])).toBe(false);
  });
});

describe('wake session state', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const state = (session: string) => new WakeState(session, (dir ||= mkdtempSync(join(tmpdir(), 'kai-wake-'))));

  it('one watcher per session, independent across sessions', () => {
    const a = state('session-a');
    expect(a.tryLock(process.pid)).toBe(true);
    expect(state('session-a').tryLock(process.pid)).toBe(false); // duplicate for same session
    expect(state('session-b').tryLock(process.pid)).toBe(true); // a second session still watches
    a.unlock(process.pid);
    expect(state('session-a').tryLock(process.pid)).toBe(true);
  });
  it('reclaims a lock whose owner is dead', () => {
    const a = state('session-a');
    expect(a.tryLock(2 ** 22 + 12345)).toBe(true); // pid that does not exist
    expect(state('session-a').tryLock(process.pid)).toBe(true);
  });
  it('cursor starts at now, then persists per session', () => {
    expect(state('s').cursor(1000)).toBe(1000);
    state('s').setCursor(1500);
    expect(state('s').cursor(9999)).toBe(1500);
    expect(state('other').cursor(42)).toBe(42);
  });
  it('session key comes only from hook stdin and rejects path tricks', () => {
    expect(wakeSessionKey({ session_id: 'abc-123' })).toBe('abc-123');
    expect(wakeSessionKey({ session_id: '../../etc' })).toBeNull();
    expect(wakeSessionKey({})).toBeNull();
  });
});

it('wakeMessage lists each event and flags payloads as untrusted', () => {
  const text = wakeMessage([{ ...msg, ts: 1 }]);
  expect(text).toContain('plugin.msgraph:message-received');
  expect(text).toContain('Jane Doe');
  expect(text).toMatch(/untrusted/);
});
