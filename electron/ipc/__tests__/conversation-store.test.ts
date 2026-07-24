/**
 * Unit tests for the per-conversation store (`electron/ipc/conversation-store.ts`):
 * migration from the legacy monolith, per-file read/write, and index derivation.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readIndex,
  readConversation,
  readAllConversations,
  writeConversation,
  deleteConversation,
  clearAllConversations,
  toIndexEntry,
  migrateMonolithIfNeeded,
  __resetMigrationGuardForTests,
  sanitizeMessageTree,
  sanitizeConversationTree,
  type ConversationRecord,
} from '../conversation-store.js';

let tempRoot: string;
let appHome: string;

function makeConv(id: string, overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id,
    title: `Title ${id}`,
    fallbackTitle: null,
    messages: [],
    messageTree: [],
    headId: null,
    conversationCompaction: null,
    lastContextUsage: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastMessageAt: null,
    titleStatus: 'ready',
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
  tempRoot = mkdtempSync(join(tmpdir(), 'kai-convstore-'));
  appHome = join(tempRoot, 'app-home');
  mkdirSync(join(appHome, 'data'), { recursive: true });
  __resetMigrationGuardForTests();
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('per-file read/write', () => {
  it('round-trips a conversation and updates the index', () => {
    const conv = makeConv('c1', { title: 'Hello' });
    writeConversation(appHome, conv);

    expect(readConversation(appHome, 'c1')?.title).toBe('Hello');
    const index = readIndex(appHome);
    expect(index.conversations.c1).toBeDefined();
    expect(index.conversations.c1.title).toBe('Hello');
    // The heavy message fields must NOT be in the index entry.
    expect('messages' in index.conversations.c1).toBe(false);
    expect('messageTree' in index.conversations.c1).toBe(false);
  });

  it('round-trips a conversationCompaction record (persist → read deep-equal)', () => {
    const compaction = {
      compactionId: 'comp-1',
      summaryText: 'summary of the first N messages',
      compactedMessageIds: ['m1', 'm2', 'm3'],
      boundaryHeadId: 'm5',
      createdAt: '2026-07-10T00:00:00.000Z',
    };
    writeConversation(appHome, makeConv('cc1', { conversationCompaction: compaction }));
    expect(readConversation(appHome, 'cc1')?.conversationCompaction).toEqual(compaction);
  });

  it('defaults conversationCompaction to null when unset', () => {
    writeConversation(appHome, makeConv('cc2'));
    expect(readConversation(appHome, 'cc2')?.conversationCompaction).toBeNull();
  });

  it('derives hasToolCalls into the index entry', () => {
    const withTool = makeConv('c2', {
      messages: [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1' }] }],
    });
    expect(toIndexEntry(withTool).hasToolCalls).toBe(true);
    expect(toIndexEntry(makeConv('c3')).hasToolCalls).toBe(false);
  });

  it('deleteConversation removes the file and index entry', () => {
    writeConversation(appHome, makeConv('c1'));
    deleteConversation(appHome, 'c1');
    expect(readConversation(appHome, 'c1')).toBeNull();
    expect(readIndex(appHome).conversations.c1).toBeUndefined();
  });

  it('clearAllConversations empties files + index but keeps settings', () => {
    writeConversation(appHome, makeConv('c1'));
    writeConversation(appHome, makeConv('c2'));
    clearAllConversations(appHome);
    expect(readAllConversations(appHome)).toHaveLength(0);
    expect(Object.keys(readIndex(appHome).conversations)).toHaveLength(0);
  });

  it('rejects path-traversal ids', () => {
    expect(() => writeConversation(appHome, makeConv('../evil'))).toThrow();
    // A malformed id on read is treated as "not found", not a throw.
    expect(readConversation(appHome, '../evil')).toBeNull();
  });
});

describe('migration from the monolith', () => {
  function seedMonolith(convs: Record<string, ConversationRecord>, activeId: string | null = null): void {
    writeFileSync(
      join(appHome, 'data', 'conversations.json'),
      JSON.stringify({ conversations: convs, activeConversationId: activeId, settings: { foo: 'bar' } }),
      'utf-8',
    );
  }

  it('splits the monolith into per-file storage + index and renames it', () => {
    seedMonolith({ a: makeConv('a', { title: 'A' }), b: makeConv('b', { title: 'B' }) }, 'a');
    migrateMonolithIfNeeded(appHome);

    expect(existsSync(join(appHome, 'data', 'conversations', 'a.json'))).toBe(true);
    expect(existsSync(join(appHome, 'data', 'conversations', 'b.json'))).toBe(true);
    expect(existsSync(join(appHome, 'data', 'index.json'))).toBe(true);
    // Monolith is preserved as a safety copy, not deleted.
    expect(existsSync(join(appHome, 'data', 'conversations.json'))).toBe(false);
    expect(existsSync(join(appHome, 'data', 'conversations.json.migrated'))).toBe(true);

    const index = readIndex(appHome);
    expect(Object.keys(index.conversations).sort()).toEqual(['a', 'b']);
    expect(index.activeConversationId).toBe('a');
    expect(index.settings).toEqual({ foo: 'bar' });
    expect(readConversation(appHome, 'a')?.title).toBe('A');
  });

  it('is idempotent — a second call is a no-op', () => {
    seedMonolith({ a: makeConv('a') });
    migrateMonolithIfNeeded(appHome);
    __resetMigrationGuardForTests();
    // Second run: index already exists, so nothing is re-migrated or clobbered.
    migrateMonolithIfNeeded(appHome);
    expect(readIndex(appHome).conversations.a).toBeDefined();
  });

  it('does nothing when there is no monolith', () => {
    migrateMonolithIfNeeded(appHome);
    expect(existsSync(join(appHome, 'data', 'index.json'))).toBe(false);
    expect(readIndex(appHome).conversations).toEqual({});
  });

  it('leaves the monolith in place on parse failure', () => {
    writeFileSync(join(appHome, 'data', 'conversations.json'), '{corrupt', 'utf-8');
    migrateMonolithIfNeeded(appHome);
    // Failed migration must NOT delete/rename the monolith (no data loss).
    expect(existsSync(join(appHome, 'data', 'conversations.json'))).toBe(true);
    expect(existsSync(join(appHome, 'data', 'conversations.json.migrated'))).toBe(false);
  });

  it('aborts atomically if any record fails — monolith intact, no partial files', () => {
    // A bad (path-traversal) id makes sanitizeId throw mid-migration. The whole
    // migration must abort: monolith kept, index NOT written, no per-file leftovers.
    writeFileSync(
      join(appHome, 'data', 'conversations.json'),
      JSON.stringify({
        conversations: { good: makeConv('good'), '../evil': makeConv('../evil') },
        activeConversationId: null,
        settings: {},
      }),
      'utf-8',
    );
    migrateMonolithIfNeeded(appHome);
    expect(existsSync(join(appHome, 'data', 'conversations.json'))).toBe(true);
    expect(existsSync(join(appHome, 'data', 'conversations.json.migrated'))).toBe(false);
    expect(existsSync(join(appHome, 'data', 'index.json'))).toBe(false);
    // The valid "good" record must NOT have been left behind as a partial write.
    expect(existsSync(join(appHome, 'data', 'conversations', 'good.json'))).toBe(false);
  });

  it('a write to an existing id after upgrade is not clobbered by lazy migration', () => {
    // Simulate a freshly-upgraded install: monolith on disk, no index yet, and
    // the migration guard not yet tripped this "session".
    writeFileSync(
      join(appHome, 'data', 'conversations.json'),
      JSON.stringify({
        conversations: { c1: makeConv('c1', { title: 'OLD' }) },
        activeConversationId: 'c1',
        settings: {},
      }),
      'utf-8',
    );
    __resetMigrationGuardForTests();
    // First post-upgrade action is a WRITE to that same id (e.g. a new message).
    writeConversation(appHome, makeConv('c1', { title: 'NEW' }));
    // The write must win — migration (which runs first inside writeConversation)
    // must not overwrite it with the stale monolith copy.
    expect(readConversation(appHome, 'c1')?.title).toBe('NEW');
    expect(readIndex(appHome).conversations.c1.title).toBe('NEW');
  });

  it('refuses to write (no partial index) if migration is pending/failed', () => {
    // A corrupt monolith makes migration fail. A write must then THROW rather
    // than create index.json — a partial index would strand the old chats
    // because future reads skip migration once index.json exists.
    writeFileSync(join(appHome, 'data', 'conversations.json'), '{corrupt', 'utf-8');
    __resetMigrationGuardForTests();
    expect(() => writeConversation(appHome, makeConv('new'))).toThrow(/migration is pending/);
    expect(existsSync(join(appHome, 'data', 'index.json'))).toBe(false);
    // The monolith remains, so migration can be retried once corruption is fixed.
    expect(existsSync(join(appHome, 'data', 'conversations.json'))).toBe(true);
  });

  it('rebuilds the index from conversation files when index.json is corrupt', () => {
    // Write two conversations normally so their per-file records exist.
    writeConversation(appHome, makeConv('a', { title: 'Alpha' }));
    writeConversation(appHome, makeConv('b', { title: 'Beta' }));
    // Corrupt the index on disk (simulates a torn write / disk corruption).
    writeFileSync(join(appHome, 'data', 'index.json'), '{ this is not json', 'utf-8');
    // readIndex must NOT return empty (which would hide both chats) — it rebuilds
    // the summaries from the intact per-file records.
    const index = readIndex(appHome);
    expect(Object.keys(index.conversations).sort()).toEqual(['a', 'b']);
    expect(index.conversations.a.title).toBe('Alpha');
    expect(index.conversations.b.title).toBe('Beta');
  });

  it('rebuilds the index from conversation files when index.json is missing but files exist', () => {
    writeConversation(appHome, makeConv('a', { title: 'Alpha' }));
    // Delete only the index, leaving the per-file record (crash between file
    // write and index write).
    rmSync(join(appHome, 'data', 'index.json'), { force: true });
    const index = readIndex(appHome);
    expect(Object.keys(index.conversations)).toEqual(['a']);
    expect(index.conversations.a.title).toBe('Alpha');
  });
});

describe('sanitizeMessageTree (tree-integrity invariant)', () => {
  it('is a no-op on a well-formed linear tree', () => {
    const tree = [
      { id: 'u1', role: 'user', parentId: null, content: 'hi' },
      { id: 'a1', role: 'assistant', parentId: 'u1', content: 'hello' },
    ];
    const { tree: out, headId, report } = sanitizeMessageTree(tree, 'a1');
    expect(report.changed).toBe(false);
    expect(out).toHaveLength(2);
    expect(headId).toBe('a1');
  });

  it('merges a duplicate id by concatenating array content', () => {
    const tree = [
      { id: 'u1', role: 'user', parentId: null, content: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parentId: 'u1', content: [{ type: 'tool-call', toolCallId: 't1' }] },
      { id: 'a1', role: 'assistant', parentId: 'u1', content: [{ type: 'tool-call', toolCallId: 't2' }] },
    ];
    const { tree: out, report } = sanitizeMessageTree(tree, 'a1');
    expect(report.dedupedIds).toContain('a1');
    const ids = out.map((n) => n.id);
    expect(ids.filter((i) => i === 'a1')).toHaveLength(1);
    const a1 = out.find((n) => n.id === 'a1')!;
    expect((a1.content as unknown[]).length).toBe(2); // both tool-calls preserved
  });

  it('clears a stale tokenCount on the merged node so it gets recomputed (content changed)', () => {
    const tree = [
      { id: 'u1', role: 'user', parentId: null, content: [{ type: 'text', text: 'hi' }], tokenCount: 5 },
      { id: 'a1', role: 'assistant', parentId: 'u1', content: [{ type: 'text', text: 'x' }], tokenCount: 3 },
      { id: 'a1', role: 'assistant', parentId: 'u1', content: [{ type: 'text', text: 'yyyy' }], tokenCount: 9 },
    ];
    const { tree: out } = sanitizeMessageTree(tree, 'a1');
    const a1 = out.find((n) => n.id === 'a1') as { tokenCount?: unknown };
    // Merged content ⇒ the pre-merge count is invalid and must be dropped (a later
    // backfill recomputes it); leaving 3 or 9 could under-count and miss the gate.
    expect(a1.tokenCount).toBeUndefined();
    // Untouched node keeps its count.
    expect((out.find((n) => n.id === 'u1') as { tokenCount?: number }).tokenCount).toBe(5);
  });

  it('breaks a 2-node parent cycle and keeps the branch reachable (the inject-corruption shape)', () => {
    // assistant.parentId = inject AND inject.parentId = assistant → cycle that
    // truncated the active branch and orphaned earlier history.
    const tree = [
      { id: 'u1', role: 'user', parentId: null, content: 'first' },
      { id: 'a1', role: 'assistant', parentId: 'u1', content: 'reply' },
      { id: 'asst', role: 'assistant', parentId: 'inj', content: 'partial' },
      { id: 'inj', role: 'user', parentId: 'asst', content: 'guiding' },
    ];
    const { tree: out, report } = sanitizeMessageTree(tree, 'inj');
    expect(report.cycleBrokenIds.length).toBeGreaterThan(0);
    // No cycle remains: every node's parent chain terminates.
    const byId = new Map(out.map((n) => [n.id as string, n] as const));
    for (const n of out) {
      const seen = new Set<string>();
      let cur: string | null = n.id as string;
      while (cur) {
        expect(seen.has(cur)).toBe(false);
        seen.add(cur);
        const node = byId.get(cur);
        cur = node && typeof node.parentId === 'string' ? node.parentId : null;
      }
    }
  });

  it('detaches a self-parent and drops a dangling parent to root', () => {
    const tree = [
      { id: 'x', role: 'user', parentId: 'x', content: 'self' },
      { id: 'y', role: 'assistant', parentId: 'ghost', content: 'dangling' },
    ];
    const { tree: out, report } = sanitizeMessageTree(tree, 'y');
    expect(report.changed).toBe(true);
    expect(out.find((n) => n.id === 'x')!.parentId).toBeNull();
    expect(out.find((n) => n.id === 'y')!.parentId).toBeNull();
  });

  it('repoints an unreachable head to the deepest resolvable chain', () => {
    const tree = [
      { id: 'u1', role: 'user', parentId: null, content: 'a' },
      { id: 'a1', role: 'assistant', parentId: 'u1', content: 'b' },
      { id: 'u2', role: 'user', parentId: 'a1', content: 'c' },
    ];
    const { headId, report } = sanitizeMessageTree(tree, 'gone');
    expect(report.headRepointed).toBe(true);
    expect(headId).toBe('u2'); // deepest leaf
  });

  it('preserves a DELIBERATELY null head (rewind through the first user turn)', () => {
    // conversations:rewind writes headId:null to mean "empty active branch, tree
    // kept as shelved history". This is valid, NOT corruption — the sanitizer must
    // not repoint it to the old branch.
    const tree = [
      { id: 'u1', role: 'user', parentId: null, content: 'a' },
      { id: 'a1', role: 'assistant', parentId: 'u1', content: 'b' },
    ];
    const { headId, report } = sanitizeMessageTree(tree, null);
    expect(report.headRepointed).toBe(false);
    expect(headId).toBeNull();
  });

  it('sanitizeConversationTree rebuilds messages + counts from the repaired tree', () => {
    const conv = {
      id: 'c',
      messageTree: [
        { id: 'u1', role: 'user', parentId: null, content: 'first' },
        { id: 'a1', role: 'assistant', parentId: 'u1', content: 'reply' },
        { id: 'asst', role: 'assistant', parentId: 'inj', content: 'partial' },
        { id: 'inj', role: 'user', parentId: 'asst', content: 'guiding' },
      ],
      headId: 'inj',
      messages: [],
      messageCount: 0,
      userMessageCount: 0,
    } as unknown as ConversationRecord;
    const out = sanitizeConversationTree(conv);
    expect(out).not.toBe(conv); // repaired copy
    // Active branch reachable from head has no cycle and includes real messages.
    expect(out.messageCount).toBeGreaterThan(0);
    expect((out.messages as Array<{ id: string }>).length).toBe(out.messageCount);
  });
});

describe('writeConversation repairs a corrupt tree at the write chokepoint', () => {
  it('persists a de-cycled, de-duped tree even if handed a corrupt one', () => {
    const conv = {
      id: 'corrupt',
      title: null,
      fallbackTitle: null,
      messages: [],
      messageTree: [
        { id: 'u1', role: 'user', parentId: null, content: 'first' },
        { id: 'a1', role: 'assistant', parentId: 'u1', content: 'reply' },
        { id: 'asst', role: 'assistant', parentId: 'inj', content: [{ type: 'tool-call', toolCallId: 't1' }] },
        { id: 'inj', role: 'user', parentId: 'asst', content: 'guiding' },
        { id: 'asst', role: 'assistant', parentId: 'inj', content: [{ type: 'tool-call', toolCallId: 't2' }] },
      ],
      headId: 'inj',
      conversationCompaction: null,
      lastContextUsage: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastMessageAt: null,
      titleStatus: 'idle',
      titleUpdatedAt: null,
      messageCount: 0,
      userMessageCount: 0,
      runStatus: 'idle',
      hasUnread: false,
      lastAssistantUpdateAt: null,
      selectedModelKey: null,
    } as unknown as ConversationRecord;

    writeConversation(appHome, conv);
    const back = readConversation(appHome, 'corrupt')!;
    const tree = back.messageTree as Array<{ id: string; parentId: string | null }>;
    // No duplicate ids.
    expect(new Set(tree.map((n) => n.id)).size).toBe(tree.length);
    // No cycle from any node.
    const byId = new Map(tree.map((n) => [n.id, n] as const));
    for (const n of tree) {
      const seen = new Set<string>();
      let cur: string | null = n.id;
      while (cur) {
        expect(seen.has(cur)).toBe(false);
        seen.add(cur);
        cur = byId.get(cur)?.parentId ?? null;
      }
    }
  });

  it('returns the SANITIZED record so callers broadcast the repaired tree (not the corrupt input)', () => {
    const conv = {
      id: 'ret',
      title: null,
      fallbackTitle: null,
      messages: [],
      messageTree: [
        { id: 'u1', role: 'user', parentId: null, content: 'a' },
        { id: 'dup', role: 'assistant', parentId: 'u1', content: [{ type: 'text', text: 'x' }] },
        { id: 'dup', role: 'assistant', parentId: 'u1', content: [{ type: 'text', text: 'y' }] },
      ],
      headId: 'dup',
      conversationCompaction: null,
      lastContextUsage: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastMessageAt: null,
      titleStatus: 'idle',
      titleUpdatedAt: null,
      messageCount: 0,
      userMessageCount: 0,
      runStatus: 'idle',
      hasUnread: false,
      lastAssistantUpdateAt: null,
      selectedModelKey: null,
    } as unknown as ConversationRecord;

    const returned = writeConversation(appHome, conv);
    const rtree = returned.messageTree as Array<{ id: string }>;
    // The returned record is de-duped (matches disk), not the 3-node corrupt input.
    expect(rtree.filter((n) => n.id === 'dup')).toHaveLength(1);
    expect(rtree.length).toBe(2);
    // And it matches what is on disk.
    const disk = readConversation(appHome, 'ret')!;
    expect((disk.messageTree as unknown[]).length).toBe(rtree.length);
  });

  it('backfills missing per-message tokenCount at the write chokepoint (covers the put path)', () => {
    const conv = {
      id: 'bf',
      title: null,
      fallbackTitle: null,
      messages: [],
      messageTree: [
        { id: 'u1', role: 'user', parentId: null, content: 'hello there' },
        { id: 'a1', role: 'assistant', parentId: 'u1', content: 'a reply' },
      ],
      headId: 'a1',
      conversationCompaction: null,
      lastContextUsage: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastMessageAt: null,
      titleStatus: 'idle',
      titleUpdatedAt: null,
      messageCount: 0,
      userMessageCount: 0,
      runStatus: 'idle',
      hasUnread: false,
      lastAssistantUpdateAt: null,
      selectedModelKey: null,
    } as unknown as ConversationRecord;

    const returned = writeConversation(appHome, conv);
    const rtree = returned.messageTree as Array<{ id: string; tokenCount?: number }>;
    for (const n of rtree) {
      expect(typeof n.tokenCount).toBe('number');
      expect(n.tokenCount).toBeGreaterThan(0);
    }
    // Persisted on disk too.
    const disk = readConversation(appHome, 'bf')!;
    for (const n of disk.messageTree as Array<{ tokenCount?: number }>) {
      expect(typeof n.tokenCount).toBe('number');
    }
  });
});
