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
  reparentConversationMessage,
  reorderInjectPrefixOnDisk,
  summarizablePrefixMatchesDisk,
} from '../conversations.js';
import { sumBranchTokenCounts } from '../../agent/tokenization.js';
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

  it('conversations:put does not let a stale running write clobber final content with an older partial', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConversationHandlers(ipc as Parameters<typeof registerConversationHandlers>[0], appHome);
      },
    });

    // On-disk: stream finished — assistant 'a' has FINAL content, runStatus idle,
    // with a recent lastAssistantUpdateAt.
    await harness.invoke(
      'conversations:put',
      FAKE_EVENT,
      makeConversation('c', {
        messageTree: [
          { id: 'u', parentId: null, role: 'user', content: 'q', createdAt: '2026-01-02T00:00:02.000Z' },
          { id: 'a', parentId: 'u', role: 'assistant', content: 'FINAL', createdAt: '2026-01-02T00:00:03.000Z' },
        ],
        headId: 'a',
        messageCount: 2,
        userMessageCount: 1,
        runStatus: 'idle',
        lastMessageAt: '2026-01-02T00:00:03.000Z',
        lastAssistantUpdateAt: '2026-01-02T00:00:03.000Z',
        updatedAt: '2026-01-02T00:00:03.000Z',
      }),
    );

    // A stale debounced write races in: SAME node ids (nothing "missing", so the
    // id-union merge is a no-op), but assistant 'a' still carries the older
    // PARTIAL content, runStatus:'running', and older timestamps.
    await harness.invoke(
      'conversations:put',
      FAKE_EVENT,
      makeConversation('c', {
        messageTree: [
          { id: 'u', parentId: null, role: 'user', content: 'q', createdAt: '2026-01-02T00:00:02.000Z' },
          { id: 'a', parentId: 'u', role: 'assistant', content: 'partial', createdAt: '2026-01-02T00:00:02.500Z' },
        ],
        headId: 'a',
        messageCount: 2,
        userMessageCount: 1,
        runStatus: 'running',
        lastMessageAt: '2026-01-02T00:00:02.500Z',
        lastAssistantUpdateAt: '2026-01-02T00:00:02.500Z',
        updatedAt: '2026-01-02T00:00:02.500Z',
      }),
    );

    const stored = readConversationStore(appHome).conversations.c as {
      runStatus: string;
      messageTree: Array<{ id: string; content: unknown }>;
    };
    // The final content must survive — the stale running write must NOT replace
    // it with the older partial, and runStatus must stay idle.
    expect(stored.messageTree.find((m) => m.id === 'a')?.content).toBe('FINAL');
    expect(stored.runStatus).toBe('idle');
  });
});

