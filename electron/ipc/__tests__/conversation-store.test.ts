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
