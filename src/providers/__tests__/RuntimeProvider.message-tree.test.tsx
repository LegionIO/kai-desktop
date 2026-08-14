// @vitest-environment jsdom
/**
 * Tests for the pure message-tree helpers exported from RuntimeProvider
 * (getActiveBranch, ensureTree). Focus: robustness against corrupt/malicious
 * messageTree data (from disk or the authenticated web bridge) — a parentId
 * cycle must not hang the renderer, and a dangling headId must not silently
 * drop history.
 */
import { describe, it, expect, vi } from 'vitest';

// RuntimeProvider reads window.app / the ipc-client proxy at module load; stub
// it so importing the pure helpers doesn't blow up.
vi.mock('@/lib/ipc-client', () => ({
  app: new Proxy({}, { get: () => () => undefined }),
}));

import {
  getActiveBranch,
  ensureTree,
  deepestLatestDescendant,
  isDuplicateLastUserMessage,
  locateToolCallInBranch,
  preserveErroredAssistantVariant,
  getOrCreateAssistantInAcc,
  resolveLiveInjectedParentId,
  reconnectActiveBranchRoot,
} from '../RuntimeProvider';

type Node = { id: string; parentId: string | null; role: 'user' | 'assistant' };

function n(id: string, parentId: string | null, role: 'user' | 'assistant' = 'user'): Node {
  return { id, parentId, role };
}

describe('resolveLiveInjectedParentId', () => {
  it('uses the authoritative persisted parent when that node is already live', () => {
    const messages = [n('user-1', null), n('assistant-persisted', 'user-1', 'assistant')];
    expect(resolveLiveInjectedParentId(messages as never[], 'assistant-live', 'assistant-persisted')).toBe(
      'assistant-persisted',
    );
  });

  it('falls back to the live head when the persisted parent is not in the accumulator', () => {
    const messages = [n('user-1', null), n('assistant-live', 'user-1', 'assistant')];
    expect(resolveLiveInjectedParentId(messages as never[], 'assistant-live', 'assistant-persisted')).toBe(
      'assistant-live',
    );
    // This keeps the full branch connected rather than producing only the new
    // injected user node under a dangling persisted-parent id.
  });

  it('always keeps the live head for renderer-owned streams, even when the stale persisted parent exists', () => {
    const messages = [
      n('user-1', null),
      n('assistant-old-disk-head', 'user-1', 'assistant'),
      n('assistant-live', 'assistant-old-disk-head', 'assistant'),
    ];
    expect(resolveLiveInjectedParentId(messages as never[], 'assistant-live', 'assistant-old-disk-head', false)).toBe(
      'assistant-live',
    );
  });

  it('preserves an explicit null persisted parent for main-owned streams', () => {
    expect(resolveLiveInjectedParentId([], 'assistant-live', null, true)).toBeNull();
  });

  it('recovers the live branch tip when BOTH the persisted parent and the live head are dangling (mid-burst)', () => {
    // Reproduces the Matthew-automation back-to-back injection burst: a prior
    // injected node set acc.headId to a mastra `msg-*` id that this accumulator
    // never materialized, so the fallback head is itself dangling. Naively
    // returning it would leave getActiveBranch truncating at the dangling edge.
    const messages = [
      n('user-1', null),
      n('assistant-1', 'user-1', 'assistant'),
      n('inj-1', 'assistant-1'),
      n('assistant-2', 'inj-1', 'assistant'),
    ];
    // head = a mastra id absent from the accumulator; candidate parent likewise absent.
    const result = resolveLiveInjectedParentId(
      messages as never[],
      'msg-1786461563064-ee54ec41',
      'msg-1786461407021-4e1409a2',
    );
    // Should parent onto the newest node that actually reaches a root, keeping
    // the full chain visible mid-stream.
    expect(result).toBe('assistant-2');
  });

  it('recovers the live branch tip for renderer-owned streams when the head is dangling', () => {
    const messages = [n('user-1', null), n('assistant-live', 'user-1', 'assistant')];
    expect(resolveLiveInjectedParentId(messages as never[], 'msg-dangling', 'ignored', false)).toBe('assistant-live');
  });

  it('skips a node whose ancestry passes through a dangling edge when choosing the tip', () => {
    // A detached subtree (its root parents on a missing id) must NOT be chosen
    // as the recovery tip — only a node that cleanly reaches a real root.
    const messages = [
      n('user-1', null),
      n('assistant-1', 'user-1', 'assistant'),
      n('detached-root', 'gone-missing'), // dangling ancestor
      n('detached-child', 'detached-root', 'assistant'),
    ];
    const result = resolveLiveInjectedParentId(messages as never[], 'msg-dangling', 'msg-also-dangling');
    expect(result).toBe('assistant-1');
  });

  it('falls back to the raw head when NO node reaches a root (fully detached accumulator)', () => {
    const messages = [n('orphan', 'missing-parent', 'assistant')];
    expect(resolveLiveInjectedParentId(messages as never[], 'msg-dangling', 'msg-also-dangling')).toBe('msg-dangling');
  });

  it('does not hang on a parentId cycle while searching for the branch tip', () => {
    // Cycle a↔b plus one clean chain; the clean tip must win and the cycle must
    // not loop forever.
    const messages = [
      n('user-1', null),
      n('assistant-1', 'user-1', 'assistant'),
      n('cyc-a', 'cyc-b'),
      n('cyc-b', 'cyc-a'),
    ];
    const result = resolveLiveInjectedParentId(messages as never[], 'msg-dangling', 'msg-also-dangling');
    expect(result).toBe('assistant-1');
  });
});