describe('conversations IPC: pending-draft claim (atomic single-winner)', () => {
  it('claim-pending-draft returns the draft once, then null for a concurrent claim of the same id', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConversationHandlers(ipc as Parameters<typeof registerConversationHandlers>[0], appHome);
      },
    });
    await harness.invoke('conversations:put', FAKE_EVENT, makeConversation('cd', {}));
    await harness.invoke('conversations:set-pending-drafts', FAKE_EVENT, 'cd', {
      add: [{ id: 'dr1', text: 'unsent input', attachments: [], stashedAt: 1 }],
      removeIds: [],
    });
    const first = await harness.invoke<{ ok: boolean; draft: { id: string; text: string } | null }>(
      'conversations:claim-pending-draft',
      FAKE_EVENT,
      'cd',
      'dr1',
    );
    expect(first.ok).toBe(true);
    expect(first.draft).toMatchObject({ id: 'dr1', text: 'unsent input' });
    const second = await harness.invoke<{ ok: boolean; draft: unknown }>(
      'conversations:claim-pending-draft',
      FAKE_EVENT,
      'cd',
      'dr1',
    );
    expect(second.ok).toBe(true);
    expect(second.draft).toBeNull();
  });

  it('claim-pending-draft with no id claims the OLDEST and leaves the rest', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConversationHandlers(ipc as Parameters<typeof registerConversationHandlers>[0], appHome);
      },
    });
    await harness.invoke('conversations:put', FAKE_EVENT, makeConversation('cd2', {}));
    await harness.invoke('conversations:set-pending-drafts', FAKE_EVENT, 'cd2', {
      add: [
        { id: 'old', text: 'first', attachments: [], stashedAt: 1 },
        { id: 'new', text: 'second', attachments: [], stashedAt: 2 },
      ],
      removeIds: [],
    });
    const claimed = await harness.invoke<{ ok: boolean; draft: { id: string } | null }>(
      'conversations:claim-pending-draft',
      FAKE_EVENT,
      'cd2',
    );
    expect(claimed.draft?.id).toBe('old');
    const remaining = await harness.invoke<{ ok: boolean; draft: { id: string } | null }>(
      'conversations:claim-pending-draft',
      FAKE_EVENT,
      'cd2',
    );
    expect(remaining.draft?.id).toBe('new');
  });

  it('claim RETAINS the draft (lease+ack): a claim without ack leaves it re-claimable by its holder', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConversationHandlers(ipc as Parameters<typeof registerConversationHandlers>[0], appHome);
      },
    });
    await harness.invoke('conversations:put', FAKE_EVENT, makeConversation('lease1', {}));
    await harness.invoke('conversations:set-pending-drafts', FAKE_EVENT, 'lease1', {
      add: [{ id: 'd', text: 'unsent', attachments: [], stashedAt: 1 }],
      removeIds: [],
    });
    // Client A reserves it (retained on disk, not removed).
    const a = await harness.invoke<{ draft: { id: string } | null }>(
      'conversations:claim-pending-draft',
      FAKE_EVENT,
      'lease1',
      'd',
      'A',
    );
    expect(a.draft?.id).toBe('d');
    // Another client B is denied while A's reservation is live.
    const b = await harness.invoke<{ draft: unknown }>(
      'conversations:claim-pending-draft',
      FAKE_EVENT,
      'lease1',
      'd',
      'B',
    );
    expect(b.draft).toBeNull();
    // A's OWN re-claim is allowed (idempotent for the holder) — proving the draft is still on disk.
    const a2 = await harness.invoke<{ draft: { id: string } | null }>(
      'conversations:claim-pending-draft',
      FAKE_EVENT,
      'lease1',
      'd',
      'A',
    );
    expect(a2.draft?.id).toBe('d');
  });

  it('ack(restored=true) hard-removes the draft; ack(restored=false) releases it for re-claim', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConversationHandlers(ipc as Parameters<typeof registerConversationHandlers>[0], appHome);
      },
    });
    await harness.invoke('conversations:put', FAKE_EVENT, makeConversation('lease2', {}));
    await harness.invoke('conversations:set-pending-drafts', FAKE_EVENT, 'lease2', {
      add: [
        { id: 'd1', text: 'first', attachments: [], stashedAt: 1 },
        { id: 'd2', text: 'second', attachments: [], stashedAt: 2 },
      ],
      removeIds: [],
    });
    // Reserve + ack(false) → released, so a fresh claim by another client succeeds.
    await harness.invoke('conversations:claim-pending-draft', FAKE_EVENT, 'lease2', 'd1', 'A');
    await harness.invoke('conversations:ack-pending-draft', FAKE_EVENT, 'lease2', 'd1', false, 'A');
    const reclaim = await harness.invoke<{ draft: { id: string } | null }>(
      'conversations:claim-pending-draft',
      FAKE_EVENT,
      'lease2',
      'd1',
      'B',
    );
    expect(reclaim.draft?.id).toBe('d1');
    // Reserve + ack(true) → hard-removed; a later claim of that id returns null.
    await harness.invoke('conversations:claim-pending-draft', FAKE_EVENT, 'lease2', 'd2', 'A');
    await harness.invoke('conversations:ack-pending-draft', FAKE_EVENT, 'lease2', 'd2', true, 'A');
    const gone = await harness.invoke<{ draft: unknown }>(
      'conversations:claim-pending-draft',
      FAKE_EVENT,
      'lease2',
      'd2',
      'C',
    );
    expect(gone.draft).toBeNull();
  });
});

