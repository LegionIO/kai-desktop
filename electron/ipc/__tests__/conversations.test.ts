/**
 * IPC handler tests for `electron/ipc/conversations.ts`.
 *
 * Same harness pattern as the canonical `config.test.ts`:
 *   • Mock `electron` so BrowserWindow.getAllWindows is a no-op.
 *   • Use a per-test temp `appHome` instead of touching `~/.kai/`.
 *   • Drive handlers through `createIpcHarness` to exercise the channels the
 *     renderer side talks to via `window.app.conversations.*`.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createIpcHarness } from '../../../test-utils/ipc-harness.js';

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

// The conversations handler imports the computer-use service for cleanup on
// delete/clear. That module is heavy and pulls in real Electron APIs; for unit
// tests we replace it with a benign stub. The production code already wraps
// the call in try/catch, so a thrown error would not break the IPC contract —
// stubbing here just keeps the import graph small.
vi.mock('../../computer-use/service.js', () => ({
  getComputerUseManager: vi.fn(() => ({
    removeSessionsByConversation: vi.fn(),
  })),
}));

import {
  appendConversationMessages,
  ensureConversationTree,
  getConversationBranch,
  registerConversationHandlers,
} from '../conversations.js';
import {
  readIndex,
  readConversation,
  writeConversation,
  writeIndex,
  setActiveConversationId,
  __resetMigrationGuardForTests,
  type ConversationRecord,
} from '../conversation-store.js';

// Test shims mapping the old whole-store helpers onto the per-file store, so the
// existing assertions (`readConversationStore(appHome).conversations.c`) and
// seed calls (`writeConversationStore(appHome, { conversations, ... })`) keep
// working against the new layout.
function readConversationStore(home: string): {
  conversations: Record<string, ConversationRecord>;
  activeConversationId: string | null;
  settings: Record<string, unknown>;
} {
  const index = readIndex(home);
  const conversations: Record<string, ConversationRecord> = {};
  for (const id of Object.keys(index.conversations)) {
    const c = readConversation(home, id);
    if (c) conversations[id] = c;
  }
  return { conversations, activeConversationId: index.activeConversationId, settings: index.settings };
}

function writeConversationStore(
  home: string,
  store: {
    conversations: Record<string, ConversationRecord>;
    activeConversationId?: string | null;
    settings?: Record<string, unknown>;
  },
): void {
  // Reset to exactly the provided set (mirrors the old whole-file overwrite).
  writeIndex(home, { conversations: {}, activeConversationId: store.activeConversationId ?? null, settings: {} });
  for (const conv of Object.values(store.conversations)) writeConversation(home, conv);
  if (store.activeConversationId !== undefined) setActiveConversationId(home, store.activeConversationId);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Production handlers are registered with the signature
// `(event, ...args) => ...`. The harness passes args verbatim, so tests must
// supply an event placeholder as the first argument when invoking.
const FAKE_EVENT = Object.freeze({}) as unknown;

let tempRoot: string;
let appHome: string;

function makeConversation(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: null,
    fallbackTitle: null,
    messages: [],
    messageTree: [],
    headId: null,
    conversationCompaction: null,
    lastContextUsage: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastMessageAt: null,
    titleStatus: 'idle',
    titleUpdatedAt: null,
    messageCount: 0,
    userMessageCount: 0,
    runStatus: 'idle',
    hasUnread: false,
    lastAssistantUpdateAt: null,
    selectedModelKey: null,
    ...overrides,
  };
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'kai-conv-ipc-'));
  appHome = join(tempRoot, 'app-home');
  mkdirSync(join(appHome, 'data'), { recursive: true });
  // The per-file store guards migration with a module-level flag; reset it so
  // each fresh temp appHome is evaluated independently.
  __resetMigrationGuardForTests();
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Channel coverage
// ---------------------------------------------------------------------------

describe('conversations IPC: list / get / put round-trip', () => {
  it('returns an empty list when no store exists', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConversationHandlers(ipc as Parameters<typeof registerConversationHandlers>[0], appHome);
      },
    });

    const list = await harness.invoke<unknown[]>('conversations:list', FAKE_EVENT);
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(0);
  });

  it('persists a conversations:put and reflects it in conversations:get and conversations:list', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConversationHandlers(ipc as Parameters<typeof registerConversationHandlers>[0], appHome);
      },
    });

    const conversation = makeConversation('conv-1', {
      title: 'Hello world',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      messageCount: 1,
      userMessageCount: 1,
      lastMessageAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });

    const putResult = await harness.invoke<{ ok: boolean }>('conversations:put', FAKE_EVENT, conversation);
    expect(putResult).toEqual({ ok: true });

    const fetched = await harness.invoke<Record<string, unknown> | null>('conversations:get', FAKE_EVENT, 'conv-1');
    expect(fetched).not.toBeNull();
    expect(fetched).toMatchObject({ id: 'conv-1', title: 'Hello world' });

    const list = await harness.invoke<Array<{ id: string; hasToolCalls: boolean }>>('conversations:list', FAKE_EVENT);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'conv-1', hasToolCalls: false });

    // The on-disk per-file store should contain the entry as well.
    const onDisk = JSON.parse(readFileSync(join(appHome, 'data', 'conversations', 'conv-1.json'), 'utf-8'));
    expect(onDisk.id).toBe('conv-1');
  });

  it('conversations:put unions on-disk messages the incoming write is missing', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConversationHandlers(ipc as Parameters<typeof registerConversationHandlers>[0], appHome);
      },
    });

    const base = makeConversation('c', {
      messageTree: [
        { id: 'u', parentId: null, role: 'user', content: 'q', createdAt: 'x' },
        { id: 'autoU', parentId: 'u', role: 'user', content: 'auto', createdAt: 'x' },
        { id: 'autoA', parentId: 'autoU', role: 'assistant', content: 'auto', createdAt: 'x' },
      ],
      headId: 'autoA',
      messageCount: 3,
    });
    await harness.invoke('conversations:put', FAKE_EVENT, base);

    // Concurrent writer (e.g. renderer stream done) has [u, streamA] — same length as
    // a subset would be, but missing autoU/autoA and adding streamA.
    await harness.invoke(
      'conversations:put',
      FAKE_EVENT,
      makeConversation('c', {
        messageTree: [
          { id: 'u', parentId: null, role: 'user', content: 'q', createdAt: 'x' },
          { id: 'streamA', parentId: 'u', role: 'assistant', content: 'stream', createdAt: 'x' },
        ],
        headId: 'streamA',
        messageCount: 2,
      }),
    );

    const merged = readConversationStore(appHome).conversations.c as {
      messageTree: Array<{ id: string }>;
      headId: string;
    };
    const ids = merged.messageTree.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['u', 'autoU', 'autoA', 'streamA']));
    // Incoming write had a novel message (streamA) → concurrent, not stale → incoming head wins
    expect(merged.headId).toBe('streamA');
  });

  it('conversations:put preserves a redactedByHook user turn against a raw same-id rewrite', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConversationHandlers(ipc as Parameters<typeof registerConversationHandlers>[0], appHome);
      },
    });

    // On-disk: a UserPromptSubmit modify hook redacted the user turn (flagged).
    await harness.invoke(
      'conversations:put',
      FAKE_EVENT,
      makeConversation('c', {
        messageTree: [
          { id: 'u', parentId: null, role: 'user', content: '[redacted]', createdAt: 'x', redactedByHook: true },
        ],
        headId: 'u',
        messageCount: 1,
      }),
    );

    // Renderer stream-done write carries the SAME id with the RAW text.
    await harness.invoke(
      'conversations:put',
      FAKE_EVENT,
      makeConversation('c', {
        messageTree: [
          { id: 'u', parentId: null, role: 'user', content: 'my SECRET api key sk-123', createdAt: 'x' },
          { id: 'a', parentId: 'u', role: 'assistant', content: 'ok', createdAt: 'x' },
        ],
        headId: 'a',
        messageCount: 2,
      }),
    );

    const stored = readConversationStore(appHome).conversations.c as {
      messageTree: Array<{ id: string; content: unknown }>;
    };
    const userNode = stored.messageTree.find((m) => m.id === 'u');
    // The redaction must survive — NOT be overwritten by the raw incoming text.
    expect(userNode?.content).toBe('[redacted]');
    // The new assistant turn still lands.
    expect(stored.messageTree.some((m) => m.id === 'a')).toBe(true);
  });

  it('conversations:put preserves same-id content updates when prev has extra ids', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConversationHandlers(ipc as Parameters<typeof registerConversationHandlers>[0], appHome);
      },
    });

    await harness.invoke(
      'conversations:put',
      FAKE_EVENT,
      makeConversation('c', {
        messageTree: [
          { id: 'u', parentId: null, role: 'user', content: 'q', createdAt: 'x' },
          { id: 'a', parentId: 'u', role: 'assistant', content: 'partial', createdAt: 'x' },
          { id: 'autoU', parentId: 'a', role: 'user', content: 'auto', createdAt: 'x' },
        ],
        headId: 'autoU',
      }),
    );
    // Stream-done write updates 'a' to final content, adds no new ids
    await harness.invoke(
      'conversations:put',
      FAKE_EVENT,
      makeConversation('c', {
        messageTree: [
          { id: 'u', parentId: null, role: 'user', content: 'q', createdAt: 'x' },
          { id: 'a', parentId: 'u', role: 'assistant', content: 'FINAL', createdAt: 'x' },
        ],
        headId: 'a',
      }),
    );

    const stored = readConversationStore(appHome).conversations.c as {
      messageTree: Array<{ id: string; content: unknown }>;
      headId: string;
    };
    expect(stored.messageTree.find((m) => m.id === 'a')?.content).toBe('FINAL');
    expect(stored.messageTree.map((m) => m.id)).toEqual(expect.arrayContaining(['u', 'a', 'autoU']));
    expect(stored.headId).toBe('autoU');
  });

  it('conversations:put keeps prev.headId when the incoming write is a stale subset', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConversationHandlers(ipc as Parameters<typeof registerConversationHandlers>[0], appHome);
      },
    });

    await harness.invoke(
      'conversations:put',
      FAKE_EVENT,
      makeConversation('c', {
        messageTree: [
          { id: 'a', parentId: null, role: 'user', content: 'q', createdAt: 'x' },
          { id: 'b', parentId: 'a', role: 'assistant', content: 'r', createdAt: 'x' },
        ],
        headId: 'b',
      }),
    );
    // Stale writer (e.g. title-gen) writes back an older snapshot with no novel messages
    await harness.invoke(
      'conversations:put',
      FAKE_EVENT,
      makeConversation('c', {
        messageTree: [{ id: 'a', parentId: null, role: 'user', content: 'q', createdAt: 'x' }],
        headId: 'a',
      }),
    );

    const stored = readConversationStore(appHome).conversations.c as { headId: string; messageTree: unknown[] };
    expect(stored.headId).toBe('b');
    expect(stored.messageTree).toHaveLength(2);
  });
});

describe('conversations IPC: error paths', () => {
  it('returns null for conversations:get when the id is unknown', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConversationHandlers(ipc as Parameters<typeof registerConversationHandlers>[0], appHome);
      },
    });

    const result = await harness.invoke<unknown>('conversations:get', FAKE_EVENT, 'does-not-exist');
    expect(result).toBeNull();
  });

  it('treats conversations:delete of an unknown id as a benign no-op', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConversationHandlers(ipc as Parameters<typeof registerConversationHandlers>[0], appHome);
      },
    });

    const result = await harness.invoke<{ ok: boolean }>('conversations:delete', FAKE_EVENT, 'ghost');
    expect(result).toEqual({ ok: true });
    // No conversation existed, so the per-file store stays empty.
    const store = readConversationStore(appHome);
    expect(store.conversations).toEqual({});
  });

  it('tolerates a corrupted index.json by returning an empty store', async () => {
    // Seed then overwrite index.json with junk to exercise the parse-failure branch.
    writeConversationStore(appHome, {
      conversations: {},
      activeConversationId: null,
      settings: {},
    });
    mkdirSync(join(appHome, 'data'), { recursive: true });
    writeFileSync(join(appHome, 'data', 'index.json'), '{not valid json', 'utf-8');

    const store = readConversationStore(appHome);
    expect(store).toEqual({
      conversations: {},
      activeConversationId: null,
      settings: {},
    });
  });
});

describe('conversations IPC: active-id handling', () => {
  it('reads and writes the active conversation id', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConversationHandlers(ipc as Parameters<typeof registerConversationHandlers>[0], appHome);
      },
    });

    const before = await harness.invoke<string | null>('conversations:get-active-id', FAKE_EVENT);
    expect(before).toBeNull();

    const setResult = await harness.invoke<{ ok: boolean }>('conversations:set-active-id', FAKE_EVENT, 'conv-active');
    expect(setResult).toEqual({ ok: true });

    const after = await harness.invoke<string | null>('conversations:get-active-id', FAKE_EVENT);
    expect(after).toBe('conv-active');
  });

  it('clears the active id when the active conversation is deleted', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConversationHandlers(ipc as Parameters<typeof registerConversationHandlers>[0], appHome);
      },
    });

    await harness.invoke('conversations:put', FAKE_EVENT, makeConversation('keep'));
    await harness.invoke('conversations:put', FAKE_EVENT, makeConversation('drop'));
    await harness.invoke('conversations:set-active-id', FAKE_EVENT, 'drop');

    await harness.invoke('conversations:delete', FAKE_EVENT, 'drop');

    const activeAfter = await harness.invoke<string | null>('conversations:get-active-id', FAKE_EVENT);
    expect(activeAfter).toBeNull();
    const remaining = await harness.invoke<Array<{ id: string }>>('conversations:list', FAKE_EVENT);
    expect(remaining.map((c) => c.id)).toEqual(['keep']);
  });

  it('conversations:clear empties the entire store', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConversationHandlers(ipc as Parameters<typeof registerConversationHandlers>[0], appHome);
      },
    });

    await harness.invoke('conversations:put', FAKE_EVENT, makeConversation('a'));
    await harness.invoke('conversations:put', FAKE_EVENT, makeConversation('b'));
    await harness.invoke('conversations:set-active-id', FAKE_EVENT, 'a');

    const result = await harness.invoke<{ ok: boolean }>('conversations:clear', FAKE_EVENT);
    expect(result).toEqual({ ok: true });

    const list = await harness.invoke<unknown[]>('conversations:list', FAKE_EVENT);
    expect(list).toEqual([]);
    const activeId = await harness.invoke<string | null>('conversations:get-active-id', FAKE_EVENT);
    expect(activeId).toBeNull();
  });
});

describe('appendConversationMessages', () => {
  it('chains parentId from head, updates counts and timestamps', () => {
    writeConversationStore(appHome, {
      conversations: {
        c1: makeConversation('c1', {
          messageTree: [{ id: 'u1', parentId: null, role: 'user', content: 'hi', createdAt: '2026-01-01T00:00:00Z' }],
          headId: 'u1',
          messageCount: 1,
          userMessageCount: 1,
        }) as never,
      },
      activeConversationId: null,
      settings: {},
    });

    const result = appendConversationMessages(appHome, 'c1', [
      { role: 'user', content: 'follow-up' },
      { role: 'assistant', content: 'answer' },
    ]);

    expect(result).not.toBeNull();
    const stored = readConversationStore(appHome).conversations.c1 as {
      messageTree: Array<{ id: string; parentId: string | null; role: string }>;
      headId: string;
      messageCount: number;
      userMessageCount: number;
      hasUnread: boolean;
      lastAssistantUpdateAt: string | null;
    };
    expect(stored.messageTree).toHaveLength(3);
    expect(stored.messageTree[1].parentId).toBe('u1');
    expect(stored.messageTree[2].parentId).toBe(stored.messageTree[1].id);
    expect(stored.headId).toBe(stored.messageTree[2].id);
    expect(stored.messageCount).toBe(3);
    expect(stored.userMessageCount).toBe(2);
    expect(stored.hasUnread).toBe(true);
    expect(stored.lastAssistantUpdateAt).toBeTruthy();
  });

  it('converts a legacy flat-messages conversation to a tree before appending', () => {
    writeConversationStore(appHome, {
      conversations: {
        c1: makeConversation('c1', {
          messageTree: undefined,
          messages: [
            { role: 'user', content: 'legacy q' },
            { role: 'assistant', content: 'legacy a' },
          ],
        }) as never,
      },
      activeConversationId: null,
      settings: {},
    });

    appendConversationMessages(appHome, 'c1', [{ role: 'assistant', content: 'appended' }]);

    const stored = readConversationStore(appHome).conversations.c1 as {
      messageTree: Array<{ parentId: string | null }>;
    };
    expect(stored.messageTree).toHaveLength(3);
    expect(stored.messageTree[0].parentId).toBeNull();
    expect(stored.messageTree[2].parentId).toBeTruthy();
  });

  it('returns null for a missing conversation', () => {
    writeConversationStore(appHome, { conversations: {}, activeConversationId: null, settings: {} });
    expect(appendConversationMessages(appHome, 'nope', [{ role: 'user', content: 'x' }])).toBeNull();
  });

  it('skipIfBusy=true refuses when the conversation is running', () => {
    writeConversationStore(appHome, {
      conversations: { c1: makeConversation('c1', { runStatus: 'running' }) as never },
      activeConversationId: null,
      settings: {},
    });
    expect(
      appendConversationMessages(appHome, 'c1', [{ role: 'user', content: 'x' }], { skipIfBusy: true }),
    ).toBeNull();
    expect(appendConversationMessages(appHome, 'c1', [{ role: 'user', content: 'x' }])).not.toBeNull();
  });
});

describe('ensureConversationTree / getConversationBranch', () => {
  it('passes through an existing messageTree', () => {
    const conv = makeConversation('c', {
      messageTree: [{ id: 'a', parentId: null, role: 'user', content: 'x', createdAt: 'z' }],
      headId: 'a',
    });
    const { tree, headId } = ensureConversationTree(conv as never);
    expect(tree).toHaveLength(1);
    expect(headId).toBe('a');
  });

  it('walks the branch back through parentId', () => {
    const tree = [
      { id: 'a', parentId: null, role: 'user' as const, content: '', createdAt: '' },
      { id: 'b', parentId: 'a', role: 'assistant' as const, content: '', createdAt: '' },
      { id: 'c', parentId: 'a', role: 'assistant' as const, content: '', createdAt: '' },
    ];
    expect(getConversationBranch(tree, 'b').map((m) => m.id)).toEqual(['a', 'b']);
    expect(getConversationBranch(tree, 'c').map((m) => m.id)).toEqual(['a', 'c']);
  });
});

describe('conversations IPC: rewind', () => {
  const twoExchangeTree = [
    { id: 'u1', parentId: null, role: 'user' as const, content: 'q1', createdAt: 'x' },
    { id: 'a1', parentId: 'u1', role: 'assistant' as const, content: 'a1', createdAt: 'x' },
    { id: 'u2', parentId: 'a1', role: 'user' as const, content: 'q2', createdAt: 'x' },
    { id: 'a2', parentId: 'u2', role: 'assistant' as const, content: 'a2', createdAt: 'x' },
  ];

  it('rewinds one turn, shrinking the active branch and keeping the tail in the tree', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConversationHandlers(ipc as Parameters<typeof registerConversationHandlers>[0], appHome);
      },
    });
    await harness.invoke(
      'conversations:put',
      FAKE_EVENT,
      makeConversation('rw', {
        messages: twoExchangeTree,
        messageTree: twoExchangeTree,
        headId: 'a2',
        messageCount: 4,
        userMessageCount: 2,
      }),
    );

    const res = await harness.invoke<{ ok: boolean; removed: number }>('conversations:rewind', FAKE_EVENT, 'rw', 1);
    expect(res.ok).toBe(true);
    expect(res.removed).toBe(2);

    const after = await harness.invoke<{ messages: unknown[]; messageTree: unknown[] }>(
      'conversations:get',
      FAKE_EVENT,
      'rw',
    );
    expect(after.messages).toHaveLength(2); // active branch back to first exchange
    expect(after.messageTree).toHaveLength(4); // nothing lost — tail stays as a branch
  });

  it('refuses to rewind a compacted conversation', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConversationHandlers(ipc as Parameters<typeof registerConversationHandlers>[0], appHome);
      },
    });
    await harness.invoke(
      'conversations:put',
      FAKE_EVENT,
      makeConversation('rwc', {
        messages: twoExchangeTree,
        messageTree: twoExchangeTree,
        headId: 'a2',
        messageCount: 4,
        userMessageCount: 2,
        conversationCompaction: { summaryText: 'summary' },
      }),
    );

    const res = await harness.invoke<{ ok: boolean; error: string }>('conversations:rewind', FAKE_EVENT, 'rwc', 1);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('compacted');
  });
});