// getActiveBranch/ensureTree operate structurally on {id,parentId,role}; cast
// the minimal shape to the StoredMessage[] the functions expect.
const asTree = (nodes: Node[]) => nodes as unknown as Parameters<typeof getActiveBranch>[0];

describe('reconnectActiveBranchRoot — mid-turn-inject orphan-root fix', () => {
  // signature: (messages, activeHeadId, fallbackHeadId)
  const call = (nodes: Node[], activeHead: string | null, fallback: string | null) =>
    reconnectActiveBranchRoot(nodes as never[], activeHead, fallback) as unknown as Node[];

  it('reconnects the Matthew shape: active head is the injected user on a detached orphan reply', () => {
    // Disk history headed at "story"; the renderer partial "orphanReply" persisted
    // with parentId:null, and the mid-turn inject parented on it is the active head.
    const nodes = [
      n('root', null, 'user'),
      n('a1', 'root', 'assistant'),
      n('story', 'a1', 'user'), // fallback head (real disk tip)
      n('orphanReply', null, 'assistant'), // detached base of the active branch
      n('inject', 'orphanReply', 'user'), // active head
    ];
    const out = call(nodes, 'inject', 'story');
    expect(out.find((m) => m.id === 'orphanReply')!.parentId).toBe('story');
    // Also stamps a durable reconnectTo hint for the main-side chokepoint.
    expect((out.find((m) => m.id === 'orphanReply') as { reconnectTo?: string }).reconnectTo).toBe('story');
    expect(out.filter((m) => m.parentId === null).map((m) => m.id)).toEqual(['root']);
    expect(getActiveBranch(asTree(out), 'inject').map((m) => m.id)).toEqual([
      'root',
      'a1',
      'story',
      'orphanReply',
      'inject',
    ]);
  });

  it('reconnects when the orphan itself is the active head', () => {
    const nodes = [n('root', null, 'user'), n('story', 'root', 'user'), n('orphanReply', null, 'assistant')];
    const out = call(nodes, 'orphanReply', 'story');
    expect(out.find((m) => m.id === 'orphanReply')!.parentId).toBe('story');
  });

  it('reconnects a disk-only fallback head not yet present locally (prefix unmerged)', () => {
    const nodes = [n('orphanReply', null, 'assistant')];
    const out = call(nodes, 'orphanReply', 'disk-head');
    expect(out.find((m) => m.id === 'orphanReply')!.parentId).toBe('disk-head');
  });

  it('LEAVES a legitimate inactive edit-root alone (not an ancestor of the active head)', () => {
    // A prior first-message edit created a second null root ("orig-user"). The active
    // branch is the edited branch. The inactive edit-root must NOT be reparented.
    const nodes = [
      n('orig-user', null, 'user'), // inactive edit sibling root
      n('orig-reply', 'orig-user', 'assistant'),
      n('edited-user', null, 'user'), // active branch base (legit)
      n('edited-reply', 'edited-user', 'assistant'),
    ];
    // Active head is on the edited branch; fallback is the old branch tip. Because the
    // active branch's base (edited-user) is a legit root the user is on and fallback is
    // NOT reachable from it, we DO reconnect the active base — wait: that's wrong for a
    // deliberate edit. Guard: persist only calls this for background-seeded automation
    // accumulators, which never contain a user edit. Here we assert the OTHER root
    // (orig-user, inactive) is untouched regardless.
    const out = call(nodes, 'edited-reply', 'orig-reply');
    expect(out.find((m) => m.id === 'orig-user')!.parentId).toBeNull(); // inactive root untouched
  });

  it('is a no-op when the active branch already reaches the fallback head (connected)', () => {
    const nodes = [n('root', null, 'user'), n('a1', 'root', 'assistant'), n('u2', 'a1', 'user')];
    const out = reconnectActiveBranchRoot(nodes as never[], 'u2', 'a1');
    expect(out).toBe(nodes as never[]); // fallback is on the active chain → connected → no-op
  });

  it('never creates a cycle when the fallback head is a descendant of the active base', () => {
    const nodes = [n('root', null, 'user'), n('a1', 'root', 'assistant')];
    // fallback 'a1' descends from active base 'root' — reparenting root→a1 would cycle.
    const out = call(nodes, 'root', 'a1');
    expect(out.find((m) => m.id === 'root')!.parentId).toBeNull();
    expect(out).toBe(nodes as never[]);
  });

  it('is a no-op without a fallback head, without an active head, or when they are equal', () => {
    const nodes = [n('only', null, 'assistant')];
    expect(reconnectActiveBranchRoot(nodes as never[], 'only', null)).toBe(nodes as never[]);
    expect(reconnectActiveBranchRoot(nodes as never[], null, 'x')).toBe(nodes as never[]);
    expect(reconnectActiveBranchRoot(nodes as never[], 'only', 'only')).toBe(nodes as never[]);
  });

  it('reconnects the active base even when it has descendants (multi-node detached branch)', () => {
    // base 'root' is a detached null-root with a child chain; the active head is deep
    // in it. The whole branch reconnects by moving its base onto the fallback head.
    const nodes = [n('root', null, 'user'), n('mid', 'root', 'user'), n('head', 'mid', 'assistant')];
    const out = call(nodes, 'head', 'disk-head');
    expect(out.find((m) => m.id === 'root')!.parentId).toBe('disk-head');
    expect(out.find((m) => m.id === 'mid')!.parentId).toBe('root'); // untouched
  });

  it('is idempotent', () => {
    const nodes = [n('root', null, 'user'), n('story', 'root', 'user'), n('orphanReply', null, 'assistant')];
    const once = call(nodes, 'orphanReply', 'story');
    const twice = call(once, 'orphanReply', 'story');
    expect(twice.find((m) => m.id === 'orphanReply')!.parentId).toBe('story');
    expect(twice).toBe(once as never[]);
  });
});