describe('conversations IPC: error paths', () => {
  it('conversations:put of a just-deleted (tombstoned) conversation is rejected, not a phantom upsert', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConversationHandlers(ipc as Parameters<typeof registerConversationHandlers>[0], appHome);
      },
    });
    // Create then delete → the id is tombstoned. A stale client that re-puts it must be rejected
    // with conversation-deleted (writeConversation suppresses the write; no phantom upsert/success).
    await harness.invoke('conversations:put', FAKE_EVENT, makeConversation('tomb-put', {}));
    await harness.invoke('conversations:delete', FAKE_EVENT, 'tomb-put');
    const res = await harness.invoke<{ ok?: boolean; rejected?: string }>(
      'conversations:put',
      FAKE_EVENT,
      makeConversation('tomb-put', { title: 'resurrected?' }),
    );
    expect(res.rejected).toBe('conversation-deleted');
    expect(res.ok).not.toBe(true);
    // Nothing landed on disk.
    const fetched = await harness.invoke<unknown>('conversations:get', FAKE_EVENT, 'tomb-put');
    expect(fetched).toBeNull();
  });

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
  it('uses a supplied response id but refuses to duplicate an existing tree id', () => {
    writeConversationStore(appHome, {
      conversations: {
        c1: makeConversation('c1', {
          messageTree: [
            { id: 'existing-id', parentId: null, role: 'user', content: 'hi', createdAt: '2026-01-01T00:00:00Z' },
          ],
          headId: 'existing-id',
        }) as never,
      },
      activeConversationId: null,
      settings: {},
    });

    appendConversationMessages(appHome, 'c1', [
      { id: 'shared-response-id', role: 'assistant', content: 'first' },
      { id: 'existing-id', role: 'assistant', content: 'collision' },
    ]);

    const tree = (readConversationStore(appHome).conversations.c1 as { messageTree: Array<{ id: string }> })
      .messageTree;
    expect(tree[1].id).toBe('shared-response-id');
    expect(tree[2].id).not.toBe('existing-id');
    expect(new Set(tree.map((message) => message.id)).size).toBe(tree.length);
  });

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

  it('populates a per-message tokenCount on appended nodes and sums correctly over a branch', () => {
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

    appendConversationMessages(appHome, 'c1', [
      { role: 'user', content: 'a follow-up question with several words' },
      { role: 'assistant', content: 'a reasonably detailed answer to the follow-up question' },
    ]);

    const stored = readConversationStore(appHome).conversations.c1 as {
      messageTree: Array<{ id: string; tokenCount?: number }>;
      headId: string;
    };
    // Appended nodes carry a positive integer token count.
    const appended = stored.messageTree.slice(1);
    expect(appended).toHaveLength(2);
    for (const node of appended) {
      expect(typeof node.tokenCount).toBe('number');
      expect(node.tokenCount).toBeGreaterThan(0);
    }

    // Branch sum equals the sum of the active-branch node counts (the pre-existing
    // 'u1' node has no cached count and falls back to an estimate, still additive).
    const branch = getConversationBranch(stored.messageTree as never, stored.headId);
    const branchSum = sumBranchTokenCounts(branch as Array<{ tokenCount?: number; role?: unknown; content?: unknown }>);
    const appendedSum = appended.reduce((acc, n) => acc + (n.tokenCount ?? 0), 0);
    expect(branchSum).toBeGreaterThanOrEqual(appendedSum);
  });

  it('appending a LARGE diverse message byte-ceilings its count (no multi-MB sync encode / freeze)', () => {
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
    // ~2MB diverse payload (like a base64 image / huge tool result). appendConversation
    // Messages counts on the main thread — must not run a full tiktoken encode.
    let big = '';
    let i = 0;
    while (big.length < 2_000_000) {
      big += `seg-${i}-${((i * 2654435761) >>> 0).toString(36)} `;
      i++;
    }
    const start = Date.now();
    appendConversationMessages(appHome, 'c1', [{ role: 'user', content: big }]);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1500); // bounded — byte ceiling, not a multi-MB encode
    const stored = readConversationStore(appHome).conversations.c1 as {
      messageTree: Array<{ id: string; tokenCount?: number }>;
    };
    const appendedNode = stored.messageTree[stored.messageTree.length - 1];
    expect(typeof appendedNode.tokenCount).toBe('number');
    expect(appendedNode.tokenCount).toBeGreaterThan(0);
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

describe('reparentConversationMessage', () => {
  const seed = (tree: Array<{ id: string; parentId: string | null; role: string; content: string }>, headId: string) =>
    writeConversationStore(appHome, {
      conversations: { c1: makeConversation('c1', { messageTree: tree as never, headId }) as never },
      activeConversationId: null,
      settings: {},
    });

  it('repoints an existing node onto a new parent (sibling reparent), head unchanged', () => {
    // u1 → a1(prefix) ; u2(injected) also under u1 (sibling of a1). Reparent u2 onto a1.
    seed(
      [
        { id: 'u1', parentId: null, role: 'user', content: 'q' },
        { id: 'a1', parentId: 'u1', role: 'assistant', content: 'prefix' },
        { id: 'u2', parentId: 'u1', role: 'user', content: 'injected answer' },
      ],
      'a1',
    );
    const res = reparentConversationMessage(appHome, 'c1', 'u2', 'a1');
    expect(res).not.toBeNull();
    const tree = (
      readConversationStore(appHome).conversations.c1 as { messageTree: Array<{ id: string; parentId: string | null }> }
    ).messageTree;
    expect(tree.find((m) => m.id === 'u2')?.parentId).toBe('a1');
    expect((readConversationStore(appHome).conversations.c1 as { headId: string }).headId).toBe('a1');
  });

  it('is a no-op when the new parent would create a cycle (newParent descends from node)', () => {
    seed(
      [
        { id: 'u1', parentId: null, role: 'user', content: 'q' },
        { id: 'u2', parentId: 'u1', role: 'user', content: 'injected' },
        { id: 'a1', parentId: 'u2', role: 'assistant', content: 'reply' },
      ],
      'a1',
    );
    reparentConversationMessage(appHome, 'c1', 'u2', 'a1');
    const tree = (
      readConversationStore(appHome).conversations.c1 as { messageTree: Array<{ id: string; parentId: string | null }> }
    ).messageTree;
    expect(tree.find((m) => m.id === 'u2')?.parentId).toBe('u1'); // unchanged
  });

  it('returns null for a missing node, missing new parent, or self-parent', () => {
    seed([{ id: 'u1', parentId: null, role: 'user', content: 'q' }], 'u1');
    expect(reparentConversationMessage(appHome, 'c1', 'nope', 'u1')).toBeNull();
    expect(reparentConversationMessage(appHome, 'c1', 'u1', 'nope')).toBeNull();
    expect(reparentConversationMessage(appHome, 'c1', 'u1', 'u1')).toBeNull();
  });

  it('chains a multi-inject batch forward so ALL injected users stay on the active branch', () => {
    // Regression for the batched-inject head bug: prepareStep drained THREE
    // injects in one step. Only the first has prefix content; the loop must still
    // thread inj2 under inj1 and inj3 under inj2, advancing the head each time, or
    // inj2/inj3 dangle off the branch on a reload before continuation output.
    seed(
      [
        { id: 'u1', parentId: null, role: 'user', content: 'q' },
        { id: 'a1', parentId: 'u1', role: 'assistant', content: 'prefix' },
        // All three injects landed as siblings under the prior head (a1) at enqueue.
        { id: 'inj1', parentId: 'a1', role: 'user', content: 'first' },
        { id: 'inj2', parentId: 'a1', role: 'user', content: 'second' },
        { id: 'inj3', parentId: 'a1', role: 'user', content: 'third' },
      ],
      'a1',
    );
    // Simulate the broadcastStreamEvent loop's chain: prefixHead = a1 for inj1,
    // then no intervening content so chainParent walks to the prior injected id.
    let chainParent: string | null = 'a1';
    for (const id of ['inj1', 'inj2', 'inj3']) {
      reparentConversationMessage(appHome, 'c1', id, chainParent, { makeHead: true });
      chainParent = id;
    }
    const conv = readConversationStore(appHome).conversations.c1 as {
      messageTree: Array<{ id: string; parentId: string | null }>;
      headId: string;
      messages: Array<{ id: string }>;
    };
    expect(conv.messageTree.find((m) => m.id === 'inj1')?.parentId).toBe('a1');
    expect(conv.messageTree.find((m) => m.id === 'inj2')?.parentId).toBe('inj1');
    expect(conv.messageTree.find((m) => m.id === 'inj3')?.parentId).toBe('inj2');
    expect(conv.headId).toBe('inj3');
    // The active branch must contain all three injects in order.
    const ids = conv.messages.map((m) => m.id);
    expect(ids).toEqual(['u1', 'a1', 'inj1', 'inj2', 'inj3']);
  });
});

describe('reorderInjectPrefixOnDisk — GUI terminal-drain prefix-before-user repair', () => {
  const seed = (tree: Array<{ id: string; parentId: string | null; role: string; content: string }>, headId: string) =>
    writeConversationStore(appHome, {
      conversations: { c1: makeConversation('c1', { messageTree: tree as never, headId }) as never },
      activeConversationId: null,
      settings: {},
    });

  it('swaps an assistant mis-parented under the injected user and makes the user the head', () => {
    // The inject arrived after the final prepareStep; the renderer parented the
    // turn's assistant UNDER the injected user (u1 → inject → assistant, head=assistant).
    seed(
      [
        { id: 'u1', parentId: null, role: 'user', content: 'q' },
        { id: 'inject', parentId: 'u1', role: 'user', content: 'follow-up' },
        { id: 'asst', parentId: 'inject', role: 'assistant', content: 'reply' },
      ],
      'asst',
    );
    const head = reorderInjectPrefixOnDisk(appHome, 'c1', 'inject');
    expect(head).toBe('inject');
    const conv = readConversationStore(appHome).conversations.c1 as {
      messageTree: Array<{ id: string; parentId: string | null }>;
      headId: string;
      messages: Array<{ id: string }>;
    };
    expect(conv.messageTree.find((m) => m.id === 'asst')?.parentId).toBe('u1');
    expect(conv.messageTree.find((m) => m.id === 'inject')?.parentId).toBe('asst');
    expect(conv.headId).toBe('inject');
    expect(conv.messages.map((m) => m.id)).toEqual(['u1', 'asst', 'inject']);
  });

  it('is a no-op (returns current head) when the injected user has no assistant child', () => {
    seed(
      [
        { id: 'u1', parentId: null, role: 'user', content: 'q' },
        { id: 'inject', parentId: 'u1', role: 'user', content: 'follow-up' },
      ],
      'inject',
    );
    expect(reorderInjectPrefixOnDisk(appHome, 'c1', 'inject')).toBe('inject');
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

  it('rewinding through the first user turn yields an empty active branch (null head), not the old branch', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConversationHandlers(ipc as Parameters<typeof registerConversationHandlers>[0], appHome);
      },
    });
    await harness.invoke(
      'conversations:put',
      FAKE_EVENT,
      makeConversation('rwall', {
        messages: twoExchangeTree,
        messageTree: twoExchangeTree,
        headId: 'a2',
        messageCount: 4,
        userMessageCount: 2,
      }),
    );

    // Rewind past BOTH user turns → head becomes null (empty active branch, tree
    // shelved). The write-path sanitizer must NOT treat null head as corruption and
    // restore the old branch.
    const res = await harness.invoke<{ ok: boolean }>('conversations:rewind', FAKE_EVENT, 'rwall', 5);
    expect(res.ok).toBe(true);
    const after = await harness.invoke<{ messages: unknown[]; headId: string | null }>(
      'conversations:get',
      FAKE_EVENT,
      'rwall',
    );
    expect(after.messages).toHaveLength(0);
    expect(after.headId).toBeNull();
    // The tree is retained as shelved history.
    const stored = readConversationStore(appHome).conversations.rwall as { messageTree: unknown[] };
    expect(stored.messageTree.length).toBe(4);
  });

  it('normalizes a NaN steps value to 1 instead of nulling the head', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConversationHandlers(ipc as Parameters<typeof registerConversationHandlers>[0], appHome);
      },
    });
    await harness.invoke(
      'conversations:put',
      FAKE_EVENT,
      makeConversation('rwnan', {
        messages: twoExchangeTree,
        messageTree: twoExchangeTree,
        headId: 'a2',
        messageCount: 4,
        userMessageCount: 2,
      }),
    );

    // A non-numeric steps from the wire must not produce removed: NaN / head: null.
    const res = await harness.invoke<{ ok: boolean; removed: number }>(
      'conversations:rewind',
      FAKE_EVENT,
      'rwnan',
      'garbage' as unknown as number,
    );
    expect(res.ok).toBe(true);
    expect(res.removed).toBe(2); // treated as steps=1
    const after = await harness.invoke<{ messages: unknown[] }>('conversations:get', FAKE_EVENT, 'rwnan');
    expect(after.messages).toHaveLength(2);
  });
});

