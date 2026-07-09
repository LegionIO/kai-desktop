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
});