describe('getActiveBranch', () => {
  it('walks parentId links from head to root in order', () => {
    const tree = asTree([n('a', null), n('b', 'a'), n('c', 'b')]);
    expect(getActiveBranch(tree, 'c').map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns [] for a null head or empty tree', () => {
    expect(getActiveBranch(asTree([n('a', null)]), null)).toEqual([]);
    expect(getActiveBranch(asTree([]), 'a')).toEqual([]);
  });

  it('stops at an orphan parentId (node pointing to a missing id)', () => {
    const tree = asTree([n('b', 'missing'), n('c', 'b')]);
    expect(getActiveBranch(tree, 'c').map((m) => m.id)).toEqual(['b', 'c']);
  });

  it('does NOT infinite-loop on a parentId cycle (corrupt tree)', () => {
    // a → b → a cycle. Without the visited guard this hangs the renderer.
    const tree = asTree([n('a', 'b'), n('b', 'a')]);
    const branch = getActiveBranch(tree, 'a');
    // Terminates and returns each cyclic node at most once.
    expect(branch.length).toBeLessThanOrEqual(2);
    expect(new Set(branch.map((m) => m.id)).size).toBe(branch.length);
  });

  it('does NOT infinite-loop on a self-referential node', () => {
    const tree = asTree([n('a', 'a')]);
    const branch = getActiveBranch(tree, 'a');
    expect(branch.map((m) => m.id)).toEqual(['a']);
  });
});

describe('shared Kai/Mastra assistant ids', () => {
  it('uses the preallocated response id for a new assistant message', () => {
    const acc = {
      messages: [
        {
          id: 'user-1',
          parentId: null,
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
          createdAt: new Date(),
        },
      ],
      headId: 'user-1',
      pendingAssistantId: 'msg-shared-1',
    } as unknown as Parameters<typeof getOrCreateAssistantInAcc>[0];

    const { msg } = getOrCreateAssistantInAcc(acc);

    expect(msg.id).toBe('msg-shared-1');
    expect(msg.parentId).toBe('user-1');
  });

  it('creates a fresh child when a continuation response has a different shared id', () => {
    const acc = {
      messages: [
        {
          id: 'assistant-old',
          parentId: 'user-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'partial' }],
          createdAt: new Date(),
        },
      ],
      headId: 'assistant-old',
      pendingAssistantId: 'assistant-continuation',
    } as unknown as Parameters<typeof getOrCreateAssistantInAcc>[0];

    const { msg } = getOrCreateAssistantInAcc(acc);

    expect(msg.id).toBe('assistant-continuation');
    expect(msg.parentId).toBe('assistant-old');
  });

  it('rotates to a FRESH node id when the pendingAssistantId is a cooperative-inject-closed prefix', () => {
    // After a mid-turn inject, the reply-so-far (msg-shared) is a CLOSED prefix
    // (finalizedInjectResponseIds). The continuation arrives under the SAME
    // responseMessageId (pendingAssistantId), but must NOT reuse the prefix node
    // id — it gets a fresh node, parented on the injected user (the live head).
    const acc = {
      messages: [
        { id: 'user-1', parentId: null, role: 'user', content: [{ type: 'text', text: 'q' }], createdAt: new Date() },
        { id: 'msg-shared', parentId: 'user-1', role: 'assistant', content: [{ type: 'text', text: 'prefix' }], createdAt: new Date() },
        { id: 'user-inject', parentId: 'msg-shared', role: 'user', content: [{ type: 'text', text: 'answer' }], createdAt: new Date() },
      ],
      headId: 'user-inject',
      pendingAssistantId: 'msg-shared',
      finalizedInjectResponseIds: new Set(['msg-shared']),
    } as unknown as Parameters<typeof getOrCreateAssistantInAcc>[0];

    const first = getOrCreateAssistantInAcc(acc);
    expect(first.msg.id).not.toBe('msg-shared'); // rotated to a fresh id
    expect(first.msg.parentId).toBe('user-inject'); // parented on the injected user

    // A second delta of the SAME reused id appends to the SAME rotated node.
    const second = getOrCreateAssistantInAcc(acc);
    expect(second.msg.id).toBe(first.msg.id);
  });

  it('creates the fallback retry as a sibling with its newly echoed id', () => {
    const acc = {
      messages: [
        {
          id: 'user-1',
          parentId: null,
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
          createdAt: new Date(),
        },
        {
          id: 'failed-response',
          parentId: 'user-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'partial' }],
          createdAt: new Date(),
        },
      ],
      headId: 'failed-response',
      pendingAssistantId: 'failed-response',
    } as unknown as Parameters<typeof getOrCreateAssistantInAcc>[0];

    expect(preserveErroredAssistantVariant(acc, 'provider failed')).toBe(true);
    acc.pendingAssistantId = 'successful-response';
    const { msg } = getOrCreateAssistantInAcc(acc);

    expect(msg.id).toBe('successful-response');
    expect(msg.parentId).toBe('user-1');
    expect(acc.messages.filter((message: { parentId: string | null }) => message.parentId === 'user-1')).toHaveLength(
      2,
    );
  });
});

describe('ensureTree', () => {
  it('preserves a valid headId present in the tree', () => {
    const conv = {
      messageTree: [n('a', null), n('b', 'a')],
      headId: 'a',
    } as unknown as Parameters<typeof ensureTree>[0];
    const { tree, headId } = ensureTree(conv);
    expect(headId).toBe('a');
    expect(tree.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('falls back to the last node when headId is DANGLING (not in the tree)', () => {
    // Repro of the data-loss footgun: a dangling head made getActiveBranch
    // return [], rendering empty and then persisting messages:[] back.
    const conv = {
      messageTree: [n('a', null), n('b', 'a')],
      headId: 'does-not-exist',
    } as unknown as Parameters<typeof ensureTree>[0];
    const { headId } = ensureTree(conv);
    expect(headId).toBe('b');
    // And the recovered head yields the full branch, not [].
    const { tree } = ensureTree(conv);
    expect(getActiveBranch(tree, headId).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('falls back to the last node when headId is null', () => {
    const conv = {
      messageTree: [n('a', null), n('b', 'a')],
      headId: null,
    } as unknown as Parameters<typeof ensureTree>[0];
    expect(ensureTree(conv).headId).toBe('b');
  });

  it('migrates flat messages to a linear tree when no messageTree exists', () => {
    const conv = {
      messages: [
        { id: 'x', role: 'user' },
        { id: 'y', role: 'assistant' },
      ],
    } as unknown as Parameters<typeof ensureTree>[0];
    const { tree, headId } = ensureTree(conv);
    expect(headId).toBe('y');
    expect(tree[0].parentId).toBeNull();
    expect(tree[1].parentId).toBe('x');
  });
});

describe('deepestLatestDescendant', () => {
  const asTreeD = (nodes: Node[]) => nodes as unknown as Parameters<typeof deepestLatestDescendant>[0];

  it('walks to the deepest last-child leaf', () => {
    // a → b → c (linear); starting at a returns c.
    expect(deepestLatestDescendant(asTreeD([n('a', null), n('b', 'a'), n('c', 'b')]), 'a')).toBe('c');
  });

  it('takes the LAST child at each level (most recent variant)', () => {
    // a has children b1, b2; b2 is the last → descends into b2.
    const tree = asTreeD([n('a', null), n('b1', 'a'), n('b2', 'a'), n('c', 'b2')]);
    expect(deepestLatestDescendant(tree, 'a')).toBe('c');
  });

  it('returns the start id when it has no children (leaf)', () => {
    expect(deepestLatestDescendant(asTreeD([n('a', null)]), 'a')).toBe('a');
  });

  it('does NOT infinite-loop on a parentId cycle (corrupt tree)', () => {
    // a↔b cycle in the child direction: childrenOf oscillates without the guard.
    const leaf = deepestLatestDescendant(asTreeD([n('a', 'b'), n('b', 'a')]), 'a');
    expect(['a', 'b']).toContain(leaf);
  });

  it('does NOT infinite-loop on a self-referential node', () => {
    expect(deepestLatestDescendant(asTreeD([n('a', 'a')]), 'a')).toBe('a');
  });
});

describe('isDuplicateLastUserMessage — peer user-message dedup (#222)', () => {
  type Msg = { role: string; content: unknown };
  const asBranch = (msgs: Msg[]) => msgs as unknown as Parameters<typeof isDuplicateLastUserMessage>[0];
  const userMsg = (text: string): Msg => ({ role: 'user', content: [{ type: 'text', text }] });
  const assistantMsg = (text: string): Msg => ({ role: 'assistant', content: [{ type: 'text', text }] });

  it('is a duplicate when the last turn is a user message with matching text (our own echo)', () => {
    expect(isDuplicateLastUserMessage(asBranch([userMsg('hello')]), 'hello')).toBe(true);
    expect(isDuplicateLastUserMessage(asBranch([assistantMsg('hi'), userMsg('again')]), 'again')).toBe(true);
  });

  it('is NOT a duplicate when the text differs (a peer submitted a different prompt)', () => {
    expect(isDuplicateLastUserMessage(asBranch([userMsg('hello')]), 'world')).toBe(false);
  });

  it('is NOT a duplicate when the last turn is an assistant message (peer turn on a settled convo)', () => {
    expect(isDuplicateLastUserMessage(asBranch([userMsg('q'), assistantMsg('a')]), 'q')).toBe(false);
  });

  it('is NOT a duplicate on an empty branch (first turn from a peer)', () => {
    expect(isDuplicateLastUserMessage(asBranch([]), 'hello')).toBe(false);
  });

  it('handles a user message with no text part (non-text content) as non-duplicate', () => {
    const imgOnly: Msg = { role: 'user', content: [{ type: 'image', image: 'x' }] };
    expect(isDuplicateLastUserMessage(asBranch([imgOnly]), 'hello')).toBe(false);
  });

  // #234: a text+image user message is broadcast back flattened as "text [Image]"
  // (the backend replaces image parts with the [Image] placeholder). The dedup
  // must flatten the local message the SAME way, or the echo doubles the turn.
  it('dedups a text+image message against its flattened "text [Image]" broadcast (#234)', () => {
    const withImage: Msg = {
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image', image: 'data:image/png;base64,AAAA' },
      ],
    };
    // The backend broadcasts the flattened form → must be recognized as our own echo.
    expect(isDuplicateLastUserMessage(asBranch([withImage]), 'What is this? [Image]')).toBe(true);
    // Bare-text fallback still works (older/simple broadcasts).
    expect(isDuplicateLastUserMessage(asBranch([withImage]), 'What is this?')).toBe(true);
  });

  it('dedups an image-only message against the "[Image]" broadcast', () => {
    const imgOnly: Msg = { role: 'user', content: [{ type: 'image', image: 'x' }] };
    expect(isDuplicateLastUserMessage(asBranch([imgOnly]), '[Image]')).toBe(true);
  });

  it('dedups a text+file message against its flattened "text [File: name]" broadcast', () => {
    const withFile: Msg = {
      role: 'user',
      content: [
        { type: 'text', text: 'check this' },
        { type: 'file', filename: 'notes.txt' },
      ],
    };
    expect(isDuplicateLastUserMessage(asBranch([withFile]), 'check this [File: notes.txt]')).toBe(true);
  });

  it('is NOT a duplicate when a peer sends different text even if ours had an image', () => {
    const withImage: Msg = {
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image', image: 'x' },
      ],
    };
    expect(isDuplicateLastUserMessage(asBranch([withImage]), 'something else [Image]')).toBe(false);
  });
});

describe('locateToolCallInBranch — cross-message tool-call lookup (mid-turn splice)', () => {
  // Messages carrying tool-call content parts. Structural cast like the others.
  type ToolMsg = {
    id: string;
    parentId: string | null;
    role: 'user' | 'assistant';
    content: unknown;
  };
  const asMsgs = (nodes: ToolMsg[]) => nodes as unknown as Parameters<typeof locateToolCallInBranch>[0];

  it('finds a tool-call in an EARLIER assistant message across a spliced user turn', () => {
    const msgs = asMsgs([
      {
        id: 'a1',
        parentId: null,
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'github' }],
      },
      { id: 'u2', parentId: 'a1', role: 'user', content: [{ type: 'text', text: 'mid-turn note' }] },
      { id: 'a2', parentId: 'u2', role: 'assistant', content: [{ type: 'text', text: 'continuing' }] },
    ]);
    // Head is the NEW assistant after the splice — t1 lives back in a1.
    expect(locateToolCallInBranch(msgs, 'a2', 't1')).toEqual({ msgIdx: 0, partIdx: 0 });
  });

  it('returns the part index within a multi-part message', () => {
    const msgs = asMsgs([
      {
        id: 'a1',
        parentId: null,
        role: 'assistant',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool-call', toolCallId: 't1', toolName: 'x' },
          { type: 'tool-call', toolCallId: 't2', toolName: 'y' },
        ],
      },
      { id: 'u2', parentId: 'a1', role: 'user', content: [{ type: 'text', text: 'note' }] },
    ]);
    expect(locateToolCallInBranch(msgs, 'u2', 't2')).toEqual({ msgIdx: 0, partIdx: 2 });
  });

  it('returns null when the id is absent or empty', () => {
    const msgs = asMsgs([
      {
        id: 'a1',
        parentId: null,
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'x' }],
      },
    ]);
    expect(locateToolCallInBranch(msgs, 'a1', 'nope')).toBeNull();
    expect(locateToolCallInBranch(msgs, 'a1', '')).toBeNull();
  });

  it('prefers the NEWEST message when the same id appears twice on the branch', () => {
    const msgs = asMsgs([
      {
        id: 'a1',
        parentId: null,
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'x' }],
      },
      {
        id: 'a2',
        parentId: 'a1',
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'x' }],
      },
    ]);
    expect(locateToolCallInBranch(msgs, 'a2', 't1')).toEqual({ msgIdx: 1, partIdx: 0 });
  });

  it('ignores messages off the active branch', () => {
    // b1 is a sibling branch not reachable from head a2.
    const msgs = asMsgs([
      { id: 'a1', parentId: null, role: 'assistant', content: [{ type: 'text', text: 'root' }] },
      {
        id: 'b1',
        parentId: 'a1',
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'tX', toolName: 'x' }],
      },
      { id: 'a2', parentId: 'a1', role: 'assistant', content: [{ type: 'text', text: 'other branch' }] },
    ]);
    expect(locateToolCallInBranch(msgs, 'a2', 'tX')).toBeNull();
  });
});