describe('summarizablePrefixMatchesDisk (/compact pre-flight reuse gate)', () => {
  it('accepts a clean leading prefix that matches disk', () => {
    const disk = ['a', 'b', 'c', 'd'];
    // boundary=2 → summarize [a,b]; both match disk positionally.
    expect(summarizablePrefixMatchesDisk(['a', 'b', 'c', 'd'], disk, 2)).toBe(true);
  });

  it('rejects a hook that reordered/altered an id INSIDE the summarized prefix', () => {
    const disk = ['a', 'b', 'c', 'd'];
    expect(summarizablePrefixMatchesDisk(['a', 'X', 'c', 'd'], disk, 3)).toBe(false);
  });

  it('rejects a TAIL-APPENDED id-less message that lands in the prefix (zero protected tail)', () => {
    // Hook appended one message with no id; disk has 3 real ids. With a zero
    // protected tail the boundary spans all 4, so the appended (undefined) id at
    // index 3 must be inspected and rejected — the case a min-overlap scan misses.
    const disk = ['a', 'b', 'c'];
    const msgIds = ['a', 'b', 'c', undefined];
    expect(summarizablePrefixMatchesDisk(msgIds, disk, 4)).toBe(false);
  });

  it('rejects a TAIL-APPENDED NEW id (present but not on disk) inside the prefix', () => {
    const disk = ['a', 'b', 'c'];
    expect(summarizablePrefixMatchesDisk(['a', 'b', 'c', 'new-id'], disk, 4)).toBe(false);
  });

  it('accepts when the appended message is OUTSIDE the summarized prefix (protected tail)', () => {
    // Same appended id, but boundary=3 protects it → only [a,b,c] summarized.
    const disk = ['a', 'b', 'c'];
    expect(summarizablePrefixMatchesDisk(['a', 'b', 'c', 'new-id'], disk, 3)).toBe(true);
  });

  it('rejects an empty-string or non-string id in the prefix', () => {
    const disk = ['a', 'b', 'c'];
    expect(summarizablePrefixMatchesDisk(['a', '', 'c'], disk, 3)).toBe(false);
    expect(summarizablePrefixMatchesDisk(['a', 42, 'c'], disk, 3)).toBe(false);
  });

  it('rejects when there is nothing summarizable (empty inputs or zero boundary)', () => {
    expect(summarizablePrefixMatchesDisk([], ['a'], 1)).toBe(false);
    expect(summarizablePrefixMatchesDisk(['a'], [], 1)).toBe(false);
    expect(summarizablePrefixMatchesDisk(['a', 'b'], ['a', 'b'], 0)).toBe(false);
  });

  it('clamps a boundary past the message list to the available ids', () => {
    const disk = ['a', 'b', 'c'];
    // boundary huge → prefixLen clamps to msgIds.length; all match → true.
    expect(summarizablePrefixMatchesDisk(['a', 'b'], disk, 999)).toBe(true);
  });
});
