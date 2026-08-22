/**
 * Tests for shouldAdoptBroadcastActiveId — the anti-hijack guard for the sidebar.
 * "Active conversation" is a single GLOBAL backend value, so any client (a second
 * GUI window, or the `kai` CLI) flipping it broadcasts to everyone. This guard
 * decides whether THIS window should follow that broadcast onto a new selection.
 * The bug it fixes: the CLI creating/selecting a chat yanked the GUI user's
 * selection outline onto a different conversation.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  commitLocalConversationSelection,
  filterConversationDeleteFallbackCandidates,
  isConversationWorkspaceRestorationCurrent,
  openBrowserConversationInWorkspace,
  prepareConversationWorkspaceSwitch,
  selectConversationDeleteFallback,
  shouldAdoptBroadcastActiveId,
  shouldApplyConversationDeleteFallback,
  shouldClearSelectionForNullActiveBroadcast,
} from '../conversation-selection';

describe('isConversationWorkspaceRestorationCurrent', () => {
  const current = {
    workspaceId: 'workspace-b',
    currentWorkspaceId: 'workspace-b',
    selectionSequence: 4,
    currentSelectionSequence: 4,
    selectionWhenStarted: 'conv-a',
    currentSelection: 'conv-a',
  };

  it('accepts only an unchanged workspace and selection attempt', () => {
    expect(isConversationWorkspaceRestorationCurrent(current)).toBe(true);
    expect(isConversationWorkspaceRestorationCurrent({ ...current, currentWorkspaceId: 'workspace-c' })).toBe(false);
    expect(isConversationWorkspaceRestorationCurrent({ ...current, currentSelectionSequence: 5 })).toBe(false);
    expect(isConversationWorkspaceRestorationCurrent({ ...current, currentSelection: 'conv-user-choice' })).toBe(false);
  });
});

describe('filterConversationDeleteFallbackCandidates', () => {
  const conversations = [
    { id: 'visible', workspaceId: 'workspace-a', archived: false, messageCount: 1 },
    { id: 'legacy', archived: false, messageCount: 1 },
    { id: 'other-workspace', workspaceId: 'workspace-b', archived: false, messageCount: 1 },
    { id: 'archived', workspaceId: 'workspace-a', archived: true, messageCount: 1 },
    { id: 'empty', workspaceId: 'workspace-a', archived: false, messageCount: 0 },
  ];

  it('uses the caller snapshot as the exact visible fallback scope', () => {
    expect(
      filterConversationDeleteFallbackCandidates(conversations, ['visible'], {
        fallbackCandidateIds: ['visible', 'archived'],
        workspaceId: 'workspace-a',
      }).map((conversation) => conversation.id),
    ).toEqual(['archived']);
  });

  it('falls back to normal visible chats in the active workspace when no snapshot is available', () => {
    expect(
      filterConversationDeleteFallbackCandidates(conversations, [], {
        workspaceId: 'workspace-a',
      }).map((conversation) => conversation.id),
    ).toEqual(['visible', 'legacy']);
  });
});

describe('prepareConversationWorkspaceSwitch', () => {
  it('uses workspace state observed after the conversation lookup resolves', async () => {
    let activeWorkspaceId = 'workspace-a';
    const activeConversationId = 'chat-a';
    const selectionGeneration = 1;
    let resolveConversation: (conversation: { workspaceId: string }) => void = () => {};
    const getConversation = vi.fn(
      () =>
        new Promise<{ workspaceId: string }>((resolve) => {
          resolveConversation = resolve;
        }),
    );
    const saveLastConversation = vi.fn(async () => undefined);
    const setActiveWorkspace = vi.fn(async () => true);
    const switchConversation = vi.fn(async () => true);
    const cancelObservation = vi.fn();

    const opening = openBrowserConversationInWorkspace({
      conversationId: 'chat-b',
      selectionGeneration,
      getConversation,
      getActiveConversationId: () => activeConversationId,
      getSelectionGeneration: () => selectionGeneration,
      getActiveWorkspaceId: () => activeWorkspaceId,
      getKnownWorkspaceIds: () => ['workspace-a', 'workspace-b'],
      saveLastConversation,
      getWorkspaceSelectionGeneration: () => 1,
      workspaceSelectionGeneration: 1,
      setActiveWorkspace,
      createWorkspaceObservationWait: () => ({
        promise: Promise.resolve(true),
        cancel: cancelObservation,
      }),
      switchConversation,
    });

    activeWorkspaceId = 'workspace-b';
    resolveConversation({ workspaceId: 'workspace-b' });

    await expect(opening).resolves.toBe(true);
    expect(saveLastConversation).not.toHaveBeenCalled();
    expect(setActiveWorkspace).not.toHaveBeenCalled();
    expect(switchConversation).toHaveBeenCalledWith('chat-b', 'chat-a', selectionGeneration);
    expect(cancelObservation).toHaveBeenCalledOnce();
  });

  it('does not let delayed Browser attention override a newer user selection', async () => {
    let activeWorkspaceId = 'workspace-a';
    let activeConversationId = 'chat-a';
    let selectionGeneration = 1;
    let resolveObservation: (observed: boolean) => void = () => {};
    const workspaceSelectionGeneration = 1;
    const setActiveWorkspace = vi.fn(async (workspaceId: string | null) => {
      activeWorkspaceId = workspaceId ?? '';
      return true;
    });
    const switchConversation = vi.fn(async () => true);

    const opening = openBrowserConversationInWorkspace({
      conversationId: 'chat-b',
      selectionGeneration,
      getConversation: async () => ({ workspaceId: 'workspace-b' }),
      getActiveConversationId: () => activeConversationId,
      getSelectionGeneration: () => selectionGeneration,
      getActiveWorkspaceId: () => activeWorkspaceId,
      getKnownWorkspaceIds: () => ['workspace-a', 'workspace-b'],
      saveLastConversation: async () => undefined,
      getWorkspaceSelectionGeneration: () => workspaceSelectionGeneration,
      workspaceSelectionGeneration,
      setActiveWorkspace,
      createWorkspaceObservationWait: () => ({
        promise: new Promise<boolean>((resolve) => {
          resolveObservation = resolve;
        }),
        cancel: vi.fn(),
      }),
      switchConversation,
    });

    await vi.waitFor(() => expect(setActiveWorkspace).toHaveBeenCalledWith('workspace-b', 'workspace-a'));
    activeConversationId = 'chat-user-choice';
    selectionGeneration++;
    resolveObservation(true);

    await expect(opening).resolves.toBe(false);
    expect(switchConversation).not.toHaveBeenCalled();
    expect(setActiveWorkspace).toHaveBeenLastCalledWith('workspace-a', 'workspace-b');
    expect(activeWorkspaceId).toBe('workspace-a');
  });

  it('rolls back a workspace switch that commits after a newer navigation intent', async () => {
    let activeWorkspaceId = 'workspace-a';
    const activeConversationId = 'chat-a';
    let selectionGeneration = 1;
    let resolveWorkspaceSwitch: () => void = () => {};
    const setActiveWorkspace = vi.fn((workspaceId: string | null) => {
      if (workspaceId === 'workspace-b') {
        return new Promise<boolean>((resolve) => {
          resolveWorkspaceSwitch = () => {
            activeWorkspaceId = 'workspace-b';
            resolve(true);
          };
        });
      }
      activeWorkspaceId = workspaceId ?? '';
      return Promise.resolve(true);
    });

    const opening = openBrowserConversationInWorkspace({
      conversationId: 'chat-b',
      selectionGeneration,
      getConversation: async () => ({ workspaceId: 'workspace-b' }),
      getActiveConversationId: () => activeConversationId,
      getSelectionGeneration: () => selectionGeneration,
      getActiveWorkspaceId: () => activeWorkspaceId,
      getKnownWorkspaceIds: () => ['workspace-a', 'workspace-b'],
      saveLastConversation: async () => undefined,
      getWorkspaceSelectionGeneration: () => 1,
      workspaceSelectionGeneration: 1,
      setActiveWorkspace,
      createWorkspaceObservationWait: () => ({ promise: new Promise<boolean>(() => undefined), cancel: vi.fn() }),
      switchConversation: vi.fn(async () => true),
    });

    await vi.waitFor(() => expect(setActiveWorkspace).toHaveBeenCalledWith('workspace-b', 'workspace-a'));
    selectionGeneration++;
    resolveWorkspaceSwitch();

    await expect(opening).resolves.toBe(false);
    expect(setActiveWorkspace).toHaveBeenLastCalledWith('workspace-a', 'workspace-b');
    expect(activeWorkspaceId).toBe('workspace-a');
  });

  it('lets only the newest concurrent Browser-attention request select a conversation', async () => {
    let activeConversationId = 'chat-a';
    let selectionGeneration = 0;
    let resolveFirstConversation: (conversation: { workspaceId: string }) => void = () => {};
    const getConversation = vi.fn((conversationId: string) => {
      if (conversationId === 'chat-b') {
        return new Promise<{ workspaceId: string }>((resolve) => {
          resolveFirstConversation = resolve;
        });
      }
      return Promise.resolve({ workspaceId: 'workspace-a' });
    });
    const switchConversation = vi.fn(async (conversationId: string, _expected: string | null, generation: number) => {
      if (generation !== selectionGeneration) return false;
      activeConversationId = conversationId;
      return true;
    });
    const common = {
      getConversation,
      getActiveConversationId: () => activeConversationId,
      getSelectionGeneration: () => selectionGeneration,
      getActiveWorkspaceId: () => 'workspace-a',
      getKnownWorkspaceIds: () => ['workspace-a'],
      saveLastConversation: async () => undefined,
      getWorkspaceSelectionGeneration: () => 0,
      workspaceSelectionGeneration: 0,
      setActiveWorkspace: async () => true,
      createWorkspaceObservationWait: () => ({ promise: Promise.resolve(true), cancel: vi.fn() }),
      switchConversation,
    };

    const first = openBrowserConversationInWorkspace({
      ...common,
      conversationId: 'chat-b',
      selectionGeneration: ++selectionGeneration,
    });
    const second = openBrowserConversationInWorkspace({
      ...common,
      conversationId: 'chat-c',
      selectionGeneration: ++selectionGeneration,
    });

    await expect(second).resolves.toBe(true);
    resolveFirstConversation({ workspaceId: 'workspace-a' });
    await expect(first).resolves.toBe(false);
    expect(switchConversation).toHaveBeenCalledOnce();
    expect(switchConversation).toHaveBeenCalledWith('chat-c', 'chat-a', 2);
  });

  it('accepts the target selected by the requested workspace restoration', async () => {
    let activeWorkspaceId = 'workspace-a';
    let activeConversationId = 'chat-a';
    const selectionGeneration = 1;
    let resolveObservation: (observed: boolean) => void = () => {};
    const workspaceSelectionGeneration = 1;
    const setActiveWorkspace = vi.fn(async (workspaceId: string | null) => {
      activeWorkspaceId = workspaceId ?? '';
      return true;
    });
    const switchConversation = vi.fn(async () => true);

    const opening = openBrowserConversationInWorkspace({
      conversationId: 'chat-b',
      selectionGeneration,
      getConversation: async () => ({ workspaceId: 'workspace-b' }),
      getActiveConversationId: () => activeConversationId,
      getSelectionGeneration: () => selectionGeneration,
      getActiveWorkspaceId: () => activeWorkspaceId,
      getKnownWorkspaceIds: () => ['workspace-a', 'workspace-b'],
      saveLastConversation: async () => undefined,
      getWorkspaceSelectionGeneration: () => workspaceSelectionGeneration,
      workspaceSelectionGeneration,
      setActiveWorkspace,
      createWorkspaceObservationWait: () => ({
        promise: new Promise<boolean>((resolve) => {
          resolveObservation = resolve;
        }),
        cancel: vi.fn(),
      }),
      switchConversation,
    });

    await vi.waitFor(() => expect(setActiveWorkspace).toHaveBeenCalledWith('workspace-b', 'workspace-a'));
    activeConversationId = 'chat-b';
    resolveObservation(true);

    await expect(opening).resolves.toBe(true);
    expect(switchConversation).not.toHaveBeenCalled();
  });

  it('waits for a configured workspace whose transition effect is still pending', async () => {
    let resolveObservation: (observed: boolean) => void = () => {};
    let settled = false;
    const saveLastConversation = vi.fn(async () => undefined);
    const setActiveWorkspace = vi.fn(async () => true);
    const cancelObservation = vi.fn();

    const preparation = prepareConversationWorkspaceSwitch({
      conversationId: 'chat-b',
      conversationWorkspaceId: 'workspace-b',
      activeWorkspaceId: 'workspace-b',
      knownWorkspaceIds: ['workspace-a', 'workspace-b'],
      saveLastConversation,
      setActiveWorkspace,
      createWorkspaceObservationWait: () => ({
        promise: new Promise<boolean>((resolve) => {
          resolveObservation = resolve;
        }),
        cancel: cancelObservation,
      }),
    }).then((ready) => {
      settled = true;
      return ready;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(saveLastConversation).not.toHaveBeenCalled();
    expect(setActiveWorkspace).not.toHaveBeenCalled();

    resolveObservation(true);
    await expect(preparation).resolves.toBe(true);
    expect(cancelObservation).toHaveBeenCalledOnce();
  });

  it('waits for the departing-workspace effect before the caller selects the destination chat', async () => {
    const calls: string[] = [];
    const lastConversation = new Map<string, string>();
    let currentConversation = 'chat-a';
    let resolveObservation: (observed: boolean) => void = () => {};
    let signalWorkspaceSet: () => void = () => {};
    const workspaceSet = new Promise<void>((resolve) => {
      signalWorkspaceSet = resolve;
    });
    let preparationSettled = false;

    const preparation = prepareConversationWorkspaceSwitch({
      conversationId: 'chat-b',
      conversationWorkspaceId: 'workspace-b',
      activeWorkspaceId: 'workspace-a',
      knownWorkspaceIds: ['workspace-a', 'workspace-b'],
      saveLastConversation: async ({ workspaceId, conversationId }) => {
        calls.push(`save:${workspaceId}:${conversationId}`);
        lastConversation.set(workspaceId, conversationId);
      },
      setActiveWorkspace: async (workspaceId) => {
        calls.push(`switch:${workspaceId}`);
        signalWorkspaceSet();
        return true;
      },
      createWorkspaceObservationWait: (workspaceId) => {
        calls.push(`wait:${workspaceId}`);
        return {
          promise: new Promise<boolean>((resolve) => {
            resolveObservation = resolve;
          }),
          cancel: () => calls.push(`cancel:${workspaceId}`),
        };
      },
    }).then((ready) => {
      preparationSettled = true;
      if (ready) currentConversation = 'chat-b';
      return ready;
    });

    await workspaceSet;
    expect(preparationSettled).toBe(false);

    // This models App's workspace-change effect. It must observe chat A before
    // Browser attention is allowed to publish chat B as the current selection.
    lastConversation.set('workspace-a', currentConversation);
    resolveObservation(true);

    await expect(preparation).resolves.toBe(true);
    expect(lastConversation).toEqual(
      new Map([
        ['workspace-b', 'chat-b'],
        ['workspace-a', 'chat-a'],
      ]),
    );
    expect(calls).toEqual(['wait:workspace-b', 'save:workspace-b:chat-b', 'switch:workspace-b', 'cancel:workspace-b']);
  });

  it('fails closed when the conversation references a workspace that no longer exists', async () => {
    const saveLastConversation = vi.fn(async () => undefined);
    const setActiveWorkspace = vi.fn(async () => true);
    await expect(
      prepareConversationWorkspaceSwitch({
        conversationId: 'chat-orphaned',
        conversationWorkspaceId: 'workspace-deleted',
        activeWorkspaceId: 'workspace-a',
        knownWorkspaceIds: ['workspace-a'],
        saveLastConversation,
        setActiveWorkspace,
        createWorkspaceObservationWait: vi.fn(() => ({
          promise: Promise.resolve(true),
          cancel: vi.fn(),
        })),
      }),
    ).resolves.toBe(false);
    expect(saveLastConversation).not.toHaveBeenCalled();
    expect(setActiveWorkspace).not.toHaveBeenCalled();
  });
});

describe('commitLocalConversationSelection', () => {
  it('publishes the ref before scheduling React selection state', () => {
    const selectionRef = { current: 'conv-old' as string | null };
    const setSelection = vi.fn(() => {
      expect(selectionRef.current).toBe('conv-new');
    });

    commitLocalConversationSelection(selectionRef, 'conv-new', setSelection);

    expect(selectionRef.current).toBe('conv-new');
    expect(setSelection).toHaveBeenCalledWith('conv-new');
  });
});

describe('shouldAdoptBroadcastActiveId', () => {
  it('adopts when this window has no selection yet (initial load)', () => {
    expect(shouldAdoptBroadcastActiveId(null, 'conv-a')).toBe(true);
  });

  it('adopts (idempotent) when the broadcast active-id already matches our selection', () => {
    expect(shouldAdoptBroadcastActiveId('conv-a', 'conv-a')).toBe(true);
  });

  it('does NOT adopt when a DIFFERENT conversation becomes active (the CLI-hijack case)', () => {
    // GUI is on conv-a; the CLI creates/selects conv-b and flips the global active.
    // The GUI must keep its own selection, not jump to conv-b.
    expect(shouldAdoptBroadcastActiveId('conv-a', 'conv-b')).toBe(false);
  });

  it('does NOT adopt a null active-id here (null is handled by a separate branch)', () => {
    expect(shouldAdoptBroadcastActiveId('conv-a', null)).toBe(false);
    expect(shouldAdoptBroadcastActiveId(null, null)).toBe(false);
  });
});

describe('shouldClearSelectionForNullActiveBroadcast', () => {
  it('preserves this window selection when another client deletes its globally active background chat', () => {
    expect(shouldClearSelectionForNullActiveBroadcast('conv-a', { kind: 'delete', id: 'conv-b' })).toBe(false);
  });

  it('clears when this window selected the deleted chat or the whole store was reset', () => {
    expect(shouldClearSelectionForNullActiveBroadcast('conv-a', { kind: 'delete', id: 'conv-a' })).toBe(true);
    expect(shouldClearSelectionForNullActiveBroadcast('conv-a', { kind: 'reset' })).toBe(true);
  });

  it('keeps a valid local selection across an unrelated explicit null active-id', () => {
    expect(shouldClearSelectionForNullActiveBroadcast('conv-a', { kind: 'active' })).toBe(false);
    expect(shouldClearSelectionForNullActiveBroadcast(null, { kind: 'active' })).toBe(true);
  });
});

describe('shouldApplyConversationDeleteFallback', () => {
  it('applies the fallback only while the deleted chat remains this window selection', () => {
    expect(shouldApplyConversationDeleteFallback('conv-a', 'conv-a', 'conv-a')).toBe(true);
    expect(shouldApplyConversationDeleteFallback('conv-a', 'conv-b', 'conv-b')).toBe(false);
    expect(shouldApplyConversationDeleteFallback('conv-a', 'conv-a', 'conv-c')).toBe(false);
    expect(shouldApplyConversationDeleteFallback('conv-a', 'conv-a', null)).toBe(false);
  });

  it('relists when another window deletes the preselected fallback during cleanup', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'conv-c' }])
      .mockResolvedValueOnce([{ id: 'conv-c' }])
      .mockResolvedValueOnce([{ id: 'conv-c' }]);
    const setActiveId = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, activeConversationId: null })
      .mockResolvedValueOnce({ ok: true });

    await expect(
      selectConversationDeleteFallback({
        deletedId: 'conv-a',
        expectedBackendId: 'conv-b',
        list,
        setActiveId,
      }),
    ).resolves.toEqual({ id: 'conv-c' });
    expect(setActiveId).toHaveBeenNthCalledWith(1, 'conv-c', 'conv-b');
    expect(setActiveId).toHaveBeenNthCalledWith(2, 'conv-c', null);
  });

  it('adopts a concurrently selected surviving backend conversation instead of overwriting it', async () => {
    const conversations = [{ id: 'conv-b' }, { id: 'conv-c' }];
    const setActiveId = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, activeConversationId: 'conv-c' })
      .mockResolvedValueOnce({ ok: true });

    await expect(
      selectConversationDeleteFallback({
        deletedId: 'conv-a',
        expectedBackendId: 'conv-b',
        list: async () => conversations,
        setActiveId,
      }),
    ).resolves.toEqual({ id: 'conv-c' });
    expect(setActiveId).toHaveBeenNthCalledWith(2, 'conv-c', 'conv-c');
  });

  it('preserves a concurrent backend selection outside this window fallback list', async () => {
    const setActiveId = vi.fn().mockResolvedValueOnce({
      ok: false,
      activeConversationId: 'conv-other-workspace',
    });

    await expect(
      selectConversationDeleteFallback({
        deletedId: 'conv-a',
        expectedBackendId: 'conv-old-fallback',
        list: async () => [{ id: 'conv-visible-fallback' }],
        setActiveId,
      }),
    ).resolves.toBeNull();

    expect(setActiveId).toHaveBeenCalledOnce();
    expect(setActiveId).toHaveBeenCalledWith('conv-visible-fallback', 'conv-old-fallback');
  });

  it('clears a fallback that is deleted after its selection CAS succeeds', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'conv-b' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const setActiveId = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: true });

    await expect(
      selectConversationDeleteFallback({
        deletedId: 'conv-a',
        expectedBackendId: null,
        list,
        setActiveId,
      }),
    ).resolves.toBeNull();

    expect(setActiveId).toHaveBeenNthCalledWith(1, 'conv-b', null);
    expect(setActiveId).toHaveBeenNthCalledWith(2, null, 'conv-b');
  });

  it('clears a stale backend fallback when no conversations survive cleanup', async () => {
    const setActiveId = vi.fn(async () => ({ ok: true }));

    await expect(
      selectConversationDeleteFallback({
        deletedId: 'conv-a',
        expectedBackendId: 'conv-b',
        list: async () => [],
        setActiveId,
      }),
    ).resolves.toBeNull();

    expect(setActiveId).toHaveBeenCalledWith(null, 'conv-b');
  });
});
