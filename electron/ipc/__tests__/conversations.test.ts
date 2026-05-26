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
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
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
  registerConversationHandlers,
  readConversationStore,
  writeConversationStore,
} from '../conversations.js';

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

    const putResult = await harness.invoke<{ ok: boolean }>(
      'conversations:put',
      FAKE_EVENT,
      conversation,
    );
    expect(putResult).toEqual({ ok: true });

    const fetched = await harness.invoke<Record<string, unknown> | null>(
      'conversations:get',
      FAKE_EVENT,
      'conv-1',
    );
    expect(fetched).not.toBeNull();
    expect(fetched).toMatchObject({ id: 'conv-1', title: 'Hello world' });

    const list = await harness.invoke<Array<{ id: string; hasToolCalls: boolean }>>(
      'conversations:list',
      FAKE_EVENT,
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'conv-1', hasToolCalls: false });

    // The on-disk store should contain the entry as well.
    const onDisk = JSON.parse(
      readFileSync(join(appHome, 'data', 'conversations.json'), 'utf-8'),
    );
    expect(onDisk.conversations['conv-1']).toBeDefined();
  });
});

describe('conversations IPC: error paths', () => {
  it('returns null for conversations:get when the id is unknown', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConversationHandlers(ipc as Parameters<typeof registerConversationHandlers>[0], appHome);
      },
    });

    const result = await harness.invoke<unknown>(
      'conversations:get',
      FAKE_EVENT,
      'does-not-exist',
    );
    expect(result).toBeNull();
  });

  it('treats conversations:delete of an unknown id as a benign no-op', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerConversationHandlers(ipc as Parameters<typeof registerConversationHandlers>[0], appHome);
      },
    });

    const result = await harness.invoke<{ ok: boolean }>(
      'conversations:delete',
      FAKE_EVENT,
      'ghost',
    );
    expect(result).toEqual({ ok: true });
    // No conversation existed, so the store file is created on write but the
    // conversation map stays empty.
    expect(existsSync(join(appHome, 'data', 'conversations.json'))).toBe(true);
    const onDisk = JSON.parse(
      readFileSync(join(appHome, 'data', 'conversations.json'), 'utf-8'),
    );
    expect(onDisk.conversations).toEqual({});
  });

  it('tolerates a corrupted conversations.json by returning an empty store', async () => {
    // Seed the store file with junk so the read path falls into its catch.
    writeConversationStore(appHome, {
      conversations: {},
      activeConversationId: null,
      settings: {},
    });
    const storePath = join(appHome, 'data', 'conversations.json');
    // Overwrite with invalid JSON to exercise the parse failure branch.
    mkdirSync(join(appHome, 'data'), { recursive: true });
    writeFileSync(storePath, '{not valid json', 'utf-8');

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

    const setResult = await harness.invoke<{ ok: boolean }>(
      'conversations:set-active-id',
      FAKE_EVENT,
      'conv-active',
    );
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

    const activeAfter = await harness.invoke<string | null>(
      'conversations:get-active-id',
      FAKE_EVENT,
    );
    expect(activeAfter).toBeNull();
    const remaining = await harness.invoke<Array<{ id: string }>>(
      'conversations:list',
      FAKE_EVENT,
    );
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
    const activeId = await harness.invoke<string | null>(
      'conversations:get-active-id',
      FAKE_EVENT,
    );
    expect(activeId).toBeNull();
  });
});
