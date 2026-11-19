import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type EventsFilter,
  formatCatalog,
  hintText,
  isShared,
  matchesEvent,
  parseEventsArgs,
  runEventsCommand,
  schemaPaths,
  sharedCatalog,
  WakeState,
  wakeMessage,
  wakeSessionKey,
} from '../events.js';
import type { LocalBridgeClient } from '../client.js';

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
    expect(parseEventsArgs(['-p', 'hi'], {})).toBeUndefined();
  });
  it('parses all flags in both forms', () => {
    expect(
      parseEventsArgs(
        [
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
        ],
        {},
      ),
    ).toEqual({
      kind: 'stream',
      filter: f({
        plugin: 'msgraph',
        event: 'message-received',
        where: [
          { path: 'from.displayName', value: 'Jane' },
          { path: 'chatId', value: 'c1' },
        ],
        once: true,
        shared: true,
      }),
    });
  });
  it('--rewake implies --once; --drain is exclusive with it', () => {
    expect(parseEventsArgs(['events', '--rewake'], {})).toMatchObject({ filter: { once: true, rewake: true } });
    expect(() => parseEventsArgs(['events', '--rewake', '--drain'], {})).toThrow();
  });
  it('rejects bad input', () => {
    expect(() => parseEventsArgs(['events', '--where', 'nope'], {})).toThrow();
    expect(() => parseEventsArgs(['events', '--plugin'], {})).toThrow();
    expect(() => parseEventsArgs(['events', '--bogus'], {})).toThrow();
  });
  it('parses subscribe/list/unsubscribe, taking the session from the agent env or --session', () => {
    const claude = { CLAUDE_CODE_SESSION_ID: 'claude-1' };
    expect(
      parseEventsArgs(
        [
          'events',
          'subscribe',
          '--plugin',
          'msgraph',
          '--event',
          'message-received',
          '--where',
          'from.displayName=jane',
        ],
        claude,
      ),
    ).toEqual({
      kind: 'subscribe',
      session: 'claude-1',
      trigger: {
        source: 'plugin.msgraph',
        event: 'message-received',
        where: [{ path: 'from.displayName', value: 'jane' }],
      },
    });
    expect(parseEventsArgs(['events', 'list'], { CODEX_THREAD_ID: 'codex-1' })).toEqual({
      kind: 'list',
      session: 'codex-1',
    });
    expect(parseEventsArgs(['events', 'unsubscribe', '2', '--session', 'x'], {})).toEqual({
      kind: 'unsubscribe',
      session: 'x',
      index: 2,
    });
    expect(parseEventsArgs(['events', 'unsubscribe', '--all'], {})).toEqual({
      kind: 'unsubscribe',
      session: null,
      index: 'all',
    });
    expect(() => parseEventsArgs(['events', 'subscribe', '--event', 'x'], claude)).toThrow(/--plugin/);
    expect(() => parseEventsArgs(['events', 'unsubscribe'], claude)).toThrow();
    expect(() => parseEventsArgs(['events', 'list', '--session', '../x'], {})).toThrow();
  });
});