describe('preserveErroredAssistantVariant — mid-stream fallback keeps the partial as a sibling', () => {
  type Msg = { id: string; parentId: string | null; role: 'user' | 'assistant'; content: unknown };
  const acc = (messages: Msg[], headId: string | null) =>
    ({ messages, headId }) as unknown as Parameters<typeof preserveErroredAssistantVariant>[0];

  it('annotates the trailing assistant with the error and rewinds head to its parent', () => {
    const messages: Msg[] = [
      { id: 'u1', parentId: null, role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', parentId: 'u1', role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
    ];
    const a = acc(messages, 'a1');
    const sealed = preserveErroredAssistantVariant(a, 'internal server error');
    expect(sealed).toBe(true);
    // Head rewound to the errored variant's parent → retry becomes a sibling of a1.
    expect(a.headId).toBe('u1');
    // The errored assistant still exists, now carrying the error annotation.
    const errored = a.messages.find((m) => (m as Msg).id === 'a1') as Msg | undefined;
    const text = (errored?.content as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('');
    expect(text).toContain('partial');
    expect(text).toContain('internal server error');
  });

  it('returns false when there is no trailing assistant to seal', () => {
    const messages: Msg[] = [{ id: 'u1', parentId: null, role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    const a = acc(messages, 'u1');
    expect(preserveErroredAssistantVariant(a, 'err')).toBe(false);
    expect(a.headId).toBe('u1'); // unchanged
  });
});
