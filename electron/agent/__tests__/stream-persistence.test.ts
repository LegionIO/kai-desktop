/**
 * Server-side stream → assistant-message persistence.
 *
 * The CLI/headless client doesn't persist the assistant reply itself, so the
 * main process accumulates the stream and writes the turn on `done`. This
 * verifies text + tool parts merge correctly and that persistence only fires
 * once, with content, on completion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const appendMock = vi.fn();
const readMock = vi.fn(
  (_appHome?: string, _conversationId?: string) =>
    null as {
      headId?: string | null;
      runStatus?: string;
      messageTree?: Array<Record<string, unknown>>;
      messages?: Array<Record<string, unknown>>;
    } | null,
);
const writeMock = vi.fn((_appHome: string, conv: unknown) => conv);
// R269: readConversationStrict returns null ONLY for a genuinely-absent conversation and THROWS on a
// read/parse failure. By default it delegates to readMock (so a null there means "absent" → append works,
// matching the brand-new-conversation case). A test that needs to exercise the retain-on-read-failure path
// overrides this mock to throw.
const readStrictMock = vi.fn((appHome?: string, conversationId?: string) => readMock(appHome, conversationId));
vi.mock('../../ipc/conversations.js', () => ({
  // Return a minimal record whose headId is the id of the appended assistant
  // message, so finalizeInterruptedTurn's "return the new head" contract can be
  // asserted. Real appendConversationMessages sets headId to the last node.
  appendConversationMessages: (...args: unknown[]) => {
    const customResult = appendMock(...args);
    return customResult ?? { headId: 'persisted-head' };
  },
  broadcastUpsert: vi.fn(),
}));
vi.mock('../../ipc/conversation-store.js', () => ({
  readConversation: (appHome: string, conversationId: string) => readMock(appHome, conversationId),
  readConversationStrict: (appHome: string, conversationId: string) => readStrictMock(appHome, conversationId),
  writeConversation: (appHome: string, conv: unknown) => writeMock(appHome, conv),
}));

import {
  accumulateForPersistence,
  discardPersistenceAccumulator,
  finalizeInterruptedTurn,
  finalizeInterruptedTurnReplacing,
  finalizeInterruptedTurnUpsert,
  snapshotSupersededAccumulatorForRetry,
  flushSupersededSnapshots,
  purgeConversationPersistence,
  persistCooperativeInjectedUserTurn,
  finalizeGuiFallbackPrefixAtInject,
  clearFinalizedResponseIds,
} from '../stream-persistence.js';
import type { StreamEvent } from '../mastra-agent.js';

const APP_HOME = '/tmp/fake-home';
const feed = (e: Partial<StreamEvent>) => accumulateForPersistence(APP_HOME, e as StreamEvent);
const feedWithParent = (e: Partial<StreamEvent>, parentId?: string) =>
  accumulateForPersistence(APP_HOME, e as StreamEvent, parentId);

describe('stream persistence accumulator', () => {
  beforeEach(() => appendMock.mockReset());

  it('merges text deltas into one assistant text part on done', () => {
    feed({ conversationId: 'c1', type: 'text-delta', text: 'Hello ' });
    feed({ conversationId: 'c1', type: 'text-delta', text: 'world' });
    feed({ conversationId: 'c1', type: 'done' });

    expect(appendMock).toHaveBeenCalledTimes(1);
    const [home, id, msgs] = appendMock.mock.calls[0];
    expect(home).toBe(APP_HOME);
    expect(id).toBe('c1');
    expect(msgs).toEqual([
      { role: 'assistant', content: [{ type: 'text', source: 'assistant', text: 'Hello world' }] },
    ]);
  });

  it('persists the shared Kai/Mastra response id when the stream provides it', () => {
    feed({ conversationId: 'shared-id', type: 'text-delta', text: 'Hello', responseMessageId: 'msg-shared-1' });
    feed({ conversationId: 'shared-id', type: 'done', responseMessageId: 'msg-shared-1' });

    const [, , msgs] = appendMock.mock.calls[0];
    expect(msgs).toEqual([
      {
        id: 'msg-shared-1',
        role: 'assistant',
        content: [{ type: 'text', source: 'assistant', text: 'Hello' }],
      },
    ]);
  });

  it('preserves a continuation segment after an inject boundary (same responseMessageId) with a fresh id', () => {
    // Mastra reuses the SAME responseMessageId across steps of a run. After a
    // mid-turn inject we finalize the partial under that id; the run then CONTINUES
    // streaming new content under the same id. The continuation must NOT be
    // discarded — it is persisted as its own assistant node under a fresh id.
    clearFinalizedResponseIds('cont');
    feed({ conversationId: 'cont', type: 'text-delta', text: 'partial', responseMessageId: 'resp-1' });
    const firstHead = finalizeInterruptedTurn(APP_HOME, 'cont');
    expect(appendMock).toHaveBeenCalledTimes(1);
    expect(firstHead).toBeTruthy();
    const firstId = (appendMock.mock.calls[0][2] as Array<{ id?: string }>)[0].id;
    expect(firstId).toBe('resp-1'); // partial persisted under the real id

    // Continuation: a NEW accumulator with genuinely new content, same response id.
    feed({ conversationId: 'cont', type: 'text-delta', text: ' continued', responseMessageId: 'resp-1' });
    const secondHead = finalizeInterruptedTurn(APP_HOME, 'cont');
    // The continuation IS persisted (not dropped) — a second append.
    expect(appendMock).toHaveBeenCalledTimes(2);
    const secondMsg = (appendMock.mock.calls[1][2] as Array<{ id?: string; content: unknown }>)[0];
    // …under a FRESH id (not the already-taken resp-1) so it's a distinct node.
    expect(secondMsg.id).not.toBe('resp-1');
    expect(secondMsg.id).toContain('resp-1'); // derived from it for traceability
    expect(secondHead).toBeTruthy();
    clearFinalizedResponseIds('cont');
  });

  it('finalizeGuiFallbackPrefixAtInject finalizes the prefix, returns its head, and reseeds the continuation under the injected user', () => {
    clearFinalizedResponseIds('gui');
    // Prefix content accumulated before the inject boundary.
    feed({ conversationId: 'gui', type: 'text-delta', text: 'prefix reply', responseMessageId: 'resp-g' });
    const prefixHead = finalizeGuiFallbackPrefixAtInject(APP_HOME, 'gui', 'injected-user-id');
    // The prefix was finalized (one append) and its head returned.
    expect(appendMock).toHaveBeenCalledTimes(1);
    expect(prefixHead).toBeTruthy();
    // A fresh continuation accumulator is now parented on the injected user, so a
    // later continuation delta finalizes as a child of the injected user.
    feed({ conversationId: 'gui', type: 'text-delta', text: 'continuation', responseMessageId: 'resp-g2' });
    finalizeInterruptedTurn(APP_HOME, 'gui');
    expect(appendMock).toHaveBeenCalledTimes(2);
    const contCall = appendMock.mock.calls[1];
    // appendConversationMessages(home, id, msgs, opts) — opts.parentId is the injected user.
    expect((contCall[3] as { parentId?: string } | undefined)?.parentId).toBe('injected-user-id');
    clearFinalizedResponseIds('gui');
  });

  it('finalizeGuiFallbackPrefixAtInject with NO prefix content just reseeds under the injected user (no append)', () => {
    clearFinalizedResponseIds('gui2');
    const prefixHead = finalizeGuiFallbackPrefixAtInject(APP_HOME, 'gui2', 'iu2');
    expect(appendMock).not.toHaveBeenCalled();
    expect(prefixHead).toBeNull();
    // Reseeded accumulator is parented on the injected user.
    feed({ conversationId: 'gui2', type: 'text-delta', text: 'reply', responseMessageId: 'r' });
    finalizeInterruptedTurn(APP_HOME, 'gui2');
    expect((appendMock.mock.calls[0][3] as { parentId?: string } | undefined)?.parentId).toBe('iu2');
    clearFinalizedResponseIds('gui2');
  });

  it('finalizeInterruptedTurnReplacing REPLACES an existing assistant node (web-origin) instead of appending a duplicate', () => {
    clearFinalizedResponseIds('web');
    writeMock.mockClear();
    appendMock.mockClear();
    readMock.mockReturnValueOnce({
      id: 'web',
      headId: 'resp-web',
      messageTree: [
        { id: 'u', parentId: null, role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { id: 'resp-web', parentId: 'u', role: 'assistant', content: [{ type: 'text', text: '[capped]' }] },
      ],
      // Legacy flat `messages` array (used by search + Markdown export) also carries the capped copy.
      messages: [
        { id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { id: 'resp-web', role: 'assistant', content: [{ type: 'text', text: '[capped]' }] },
      ],
    } as unknown as { headId?: string | null });
    feed({ conversationId: 'web', type: 'text-delta', text: 'FULL reply', responseMessageId: 'resp-web' });
    const head = finalizeInterruptedTurnReplacing(APP_HOME, 'web');
    // REPLACE via writeConversation (no append → no duplicate sibling variant).
    expect(appendMock).not.toHaveBeenCalled();
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(head).toBe('resp-web');
    const writtenConv = writeMock.mock.calls[0][1] as {
      messageTree: Array<{ id: string; content: unknown }>;
      messages: Array<{ id: string; content: unknown }>;
    };
    const node = writtenConv.messageTree.find((m) => m.id === 'resp-web')!;
    expect(JSON.stringify(node.content)).toContain('FULL reply');
    expect(JSON.stringify(node.content)).not.toContain('[capped]');
    // The legacy flat `messages` node is ALSO refreshed (search/export read from it).
    const flat = writtenConv.messages.find((m) => m.id === 'resp-web')!;
    expect(JSON.stringify(flat.content)).toContain('FULL reply');
    expect(JSON.stringify(flat.content)).not.toContain('[capped]');
    clearFinalizedResponseIds('web');
  });

  it('finalizeInterruptedTurnReplacing PRESERVES a head/runStatus that moved past the node (newer turn)', () => {
    clearFinalizedResponseIds('web2');
    writeMock.mockClear();
    // A newer user turn advanced the head + set 'running' AFTER this (superseded) turn's node.
    readMock.mockReturnValueOnce({
      id: 'web2',
      headId: 'newerUser',
      runStatus: 'running',
      messageTree: [
        { id: 'u', parentId: null, role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { id: 'resp-web2', parentId: 'u', role: 'assistant', content: [{ type: 'text', text: '[capped]' }] },
        { id: 'newerUser', parentId: 'resp-web2', role: 'user', content: [{ type: 'text', text: 'next' }] },
      ],
    } as unknown as { headId?: string | null });
    feed({ conversationId: 'web2', type: 'text-delta', text: 'FULL reply', responseMessageId: 'resp-web2' });
    finalizeInterruptedTurnReplacing(APP_HOME, 'web2');
    const writtenConv = writeMock.mock.calls[0][1] as {
      headId: string;
      runStatus: string;
      messageTree: Array<{ id: string; content: unknown }>;
    };
    // The superseded node's content is still replaced with the full copy...
    const node = writtenConv.messageTree.find((m) => m.id === 'resp-web2')!;
    expect(JSON.stringify(node.content)).toContain('FULL reply');
    // ...but the CURRENT head + running status of the newer turn are NOT rewound / clobbered.
    expect(writtenConv.headId).toBe('newerUser');
    expect(writtenConv.runStatus).toBe('running');
    clearFinalizedResponseIds('web2');
  });

  it('finalizeInterruptedTurnUpsert REPLACES a local-origin node the renderer already persisted (no duplicate)', () => {
    // Local originator: the renderer's ~300ms debounced stream-persist already wrote the
    // assistant node under this run's responseMessageId, but disk is still 'running' (the
    // originator hasn't reached its terminal persist). A passive client wins continuation and
    // flushes main's fallback here. A plain append would collision-rename to a bogus
    // `auto-msg-*` sibling; upsert must REPLACE the existing node in place.
    clearFinalizedResponseIds('local');
    writeMock.mockClear();
    appendMock.mockClear();
    readMock.mockReturnValueOnce({
      id: 'local',
      headId: 'resp-local',
      runStatus: 'running',
      messageTree: [
        { id: 'u', parentId: null, role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { id: 'resp-local', parentId: 'u', role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
      ],
      messages: [
        { id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { id: 'resp-local', role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
      ],
    } as unknown as { headId?: string | null });
    feed({ conversationId: 'local', type: 'text-delta', text: 'FULL reply', responseMessageId: 'resp-local' });
    const head = finalizeInterruptedTurnUpsert(APP_HOME, 'local');
    expect(appendMock).not.toHaveBeenCalled();
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(head).toBe('resp-local');
    const writtenConv = writeMock.mock.calls[0][1] as { messageTree: Array<{ id: string; content: unknown }> };
    const node = writtenConv.messageTree.find((m) => m.id === 'resp-local')!;
    expect(JSON.stringify(node.content)).toContain('FULL reply');
    clearFinalizedResponseIds('local');
  });

  it('finalizeInterruptedTurnUpsert APPENDS when no node with that id exists yet (local, renderer not-yet-persisted)', () => {
    clearFinalizedResponseIds('local2');
    writeMock.mockClear();
    appendMock.mockClear();
    feed({ conversationId: 'local2', type: 'text-delta', text: 'reply', responseMessageId: 'resp-local2' });
    finalizeInterruptedTurnUpsert(APP_HOME, 'local2');
    // No pre-existing node under resp-local2 → falls through to a normal append.
    expect(appendMock).toHaveBeenCalledTimes(1);
    clearFinalizedResponseIds('local2');
  });

  it('finalizeInterruptedTurnUpsert RETAINS (no append) when every read is a transient FAILURE, not absence (R269)', () => {
    // R269: a read/parse FAILURE is not the same as a genuinely-absent conversation. If we treated the
    // failure as absence we'd append under resp-local3, collision-renaming an existing on-disk node into a
    // bogus duplicate sibling. readConversationStrict THROWS on failure → the upsert loop retains (returns
    // null) and lets the renderer's authoritative re-persist land the full content.
    clearFinalizedResponseIds('local3');
    writeMock.mockClear();
    appendMock.mockClear();
    readStrictMock.mockImplementationOnce(() => {
      throw new Error('EIO: simulated transient read failure');
    });
    readStrictMock.mockImplementationOnce(() => {
      throw new Error('EIO: simulated transient read failure');
    });
    readStrictMock.mockImplementationOnce(() => {
      throw new Error('EIO: simulated transient read failure');
    });
    feed({ conversationId: 'local3', type: 'text-delta', text: 'reply', responseMessageId: 'resp-local3' });
    const head = finalizeInterruptedTurnUpsert(APP_HOME, 'local3');
    expect(appendMock).not.toHaveBeenCalled(); // NEVER append on a read failure
    expect(head).toBeNull(); // accumulator retained for a later renderer re-persist
    clearFinalizedResponseIds('local3');
  });

  it('flushSupersededSnapshots inserts a recovered turn under its ORIGINAL parent and PRESERVES the head (R270)', () => {
    // R270: a takeover snapshotted a superseded turn (resp-A, answering user uA) whose flush failed. On a later
    // finalize the snapshot must be inserted parented on uA (its original parent) WITHOUT rewinding the head off
    // the successor turn (respB) — appendConversationMessages would do both wrong (parent under current head + move
    // head), so flushSupersededSnapshots writes the tree directly. Assert placement + head preservation.
    clearFinalizedResponseIds('sup1');
    writeMock.mockClear();
    appendMock.mockClear();
    // Seed a snapshot: feed content under resp-A parented on uA, then snapshot+clear the accumulator.
    feedWithParent(
      { conversationId: 'sup1', type: 'text-delta', text: 'superseded reply', responseMessageId: 'resp-A' },
      'uA',
    );
    expect(snapshotSupersededAccumulatorForRetry('sup1')).toBe(true);
    // Disk now carries only the successor branch: uA → respB (the head), resp-A is NOT present yet.
    readStrictMock.mockReturnValueOnce({
      id: 'sup1',
      headId: 'respB',
      runStatus: 'idle',
      messageTree: [
        { id: 'uA', parentId: null, role: 'user', content: [{ type: 'text', text: 'q' }] },
        { id: 'respB', parentId: 'uA', role: 'assistant', content: [{ type: 'text', text: 'successor' }] },
      ],
      messages: [],
    } as unknown as { headId?: string | null });
    flushSupersededSnapshots(APP_HOME, 'sup1');
    // Must NOT route through appendConversationMessages (which would mis-parent + move the head).
    expect(appendMock).not.toHaveBeenCalled();
    expect(writeMock).toHaveBeenCalledTimes(1);
    const written = writeMock.mock.calls[0][1] as {
      headId?: string | null;
      messageTree: Array<{ id: string; parentId: string | null; content: unknown }>;
    };
    // Head preserved on the successor.
    expect(written.headId).toBe('respB');
    // Recovered node present, parented on its ORIGINAL parent uA (not under respB).
    const recovered = written.messageTree.find((m) => m.id === 'resp-A')!;
    expect(recovered).toBeTruthy();
    expect(recovered.parentId).toBe('uA');
    expect(JSON.stringify(recovered.content)).toContain('superseded reply');
    clearFinalizedResponseIds('sup1');
  });

  it('flushSupersededSnapshots RETAINS a snapshot on a transient read FAILURE, drops it on genuine absence (R270)', () => {
    clearFinalizedResponseIds('sup2');
    writeMock.mockClear();
    feedWithParent({ conversationId: 'sup2', type: 'text-delta', text: 'reply', responseMessageId: 'resp-S2' }, 'uS2');
    snapshotSupersededAccumulatorForRetry('sup2');
    // Transient read failure → strict read throws → retain (no write, snapshot kept).
    readStrictMock.mockImplementationOnce(() => {
      throw new Error('EIO: transient');
    });
    flushSupersededSnapshots(APP_HOME, 'sup2');
    expect(writeMock).not.toHaveBeenCalled(); // retained, not written
    // Now a genuine absence (conversation deleted) → strict read returns null → drop the snapshot (no write, no retain).
    readStrictMock.mockReturnValueOnce(null);
    flushSupersededSnapshots(APP_HOME, 'sup2');
    expect(writeMock).not.toHaveBeenCalled();
    // A third flush with a good read now finds nothing to do (snapshot already dropped) → still no write.
    readStrictMock.mockReturnValueOnce({
      id: 'sup2',
      headId: 'uS2',
      runStatus: 'idle',
      messageTree: [{ id: 'uS2', parentId: null, role: 'user', content: [] }],
      messages: [],
    } as unknown as { headId?: string | null });
    flushSupersededSnapshots(APP_HOME, 'sup2');
    expect(writeMock).not.toHaveBeenCalled();
    clearFinalizedResponseIds('sup2');
  });

  it('superseded-snapshot store is BOUNDED — oldest snapshots evict under sustained I/O failure (R271 f-3)', () => {
    // R271 f-3: under a PERSISTENT disk failure with continued submissions the snapshot queue must not grow without
    // bound (main-process OOM). Snapshot many LARGE superseded turns across distinct conversations while every
    // flush fails (strict read throws), then assert the OLDEST recovered content is evicted (its flush now finds
    // nothing to write) while a RECENT one still flushes when the disk recovers.
    const BIG = 'x'.repeat(3 * 1024 * 1024); // 3 MiB per snapshot; cap is 24 MiB → ~8 fit, older evicted
    const convIds: string[] = [];
    for (let i = 0; i < 16; i++) {
      const cid = `cap-${i}`;
      convIds.push(cid);
      clearFinalizedResponseIds(cid);
      feedWithParent(
        { conversationId: cid, type: 'text-delta', text: BIG, responseMessageId: `resp-${cid}` },
        `u-${cid}`,
      );
      expect(snapshotSupersededAccumulatorForRetry(cid)).toBe(true);
    }
    writeMock.mockClear();
    // The OLDEST conversation (cap-0) should have been evicted → its flush writes nothing even with a good read.
    readStrictMock.mockReturnValue({
      id: 'cap-0',
      headId: 'u-cap-0',
      runStatus: 'idle',
      messageTree: [{ id: 'u-cap-0', parentId: null, role: 'user', content: [] }],
      messages: [],
    } as unknown as { headId?: string | null });
    flushSupersededSnapshots(APP_HOME, 'cap-0');
    expect(writeMock).not.toHaveBeenCalled(); // evicted → nothing to recover
    // A RECENT conversation (cap-15) should still be retained → its flush writes the recovered node.
    writeMock.mockClear();
    readStrictMock.mockReturnValue({
      id: 'cap-15',
      headId: 'u-cap-15',
      runStatus: 'idle',
      messageTree: [{ id: 'u-cap-15', parentId: null, role: 'user', content: [] }],
      messages: [],
    } as unknown as { headId?: string | null });
    flushSupersededSnapshots(APP_HOME, 'cap-15');
    expect(writeMock).toHaveBeenCalledTimes(1);
    readStrictMock.mockReset();
    readStrictMock.mockImplementation((appHome?: string, conversationId?: string) => readMock(appHome, conversationId));
    for (const cid of convIds) {
      purgeConversationPersistence(cid); // R272: clear residual retained snapshots so the byte accountant doesn't leak
      clearFinalizedResponseIds(cid);
    }
  });

  it('two id-less superseded snapshots are BOTH recorded — undefined ids are not deduplicated (R272 f-1)', () => {
    // R272 f-1: non-Mastra runtimes emit id-less events, so two distinct failed turns both carry
    // responseMessageId === undefined. Deduping by that would silently drop the second turn's reply.
    clearFinalizedResponseIds('anon');
    writeMock.mockClear();
    // First id-less superseded turn.
    feedWithParent({ conversationId: 'anon', type: 'text-delta', text: 'first anon reply' }, 'uAnon');
    expect(snapshotSupersededAccumulatorForRetry('anon')).toBe(true);
    // Second id-less superseded turn (same conversation, still no responseMessageId).
    feedWithParent({ conversationId: 'anon', type: 'text-delta', text: 'second anon reply' }, 'uAnon');
    expect(snapshotSupersededAccumulatorForRetry('anon')).toBe(true);
    // Flush with a good read → BOTH snapshots must be written (two appends, not one — the second wasn't deduped).
    readStrictMock.mockReturnValue({
      id: 'anon',
      headId: 'uAnon',
      runStatus: 'idle',
      messageTree: [{ id: 'uAnon', parentId: null, role: 'user', content: [] }],
      messages: [],
    } as unknown as { headId?: string | null });
    flushSupersededSnapshots(APP_HOME, 'anon');
    expect(writeMock).toHaveBeenCalledTimes(2); // both recovered, neither dropped as a "duplicate"
    readStrictMock.mockReset();
    readStrictMock.mockImplementation((appHome?: string, conversationId?: string) => readMock(appHome, conversationId));
    clearFinalizedResponseIds('anon');
  });

  it('eviction is GLOBALLY oldest-first across conversations (R272 f-3)', () => {
    // R272 f-3: draining one conversation's list before considering another could evict a NEWER reply while keeping
    // an OLDER one elsewhere. Interleave admissions across two conversations so the oldest are split between them,
    // then overflow the cap and assert the globally-OLDEST are evicted while the NEWEST survive — regardless of
    // which conversation they belong to.
    const BIG = 'y'.repeat(3 * 1024 * 1024); // 3 MiB each; cap 24 MiB → ~8 survive
    const ids: string[] = [];
    for (let i = 0; i < 16; i++) {
      const cid = i % 2 === 0 ? 'evA' : 'evB'; // interleave so seq order is NOT grouped by conversation
      const rid = `ev-${i}`;
      ids.push(rid);
      feedWithParent({ conversationId: cid, type: 'text-delta', text: BIG, responseMessageId: rid }, `u-${cid}`);
      expect(snapshotSupersededAccumulatorForRetry(cid)).toBe(true);
    }
    // Flush each conversation once with a good read; collect the rids that actually got written (i.e. survived).
    const written = new Set<string>();
    for (const cid of ['evA', 'evB']) {
      readStrictMock.mockReturnValue({
        id: cid,
        headId: `u-${cid}`,
        runStatus: 'idle',
        messageTree: [{ id: `u-${cid}`, parentId: null, role: 'user', content: [] }],
        messages: [],
      } as unknown as { headId?: string | null });
      writeMock.mockClear();
      flushSupersededSnapshots(APP_HOME, cid);
      for (const c of writeMock.mock.calls) {
        const conv = c[1] as { messageTree?: Array<{ id: string }> };
        conv.messageTree?.forEach((m) => written.add(m.id));
      }
    }
    // The globally-OLDEST admissions (ev-0 convA, ev-1 convB) must be evicted → NOT written.
    expect(written.has('ev-0')).toBe(false);
    expect(written.has('ev-1')).toBe(false);
    // The globally-NEWEST admissions (ev-14 convA, ev-15 convB) must survive → written.
    expect(written.has('ev-14')).toBe(true);
    expect(written.has('ev-15')).toBe(true);
    readStrictMock.mockReset();
    readStrictMock.mockImplementation((appHome?: string, conversationId?: string) => readMock(appHome, conversationId));
    for (const cid of ['evA', 'evB']) purgeConversationPersistence(cid);
    for (const rid of ids) clearFinalizedResponseIds(rid);
  });

  it('a true empty re-finalize (accumulator already flushed) is a no-op', () => {
    // finalize deletes the accumulator, so a second finalize with nothing newly
    // accumulated hits the empty guard and does not append.
    clearFinalizedResponseIds('empty');
    feed({ conversationId: 'empty', type: 'text-delta', text: 'x', responseMessageId: 'resp-e' });
    finalizeInterruptedTurn(APP_HOME, 'empty');
    expect(appendMock).toHaveBeenCalledTimes(1);
    // No new feed → accumulator is gone → second finalize appends nothing.
    const head = finalizeInterruptedTurn(APP_HOME, 'empty');
    expect(appendMock).toHaveBeenCalledTimes(1);
    expect(head).toBeNull();
    clearFinalizedResponseIds('empty');
  });

  it('a fresh turn reusing the id space after clear can persist again', () => {
    clearFinalizedResponseIds('reuse');
    feed({ conversationId: 'reuse', type: 'text-delta', text: 'x', responseMessageId: 'resp-2' });
    finalizeInterruptedTurn(APP_HOME, 'reuse');
    expect(appendMock).toHaveBeenCalledTimes(1);
    // done clears tracking in production; simulate it here.
    clearFinalizedResponseIds('reuse');
    feed({ conversationId: 'reuse', type: 'text-delta', text: 'y', responseMessageId: 'resp-2' });
    finalizeInterruptedTurn(APP_HOME, 'reuse');
    expect(appendMock).toHaveBeenCalledTimes(2);
    clearFinalizedResponseIds('reuse');
  });

  it('merges a tool-call and its result into one tool part', () => {
    feed({ conversationId: 'c2', type: 'tool-call', toolCallId: 't1', toolName: 'read_file', args: { path: 'a' } });
    feed({ conversationId: 'c2', type: 'tool-result', toolCallId: 't1', result: 'contents', durationMs: 42 });
    feed({ conversationId: 'c2', type: 'done' });

    const [, , msgs] = appendMock.mock.calls[0];
    expect(msgs[0].content).toEqual([
      {
        type: 'tool-call',
        toolCallId: 't1',
        toolName: 'read_file',
        args: { path: 'a' },
        result: 'contents',
        isError: undefined,
        durationMs: 42,
      },
    ]);
  });

  it.each(['browser_action', 'kai/browser_action', 'mcp__kai__browser_action'])(
    'never persists plaintext typed by %s',
    (toolName) => {
      const secret = 'vault-secret-123';
      feed({
        conversationId: 'browser-type-redaction',
        type: 'tool-call',
        toolCallId: 'browser-call-1',
        toolName,
        args: { kind: 'type', selector: '#password', value: secret },
      });
      feed({ conversationId: 'browser-type-redaction', type: 'done' });

      const [, , messages] = appendMock.mock.calls[0];
      const serialized = JSON.stringify(messages);
      expect(serialized).not.toContain(secret);
      expect(messages[0].content[0].args).toEqual({
        kind: 'type',
        selector: '[redacted browser selector: 9 characters]',
        value: `[redacted typed text: ${secret.length} characters]`,
      });
    },
  );

  it.each([
    [
      'browser_tabs',
      { action: 'open', url: 'https://alice:url-password@example.com/oauth?code=query-secret' },
      /url-password|oauth|query-secret/,
    ],
    [
      'browser_action',
      { kind: 'navigate', url: 'https://example.com/reset?token=navigation-secret' },
      /navigation-secret/,
    ],
    ['browser_action', { kind: 'press', keys: ['key-secret'] }, /key-secret/],
  ] as const)('never persists secret-bearing Browser arguments from %s', (toolName, args, secretPattern) => {
    feed({
      conversationId: 'browser-argument-redaction',
      type: 'tool-call',
      toolCallId: 'browser-call-1',
      toolName,
      args,
    });
    feed({ conversationId: 'browser-argument-redaction', type: 'done' });

    const [, , messages] = appendMock.mock.calls[0];
    expect(JSON.stringify(messages)).not.toMatch(secretPattern);
  });

  it('preserves compaction metadata on a compacted tool result', () => {
    feed({ conversationId: 'cc', type: 'tool-call', toolCallId: 't1', toolName: 'read_file', args: { path: 'big' } });
    feed({
      conversationId: 'cc',
      type: 'tool-result',
      toolCallId: 't1',
      result: 'SUMMARY',
      durationMs: 10,
      compaction: { originalContent: 'FULL ORIGINAL OUTPUT', wasCompacted: true, extractionDurationMs: 5 },
    });
    feed({ conversationId: 'cc', type: 'done' });

    const [, , msgs] = appendMock.mock.calls[0];
    const part = msgs[0].content[0];
    expect(part.result).toBe('SUMMARY');
    expect(part.originalResult).toBe('FULL ORIGINAL OUTPUT');
    expect(part.compactionMeta).toEqual({ wasCompacted: true, extractionDurationMs: 5 });
    expect(part.compactionPhase).toBe('complete');
  });

  it('flags tool errors with isError and preserves the error payload', () => {
    feed({ conversationId: 'c3', type: 'tool-call', toolCallId: 't1', toolName: 'run', args: {} });
    feed({ conversationId: 'c3', type: 'tool-error', toolCallId: 't1', error: 'boom' });
    feed({ conversationId: 'c3', type: 'done' });

    const [, , msgs] = appendMock.mock.calls[0];
    const part = msgs[0].content[0] as { isError?: boolean; result?: { isError?: boolean; error?: string } };
    expect(part.isError).toBe(true);
    expect(part.result).toEqual({ isError: true, error: 'boom' });
  });

  it('does not persist an empty turn', () => {
    feed({ conversationId: 'c4', type: 'done' });
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('discards a partial accumulation on cancel', () => {
    feed({ conversationId: 'c5', type: 'text-delta', text: 'partial' });
    discardPersistenceAccumulator('c5');
    feed({ conversationId: 'c5', type: 'done' });
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('keeps conversations independent', () => {
    feed({ conversationId: 'a', type: 'text-delta', text: 'A' });
    feed({ conversationId: 'b', type: 'text-delta', text: 'B' });
    feed({ conversationId: 'a', type: 'done' });
    feed({ conversationId: 'b', type: 'done' });
    expect(appendMock).toHaveBeenCalledTimes(2);
    expect(appendMock.mock.calls[0][1]).toBe('a');
    expect(appendMock.mock.calls[1][1]).toBe('b');
  });

  it('parents the persisted reply on the submit-time head, captured at first event', () => {
    // parentId is bound on the FIRST accumulation and is immune to a later
    // head change (rewind/edit/variant) — a subsequent event omitting it, or
    // passing a different one, must not move the reply off its answered turn.
    feedWithParent({ conversationId: 'p1', type: 'text-delta', text: 'hi' }, 'user-node-42');
    feedWithParent({ conversationId: 'p1', type: 'text-delta', text: '!' }, 'stale-head-99');
    feedWithParent({ conversationId: 'p1', type: 'done' }, 'stale-head-99');

    expect(appendMock).toHaveBeenCalledTimes(1);
    const [, , , options] = appendMock.mock.calls[0];
    expect(options).toEqual({ runStatus: 'idle', parentId: 'user-node-42' });
  });

  it('omits parentId (but still resets runStatus) when no submit-time head was captured', () => {
    feed({ conversationId: 'p2', type: 'text-delta', text: 'x' });
    feed({ conversationId: 'p2', type: 'done' });
    const [, , , options] = appendMock.mock.calls[0];
    expect(options).toEqual({ runStatus: 'idle' });
    expect(options.parentId).toBeUndefined();
  });

  it('appends an error note to the turn but only persists once, on the trailing done', () => {
    feed({ conversationId: 'e1', type: 'text-delta', text: 'partial' });
    feed({ conversationId: 'e1', type: 'error', error: 'boom' });
    // error does NOT persist (it may be mid-stream); the turn persists on done.
    expect(appendMock).not.toHaveBeenCalled();
    feed({ conversationId: 'e1', type: 'done' });
    expect(appendMock).toHaveBeenCalledTimes(1);
    const [, , msgs] = appendMock.mock.calls[0];
    const text = (msgs[0].content as Array<{ type: string; text?: string }>).find((p) => p.type === 'text')?.text;
    expect(text).toContain('partial');
    expect(text).toContain('**Error:** boom');
  });

  it('does not double-persist when a mid-stream error is followed by more content + done', () => {
    feed({ conversationId: 'e2', type: 'text-delta', text: 'a' });
    feed({ conversationId: 'e2', type: 'error', error: 'transient' });
    feed({ conversationId: 'e2', type: 'text-delta', text: 'b' }); // stream continued
    feed({ conversationId: 'e2', type: 'done' });
    expect(appendMock).toHaveBeenCalledTimes(1); // single persist, no premature write on error
    const [, , msgs] = appendMock.mock.calls[0];
    const text = (msgs[0].content as Array<{ type: string; text?: string }>).find((p) => p.type === 'text')?.text;
    expect(text).toContain('a');
    expect(text).toContain('b'); // content after the error is preserved
  });

  it('discardPersistenceAccumulator releases an accumulator with no trailing done (no leak)', () => {
    feed({ conversationId: 'e3', type: 'text-delta', text: 'orphan' });
    feed({ conversationId: 'e3', type: 'error', error: 'fatal, no done follows' });
    // Simulate the stream loop's finally cleanup on an abnormal (done-less) end.
    discardPersistenceAccumulator('e3');
    // A late/duplicate done now finds nothing → no persist (accumulator was released).
    feed({ conversationId: 'e3', type: 'done' });
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('model-fallback with preserveErroredVariant commits the partial as a sibling and re-seeds under the same parent', () => {
    // Attempt 1 streams partial content, then a transient mid-stream fallback.
    feedWithParent(
      {
        conversationId: 'v1',
        type: 'text-delta',
        text: 'partial from model A',
        responseMessageId: 'msg-failed-variant',
      },
      'user-node',
    );
    feedWithParent(
      {
        conversationId: 'v1',
        type: 'model-fallback',
        error: 'internal server error',
        responseMessageId: 'msg-failed-variant',
        data: { preserveErroredVariant: true, error: 'internal server error' },
      },
      'user-node',
    );
    // The errored partial was committed as its own sibling right away.
    expect(appendMock).toHaveBeenCalledTimes(1);
    const [, , firstMsgs, firstOpts] = appendMock.mock.calls[0];
    expect(firstMsgs[0].id).toBe('msg-failed-variant');
    const firstText = (firstMsgs[0].content as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(firstText).toContain('partial from model A');
    expect(firstText).toContain('internal server error'); // error annotation preserved
    expect(firstOpts.parentId).toBe('user-node');
    // The retry is still in flight — the intermediate variant must stay 'running'
    // so a concurrent automation can't fork the branch mid-fallback.
    expect(firstOpts.runStatus).toBe('running');

    // Attempt 2 (retry on model B) streams the successful reply + done.
    feedWithParent(
      {
        conversationId: 'v1',
        type: 'text-delta',
        text: 'full reply from model B',
        responseMessageId: 'msg-success-variant',
      },
      'user-node',
    );
    feedWithParent({ conversationId: 'v1', type: 'done', responseMessageId: 'msg-success-variant' }, 'user-node');

    expect(appendMock).toHaveBeenCalledTimes(2);
    const [, , secondMsgs, secondOpts] = appendMock.mock.calls[1];
    expect(secondMsgs[0].id).toBe('msg-success-variant');
    const secondText = (secondMsgs[0].content as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(secondText).toContain('full reply from model B');
    expect(secondText).not.toContain('partial from model A'); // fresh accumulator
    // Both variants are siblings under the SAME parent.
    expect(secondOpts.parentId).toBe('user-node');
    // The successful final turn resets to idle (retry finished).
    expect(secondOpts.runStatus).toBe('idle');
  });

  it('model-fallback with discardPartialAssistant drops the partial (no sibling persisted)', () => {
    feedWithParent({ conversationId: 'v2', type: 'text-delta', text: 'to be discarded' }, 'user-node');
    feedWithParent(
      { conversationId: 'v2', type: 'model-fallback', data: { discardPartialAssistant: true } },
      'user-node',
    );
    // Nothing persisted yet (partial dropped, not committed as a sibling).
    expect(appendMock).not.toHaveBeenCalled();
    feedWithParent({ conversationId: 'v2', type: 'text-delta', text: 'clean retry' }, 'user-node');
    feedWithParent({ conversationId: 'v2', type: 'done' }, 'user-node');
    expect(appendMock).toHaveBeenCalledTimes(1);
    const [, , msgs] = appendMock.mock.calls[0];
    const text = (msgs[0].content as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(text).toBe('clean retry');
  });
});

describe('finalizeInterruptedTurn (mid-turn follow-up injection)', () => {
  beforeEach(() => appendMock.mockReset());

  it('persists the in-progress partial (text + tools) and returns the new head id', () => {
    feedWithParent({ conversationId: 'i1', type: 'text-delta', text: 'thinking…' }, 'user-1');
    feed({ conversationId: 'i1', type: 'tool-call', toolCallId: 't1', toolName: 'read_file', args: { path: 'a' } });
    feed({ conversationId: 'i1', type: 'tool-result', toolCallId: 't1', result: 'contents' });

    const head = finalizeInterruptedTurn(APP_HOME, 'i1');

    expect(head).toBe('persisted-head');
    expect(appendMock).toHaveBeenCalledTimes(1);
    const [, id, msgs, options] = appendMock.mock.calls[0];
    expect(id).toBe('i1');
    // Both the partial text AND the tool call are preserved (not discarded).
    expect(msgs[0].content).toEqual([
      { type: 'text', source: 'assistant', text: 'thinking…' },
      {
        type: 'tool-call',
        toolCallId: 't1',
        toolName: 'read_file',
        args: { path: 'a' },
        result: 'contents',
        isError: undefined,
        durationMs: undefined,
      },
    ]);
    // Parented on the submit-time head, runStatus reset.
    expect(options).toEqual({ runStatus: 'idle', parentId: 'user-1' });
  });

  it('clears the accumulator so a later done cannot double-persist', () => {
    feed({ conversationId: 'i2', type: 'text-delta', text: 'partial' });
    finalizeInterruptedTurn(APP_HOME, 'i2');
    expect(appendMock).toHaveBeenCalledTimes(1);
    // The superseded run's trailing done (or the fresh run's discard) finds nothing.
    feed({ conversationId: 'i2', type: 'done' });
    expect(appendMock).toHaveBeenCalledTimes(1);
  });

  it('returns null and persists nothing when there is no accumulated content', () => {
    const head = finalizeInterruptedTurn(APP_HOME, 'i3-never-started');
    expect(head).toBeNull();
    expect(appendMock).not.toHaveBeenCalled();
  });
});

describe('persistCooperativeInjectedUserTurn (CLI/server-persisted cooperative inject)', () => {
  beforeEach(() => {
    appendMock.mockReset();
    readMock.mockReset();
    readMock.mockReturnValue({ headId: 'original-user' });
  });

  it('persists partial assistant first, then parents injected user on that partial', () => {
    // A CLI-owned turn is accumulating under the original user prompt.
    feedWithParent({ conversationId: 'ci1', type: 'text-delta', text: 'partial work' }, 'original-user');

    appendMock
      // finalizeInterruptedTurn writes the partial assistant and returns its id.
      .mockReturnValueOnce({ headId: 'partial-assistant' })
      // injected-user append succeeded (the helper supplies its own stable id).
      .mockReturnValueOnce({ headId: 'stored-injected-head' });

    const result = persistCooperativeInjectedUserTurn(APP_HOME, 'ci1', 'my follow up', 'inj-stable');

    expect(result?.messageId).toBe('inj-stable');
    expect(result?.parentId).toBe('partial-assistant');
    expect(typeof result?.createdAt).toBe('string');
    expect(appendMock).toHaveBeenCalledTimes(2);

    const [, , partialMsgs, partialOpts] = appendMock.mock.calls[0];
    expect(partialMsgs).toEqual([
      { role: 'assistant', content: [{ type: 'text', source: 'assistant', text: 'partial work' }] },
    ]);
    expect(partialOpts).toEqual({ runStatus: 'idle', parentId: 'original-user' });

    const [, , injectedMsgs, injectedOpts] = appendMock.mock.calls[1];
    expect(injectedMsgs).toHaveLength(1);
    expect(injectedMsgs[0]).toMatchObject({
      id: result?.messageId,
      role: 'user',
      content: [{ type: 'text', text: 'my follow up' }],
      createdAt: result?.createdAt,
    });
    expect(injectedOpts).toEqual({ runStatus: 'running', parentId: 'partial-assistant' });

    // The running turn continues after prepareStep consumed the inject. A fresh
    // accumulator is seeded with the injected USER as its parent, so final done
    // appends the continuation assistant after the user — not as a sibling.
    feedWithParent({ conversationId: 'ci1', type: 'text-delta', text: 'addressed follow up' }, result!.messageId);
    feedWithParent({ conversationId: 'ci1', type: 'done' }, result!.messageId);
    expect(appendMock).toHaveBeenCalledTimes(3);
    const [, , continuationMsgs, continuationOpts] = appendMock.mock.calls[2];
    expect(continuationMsgs).toEqual([
      { role: 'assistant', content: [{ type: 'text', source: 'assistant', text: 'addressed follow up' }] },
    ]);
    expect(continuationOpts).toEqual({ runStatus: 'idle', parentId: result!.messageId });
  });

  it('uses the current store head when no partial assistant was accumulated', () => {
    appendMock.mockReturnValueOnce({ headId: 'stored-injected-head' });

    const result = persistCooperativeInjectedUserTurn(APP_HOME, 'ci2', 'late follow up');

    expect(result?.messageId).toMatch(/^inject-msg-/);
    expect(result?.parentId).toBe('original-user');
    expect(appendMock).toHaveBeenCalledTimes(1);
    const [, , , options] = appendMock.mock.calls[0];
    expect(options).toEqual({ runStatus: 'running' });
  });

  it('pins an empty-prefix inject to noPrefixParentId (superseded branch point), not the live head', () => {
    // A newer prompt has already advanced the disk head. The superseded run had no
    // accumulated assistant content, so there is no partial to finalize. The inject
    // must pin on the superseded run's OWN branch point (`orig-user`) — where it
    // chronologically belongs — NOT the store's current head (the newer prompt).
    readMock.mockReturnValue({
      headId: 'newer-prompt',
      messageTree: [
        { id: 'orig-user', parentId: null, role: 'user' },
        { id: 'newer-prompt', parentId: 'orig-user', role: 'user' },
      ],
    });
    appendMock.mockReturnValueOnce({ headId: 'stored-injected-head' });

    const result = persistCooperativeInjectedUserTurn(APP_HOME, 'ci3', 'raced answer', 'inj-e', {
      noPrefixParentId: 'orig-user',
    });

    expect(result?.messageId).toBe('inj-e');
    expect(result?.parentId).toBe('orig-user');
    const [, , , options] = appendMock.mock.calls[0];
    // Explicit parent pinned — NOT an omitted parentId (which would fall to the live head).
    expect(options).toEqual({ runStatus: 'running', parentId: 'orig-user' });
  });

  it('falls back to the store head when noPrefixParentId names a node absent from disk', () => {
    // A stale branch point that no longer exists on disk must NOT be pinned (would
    // create a detached inject); fall back to the store's current head.
    readMock.mockReturnValue({
      headId: 'live-head',
      messageTree: [{ id: 'live-head', parentId: null, role: 'user' }],
    });
    appendMock.mockReturnValueOnce({ headId: 'stored-injected-head' });

    const result = persistCooperativeInjectedUserTurn(APP_HOME, 'ci4', 'answer', 'inj-f', {
      noPrefixParentId: 'gone-node',
    });

    expect(result?.parentId).toBe('live-head');
    const [, , , options] = appendMock.mock.calls[0];
    expect(options).toEqual({ runStatus: 'running' }); // parentId omitted → append uses store head
  });
});