describe('matchesEvent', () => {
  const ALL = ['plugin.msgraph:*'];
  it('nothing matches unless the user shared it', () => {
    expect(matchesEvent(msg, f(), [])).toBe(false);
    expect(matchesEvent(msg, f(), ['plugin.msgraph:reaction-added'])).toBe(false);
    expect(matchesEvent(msg, f(), ['plugin.msgraph:message-received'])).toBe(true);
    expect(matchesEvent(msg, f(), ALL)).toBe(true);
    expect(isShared({ pluginName: 'pim', eventName: 'x' }, ALL)).toBe(false);
  });
  it('matches by plugin and event', () => {
    expect(matchesEvent(msg, f({ plugin: 'msgraph', event: 'message-received' }), ALL)).toBe(true);
    expect(matchesEvent(msg, f({ plugin: 'other' }), ALL)).toBe(false);
    expect(matchesEvent(msg, f({ event: 'typing-started' }), ALL)).toBe(false);
  });
  it('where: case-insensitive substring on strings, exact on scalars, AND across clauses', () => {
    const w = (where: EventsFilter['where']) => matchesEvent(msg, f({ where }), ALL);
    expect(w([{ path: 'from.displayName', value: 'jane' }])).toBe(true);
    expect(w([{ path: 'from.displayName', value: 'bob' }])).toBe(false);
    expect(w([{ path: 'isActiveChat', value: 'false' }])).toBe(true);
    expect(w([{ path: 'missing.path', value: 'x' }])).toBe(false);
    expect(
      w([
        { path: 'from.displayName', value: 'jane' },
        { path: 'chatId', value: 'c2' },
      ]),
    ).toBe(false);
  });
  it('subscriptions OR together; an empty list matches nothing', () => {
    const jane = {
      source: 'plugin.msgraph',
      event: 'message-received',
      where: [{ path: 'from.displayName', value: 'jane' }],
    };
    const bob = { source: 'plugin.msgraph', where: [{ path: 'from.displayName', value: 'bob' }] };
    expect(matchesEvent(msg, f(), ALL, [bob, jane])).toBe(true);
    expect(matchesEvent(msg, f(), ALL, [bob])).toBe(false);
    expect(matchesEvent(msg, f(), ALL, [])).toBe(false);
    expect(matchesEvent(msg, f(), ALL, [{ source: 'plugin.msgraph', where: [] }])).toBe(true);
    expect(matchesEvent(msg, f(), [], [jane])).toBe(false); // unshared beats a subscription
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

const catalog = [
  {
    source: 'plugin.msgraph',
    displayName: 'MSGraph',
    events: [
      {
        event: 'message-received',
        title: 'Message received',
        payloadSchema: {
          type: 'object',
          properties: {
            from: { type: 'object', properties: { displayName: { type: 'string' } } },
            preview: { type: 'string' },
          },
        },
      },
      { event: 'typing-started', title: 'Typing started' },
    ],
  },
  { source: 'plugin.pim', displayName: 'PIM', events: [{ event: 'approval-pending', title: 'Approval pending' }] },
  { source: 'app', displayName: 'App', events: [{ event: 'ready', title: 'Ready' }] },
];

it('catalog shows only shared plugin events, with their payload fields', () => {
  const shared = sharedCatalog(catalog, ['plugin.msgraph:message-received']);
  expect(shared.map((c) => [c.source, c.events.map((e) => e.event)])).toEqual([
    ['plugin.msgraph', ['message-received']],
  ]);
  expect(schemaPaths(catalog[0].events[0].payloadSchema)).toEqual(['from.displayName', 'preview']);
  expect(formatCatalog(shared)).toContain('fields: from.displayName, preview');
  expect(formatCatalog([])).toMatch(/No automation events are shared/);
  expect(hintText([])).toBe('');
  expect(hintText(shared)).toContain('kai events subscribe');
});

describe('runEventsCommand', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const client = (events: string[]) =>
    ({
      invoke: async (channel: string) =>
        channel === 'config:get'
          ? { mcpExport: { enabled: true, events } }
          : channel === 'automations:catalog'
            ? catalog
            : [],
    }) as unknown as LocalBridgeClient;
  const run = async (c: LocalBridgeClient, argv: string[]) => {
    const lines: string[] = [];
    const cmd = parseEventsArgs(['events', ...argv], { CLAUDE_CODE_SESSION_ID: 's1' })!;
    if (cmd.kind === 'stream') throw new Error('unexpected');
    const code = await runEventsCommand(c, cmd, (t) => lines.push(t));
    return { code, text: lines.join('\n') };
  };
  it('a session subscribes itself only to shared events, then lists and removes them', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kai-subs-'));
    process.env.KAI_USER_DATA = dir; // WakeState default dir lives under the app home
    const c = client(['plugin.msgraph:message-received']);
    expect((await run(c, ['subscribe', '--plugin', 'pim'])).code).toBe(1);
    // "any event" needs the whole plugin shared, not just one of its events
    expect((await run(c, ['subscribe', '--plugin', 'msgraph'])).code).toBe(1);
    expect((await run(c, ['subscribe', '--plugin', 'msgraph', '--event', 'typing-started'])).code).toBe(1);
    const ok = await run(c, [
      'subscribe',
      '--plugin',
      'msgraph',
      '--event',
      'message-received',
      '--where',
      'from.displayName=jane',
    ]);
    expect(ok.code).toBe(0);
    await run(c, [
      'subscribe',
      '--plugin',
      'msgraph',
      '--event',
      'message-received',
      '--where',
      'from.displayName=jane',
    ]);
    expect((await run(c, ['list'])).text).toBe(
      '1. --plugin msgraph --event message-received --where from.displayName=jane',
    );
    expect((await run(client([]), ['list'])).text).toMatch(/paused/);
    expect((await run(c, ['unsubscribe', '1'])).code).toBe(0);
    expect((await run(c, ['list'])).text).toMatch(/No subscriptions/);
    delete process.env.KAI_USER_DATA;
  });
});
