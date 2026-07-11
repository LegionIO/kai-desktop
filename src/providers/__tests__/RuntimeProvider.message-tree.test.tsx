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

import { getActiveBranch, ensureTree } from '../RuntimeProvider';

type Node = { id: string; parentId: string | null; role: 'user' | 'assistant' };

function n(id: string, parentId: string | null, role: 'user' | 'assistant' = 'user'): Node {
  return { id, parentId, role };
}

// getActiveBranch/ensureTree operate structurally on {id,parentId,role}; cast
// the minimal shape to the StoredMessage[] the functions expect.
const asTree = (nodes: Node[]) => nodes as unknown as Parameters<typeof getActiveBranch>[0];

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
