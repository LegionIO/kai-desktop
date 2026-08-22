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
  adoptBrowserWorkspaceTransitionMarker,
  commitLocalConversationSelection,
  createBoundedWorkspaceObservationWait,
  createBrowserWorkspaceTransitionMarker,
  filterConversationDeleteFallbackCandidates,
  getConversationForWorkspaceRestoration,
  isConversationWorkspaceRestorationCurrent,
  openBrowserConversationInWorkspace,
  prepareConversationWorkspaceSwitch,
  resolveConversationWorkspaceTransition,
  rollbackUnavailableWorkspaceRestoration,
  selectConversationDeleteFallback,
  setActiveConversationForWorkspaceRestoration,
  setActiveBrowserWorkspaceWithRebase,
  setActiveUserWorkspaceWithRebase,
  shouldAdoptBroadcastActiveId,
  shouldApplyConversationDeleteFallback,
  shouldClearSelectionForNullActiveBroadcast,
  shouldRetryWorkspaceConversationRestoration,
} from '../conversation-selection';

describe('isConversationWorkspaceRestorationCurrent', () => {
  const current = {
    workspaceId: 'workspace-b',
    currentWorkspaceId: 'workspace-b',
    selectionIntentGeneration: 3,
    currentSelectionIntentGeneration: 3,
    selectionSequence: 4,
    currentSelectionSequence: 4,
    selectionWhenStarted: 'conv-a',
    currentSelection: 'conv-a',
  };

  it('accepts only an unchanged workspace and selection attempt', () => {
    expect(isConversationWorkspaceRestorationCurrent(current)).toBe(true);
    expect(isConversationWorkspaceRestorationCurrent({ ...current, currentWorkspaceId: 'workspace-c' })).toBe(false);
    expect(isConversationWorkspaceRestorationCurrent({ ...current, currentSelectionIntentGeneration: 4 })).toBe(false);
    expect(isConversationWorkspaceRestorationCurrent({ ...current, currentSelectionSequence: 5 })).toBe(false);
    expect(isConversationWorkspaceRestorationCurrent({ ...current, currentSelection: 'conv-user-choice' })).toBe(false);
  });
});

describe('resolveConversationWorkspaceTransition', () => {
  it('retains the real previous workspace when a superseded Browser transition is skipped', () => {
    const stale = resolveConversationWorkspaceTransition({
      previousWorkspaceId: 'workspace-a',
      activeWorkspaceId: 'workspace-b',
      currentConversationId: 'chat-a',
      browserTransition: {
        navigationGeneration: 1,
        browserAttentionGeneration: 1,
        workspaceSelectionGeneration: 7,
        operation: 'navigate',
        departingWorkspaceId: 'workspace-a',
        destinationWorkspaceId: 'workspace-b',
        departingConversationId: 'chat-a',
      },
      currentNavigationGeneration: 2,
      currentBrowserAttentionGeneration: 1,
      currentWorkspaceSelectionGeneration: 7,
    });

    expect(stale).toEqual({
      staleBrowserTransition: true,
      suppressArrivingWorkspaceRestoration: true,
      departingWorkspaceId: 'workspace-a',
      departingConversationId: 'chat-a',
      nextPreviousWorkspaceId: 'workspace-a',
    });

    const next = resolveConversationWorkspaceTransition({
      previousWorkspaceId: stale.nextPreviousWorkspaceId,
      activeWorkspaceId: 'workspace-c',
      currentConversationId: 'chat-b',
      currentNavigationGeneration: 2,
      currentBrowserAttentionGeneration: 1,
      currentWorkspaceSelectionGeneration: 7,
    });
    expect(next).toEqual({
      staleBrowserTransition: false,
      suppressArrivingWorkspaceRestoration: false,
      departingWorkspaceId: 'workspace-a',
      departingConversationId: 'chat-b',
      nextPreviousWorkspaceId: 'workspace-c',
    });
  });

  it('lets a newer Browser request adopt a pending switch without losing the departing cursor', () => {
    const pending = createBrowserWorkspaceTransitionMarker({
      navigationGeneration: 1,
      browserAttentionGeneration: 1,
      workspaceSelectionGeneration: 7,
      operation: 'navigate',
      departingWorkspaceId: 'workspace-a',
      destinationWorkspaceId: 'workspace-b',
      departingConversationId: 'chat-a',
    });
    const adopted = adoptBrowserWorkspaceTransitionMarker({
      marker: pending,
      activeWorkspaceId: 'workspace-b',
      previousWorkspaceId: 'workspace-a',
      navigationGeneration: 2,
      browserAttentionGeneration: 2,
      currentWorkspaceSelectionGeneration: 7,
    });

    expect(
      resolveConversationWorkspaceTransition({
        previousWorkspaceId: 'workspace-a',
        activeWorkspaceId: 'workspace-b',
        currentConversationId: 'chat-b',
        browserTransition: adopted,
        currentNavigationGeneration: 2,
        currentBrowserAttentionGeneration: 2,
        currentWorkspaceSelectionGeneration: 7,
      }),
    ).toEqual({
      staleBrowserTransition: false,
      suppressArrivingWorkspaceRestoration: true,
      departingWorkspaceId: 'workspace-a',
      departingConversationId: 'chat-a',
      nextPreviousWorkspaceId: 'workspace-b',
    });
  });

  it('reconciles a committed transition when a newer Browser request supersedes its rollback owner', () => {
    expect(
      resolveConversationWorkspaceTransition({
        previousWorkspaceId: 'workspace-a',
        activeWorkspaceId: 'workspace-b',
        currentConversationId: 'chat-a',
        browserTransition: {
          navigationGeneration: 1,
          browserAttentionGeneration: 1,
          workspaceSelectionGeneration: 7,
          operation: 'navigate',
          departingWorkspaceId: 'workspace-a',
          destinationWorkspaceId: 'workspace-b',
          departingConversationId: 'chat-a',
        },
        currentNavigationGeneration: 2,
        currentBrowserAttentionGeneration: 2,
        currentWorkspaceSelectionGeneration: 7,
      }),
    ).toEqual({
      staleBrowserTransition: false,
      suppressArrivingWorkspaceRestoration: true,
      departingWorkspaceId: 'workspace-a',
      departingConversationId: 'chat-a',
      nextPreviousWorkspaceId: 'workspace-b',
    });
  });

  it('does not classify an adopted transition as rollback-pending after newer user navigation', () => {
    expect(
      resolveConversationWorkspaceTransition({
        previousWorkspaceId: 'workspace-a',
        activeWorkspaceId: 'workspace-b',
        currentConversationId: 'chat-user-choice',
        browserTransition: {
          navigationGeneration: 2,
          browserAttentionGeneration: 2,
          workspaceSelectionGeneration: 7,
          suppressArrivingWorkspaceRestoration: true,
          operation: 'navigate',
          departingWorkspaceId: 'workspace-a',
          destinationWorkspaceId: 'workspace-b',
          departingConversationId: 'chat-a',
        },
        currentNavigationGeneration: 3,
        currentBrowserAttentionGeneration: 2,
        currentWorkspaceSelectionGeneration: 7,
      }),
    ).toEqual({
      staleBrowserTransition: false,
      suppressArrivingWorkspaceRestoration: true,
      departingWorkspaceId: 'workspace-a',
      departingConversationId: 'chat-a',
      nextPreviousWorkspaceId: 'workspace-b',
    });
  });

  it('does not let an older Browser request downgrade a newer transition marker', () => {
    const newer = createBrowserWorkspaceTransitionMarker({
      navigationGeneration: 4,
      browserAttentionGeneration: 4,
      workspaceSelectionGeneration: 7,
      operation: 'navigate',
      departingWorkspaceId: 'workspace-a',
      destinationWorkspaceId: 'workspace-b',
      departingConversationId: 'chat-a',
    });

    expect(
      adoptBrowserWorkspaceTransitionMarker({
        marker: newer,
        activeWorkspaceId: 'workspace-b',
        previousWorkspaceId: 'workspace-a',
        navigationGeneration: 3,
        browserAttentionGeneration: 3,
        currentWorkspaceSelectionGeneration: 7,
      }),
    ).toBe(newer);
  });

  it('does not create markers for same-workspace operations or rollbacks', () => {
    expect(
      createBrowserWorkspaceTransitionMarker({
        navigationGeneration: 1,
        browserAttentionGeneration: 1,
        workspaceSelectionGeneration: 2,
        operation: 'navigate',
        departingWorkspaceId: 'workspace-a',
        destinationWorkspaceId: 'workspace-a',
        departingConversationId: 'chat-a',
      }),
    ).toBeUndefined();
    expect(
      createBrowserWorkspaceTransitionMarker({
        navigationGeneration: 1,
        browserAttentionGeneration: 1,
        workspaceSelectionGeneration: 2,
        operation: 'rollback',
        departingWorkspaceId: 'workspace-b',
        destinationWorkspaceId: 'workspace-a',
        departingConversationId: 'chat-b',
      }),
    ).toBeUndefined();
  });
});

describe('rollbackUnavailableWorkspaceRestoration', () => {
  it('CAS-restores the prior backend selection while the restoration still owns navigation', async () => {
    const setActiveId = vi.fn(async () => ({ ok: true }));

    await expect(
      rollbackUnavailableWorkspaceRestoration({
        restoredConversationId: 'chat-b',
        previousConversationId: 'chat-a',
        isCurrent: () => true,
        setActiveId,
      }),
    ).resolves.toBe(true);

    expect(setActiveId).toHaveBeenCalledWith('chat-a', 'chat-b');
  });

  it('does not overwrite a newer renderer selection', async () => {
    const setActiveId = vi.fn(async () => ({ ok: true }));

    await expect(
      rollbackUnavailableWorkspaceRestoration({
        restoredConversationId: 'chat-b',
        previousConversationId: 'chat-a',
        isCurrent: () => false,
        setActiveId,
      }),
    ).resolves.toBe(false);

    expect(setActiveId).not.toHaveBeenCalled();
  });
});

describe('setActiveConversationForWorkspaceRestoration', () => {
  it('coalesces a stale CAS result when another client already selected the restoration target', async () => {
    const setActiveId = vi.fn(async () => ({
      ok: false,
      error: 'active-conversation-changed' as const,
      activeConversationId: 'chat-b',
    }));

    await expect(
      setActiveConversationForWorkspaceRestoration({
        conversationId: 'chat-b',
        expectedCurrentConversationId: 'chat-a',
        isCurrent: () => true,
        setActiveId,
      }),
    ).resolves.toEqual({ ok: true, activeConversationId: 'chat-b' });

    expect(setActiveId).toHaveBeenCalledOnce();
  });

  it('retries transient unavailable reads within a bounded budget', async () => {
    const setActiveId = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'conversation-unavailable' })
      .mockResolvedValueOnce({ ok: false, error: 'conversation-unavailable' })
      .mockResolvedValueOnce({ ok: true });
    const waitForRetry = vi.fn(async () => undefined);

    await expect(
      setActiveConversationForWorkspaceRestoration({
        conversationId: 'chat-b',
        expectedCurrentConversationId: 'chat-a',
        isCurrent: () => true,
        setActiveId,
        waitForRetry,
      }),
    ).resolves.toEqual({ ok: true });

    expect(setActiveId).toHaveBeenCalledTimes(3);
    expect(setActiveId).toHaveBeenNthCalledWith(3, 'chat-b', 'chat-a');
    expect(waitForRetry.mock.calls).toEqual([[25], [75]]);
  });

  it('stops retrying as soon as a newer selection intent wins', async () => {
    let current = true;
    const setActiveId = vi.fn(async () => ({ ok: false, error: 'conversation-unavailable' as const }));

    await expect(
      setActiveConversationForWorkspaceRestoration({
        conversationId: 'chat-b',
        expectedCurrentConversationId: 'chat-a',
        isCurrent: () => current,
        setActiveId,
        waitForRetry: async () => {
          current = false;
        },
      }),
    ).resolves.toBeNull();

    expect(setActiveId).toHaveBeenCalledOnce();
  });

  it('returns the last unavailable result after exhausting its retry budget', async () => {
    const unavailable = { ok: false, error: 'conversation-unavailable' as const };
    const setActiveId = vi.fn(async () => unavailable);

    await expect(
      setActiveConversationForWorkspaceRestoration({
        conversationId: 'chat-b',
        expectedCurrentConversationId: 'chat-a',
        isCurrent: () => true,
        setActiveId,
        waitForRetry: async () => undefined,
      }),
    ).resolves.toBe(unavailable);

    expect(setActiveId).toHaveBeenCalledTimes(4);
  });
});

describe('getConversationForWorkspaceRestoration', () => {
  it('retries transient post-CAS reads within the bounded restoration budget', async () => {
    const conversation = { id: 'chat-b' };
    const getForRestore = vi
      .fn()
      .mockResolvedValueOnce({ status: 'unavailable' })
      .mockResolvedValueOnce({ status: 'unavailable' })
      .mockResolvedValueOnce({ status: 'found', conversation });
    const waitForRetry = vi.fn(async () => undefined);

    await expect(
      getConversationForWorkspaceRestoration({
        conversationId: 'chat-b',
        isCurrent: () => true,
        getForRestore,
        waitForRetry,
      }),
    ).resolves.toEqual({ status: 'found', conversation });

    expect(getForRestore).toHaveBeenCalledTimes(3);
    expect(waitForRetry.mock.calls).toEqual([[25], [75]]);
  });

  it('abandons a retry after a newer selection intent takes ownership', async () => {
    let current = true;
    const getForRestore = vi.fn(async () => ({ status: 'unavailable' as const }));

    await expect(
      getConversationForWorkspaceRestoration({
        conversationId: 'chat-b',
        isCurrent: () => current,
        getForRestore,
        waitForRetry: async () => {
          current = false;
        },
      }),
    ).resolves.toBeNull();

    expect(getForRestore).toHaveBeenCalledOnce();
  });
});

describe('shouldRetryWorkspaceConversationRestoration', () => {
  it('requires the original workspace and selection intent but ignores view-only navigation', () => {
    const current = {
      workspaceId: 'workspace-a',
      currentWorkspaceId: 'workspace-a',
      selectionIntentGeneration: 4,
      currentSelectionIntentGeneration: 4,
    };

    expect(shouldRetryWorkspaceConversationRestoration(current)).toBe(true);
    expect(shouldRetryWorkspaceConversationRestoration({ ...current, currentSelectionIntentGeneration: 5 })).toBe(
      false,
    );
    expect(shouldRetryWorkspaceConversationRestoration({ ...current, currentWorkspaceId: 'workspace-b' })).toBe(false);
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

describe('createBoundedWorkspaceObservationWait', () => {
  it('times out and removes a waiter when the config transition is never observed', async () => {
    vi.useFakeTimers();
    try {
      const waiters = new Map<string, Set<(observed: boolean) => void>>();
      const observation = createBoundedWorkspaceObservationWait({
        workspaceId: 'workspace-b',
        configuredWorkspaceId: 'workspace-a',
        observedWorkspaceId: 'workspace-a',
        waiters,
        timeoutMs: 5_000,
      });

      expect(waiters.get('workspace-b')?.size).toBe(1);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(observation.promise).resolves.toBe(false);
      expect(waiters.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels promptly and clears its timeout', async () => {
    vi.useFakeTimers();
    try {
      const waiters = new Map<string, Set<(observed: boolean) => void>>();
      const observation = createBoundedWorkspaceObservationWait({
        workspaceId: 'workspace-b',
        configuredWorkspaceId: 'workspace-a',
        observedWorkspaceId: 'workspace-a',
        waiters,
        timeoutMs: 5_000,
      });

      observation.cancel();
      await expect(observation.promise).resolves.toBe(false);
      expect(waiters.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('setActiveUserWorkspaceWithRebase', () => {
  it('rebases over an older local Browser mutation', async () => {
    const setActiveWorkspace = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: 'active-workspace-changed' as const,
        activeWorkspaceId: 'workspace-browser',
        activeWorkspaceMutationToken: 'local-browser_request-1',
      })
      .mockResolvedValueOnce({ ok: true, activeWorkspaceId: 'workspace-user' });

    await expect(
      setActiveUserWorkspaceWithRebase({
        workspaceId: 'workspace-user',
        expectedCurrentWorkspaceId: 'workspace-a',
        setActiveWorkspace,
        isCurrent: () => true,
        canRebase: (result) => result.activeWorkspaceMutationToken?.startsWith('local-browser_') === true,
      }),
    ).resolves.toEqual({ ok: true, activeWorkspaceId: 'workspace-user' });

    expect(setActiveWorkspace).toHaveBeenNthCalledWith(1, 'workspace-user', 'workspace-a');
    expect(setActiveWorkspace).toHaveBeenNthCalledWith(2, 'workspace-user', 'workspace-browser');
  });

  it('does not rebase after a newer user intent or across another renderer mutation', async () => {
    let current = true;
    const localConflict = vi.fn(async () => {
      current = false;
      return {
        ok: false,
        error: 'active-workspace-changed' as const,
        activeWorkspaceId: 'workspace-browser',
        activeWorkspaceMutationToken: 'local-browser_request-1',
      };
    });
    await setActiveUserWorkspaceWithRebase({
      workspaceId: 'workspace-user',
      expectedCurrentWorkspaceId: 'workspace-a',
      setActiveWorkspace: localConflict,
      isCurrent: () => current,
      canRebase: (result) => result.activeWorkspaceMutationToken?.startsWith('local-browser_') === true,
    });
    expect(localConflict).toHaveBeenCalledOnce();

    const foreignConflict = vi.fn(async () => ({
      ok: false,
      error: 'active-workspace-changed' as const,
      activeWorkspaceId: 'workspace-foreign',
      activeWorkspaceMutationToken: 'foreign-browser_request-1',
    }));
    await setActiveUserWorkspaceWithRebase({
      workspaceId: 'workspace-user',
      expectedCurrentWorkspaceId: 'workspace-a',
      setActiveWorkspace: foreignConflict,
      isCurrent: () => true,
      canRebase: (result) => result.activeWorkspaceMutationToken?.startsWith('local-browser_') === true,
    });
    expect(foreignConflict).toHaveBeenCalledOnce();
  });
});

describe('setActiveBrowserWorkspaceWithRebase', () => {
  it('rebases the current Browser request onto the authoritative workspace after a CAS conflict', async () => {
    const setActiveWorkspace = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: 'active-workspace-changed',
        activeWorkspaceId: 'workspace-authoritative',
        activeWorkspaceLastConversationId: 'chat-authoritative',
      })
      .mockResolvedValueOnce({ ok: true });

    await expect(
      setActiveBrowserWorkspaceWithRebase({
        workspaceId: 'workspace-browser',
        expectedCurrentWorkspaceId: 'workspace-stale',
        departingConversationId: 'chat-stale',
        setActiveWorkspace,
        isCurrent: () => true,
        canRebase: () => true,
      }),
    ).resolves.toEqual({ ok: true, previousWorkspaceId: 'workspace-authoritative' });

    expect(setActiveWorkspace).toHaveBeenNthCalledWith(1, 'workspace-browser', 'workspace-stale', 'chat-stale');
    expect(setActiveWorkspace).toHaveBeenNthCalledWith(
      2,
      'workspace-browser',
      'workspace-authoritative',
      'chat-authoritative',
    );
  });

  it('does not retry a CAS conflict after the Browser request loses ownership', async () => {
    const setActiveWorkspace = vi.fn(async () => ({
      ok: false,
      error: 'active-workspace-changed' as const,
      activeWorkspaceId: 'workspace-authoritative',
      activeWorkspaceLastConversationId: 'chat-authoritative',
    }));

    await expect(
      setActiveBrowserWorkspaceWithRebase({
        workspaceId: 'workspace-browser',
        expectedCurrentWorkspaceId: 'workspace-stale',
        departingConversationId: 'chat-stale',
        setActiveWorkspace,
        isCurrent: () => false,
        canRebase: () => true,
      }),
    ).resolves.toEqual({ ok: false });

    expect(setActiveWorkspace).toHaveBeenCalledOnce();
  });

  it('does not rebase across a workspace mutation owned by another renderer', async () => {
    const setActiveWorkspace = vi.fn(async () => ({
      ok: false,
      error: 'active-workspace-changed' as const,
      activeWorkspaceId: 'workspace-authoritative',
      activeWorkspaceLastConversationId: 'chat-authoritative',
      activeWorkspaceMutationToken: 'other-renderer',
    }));

    await expect(
      setActiveBrowserWorkspaceWithRebase({
        workspaceId: 'workspace-browser',
        expectedCurrentWorkspaceId: 'workspace-stale',
        departingConversationId: 'chat-stale',
        setActiveWorkspace,
        isCurrent: () => true,
        canRebase: (result) => result.activeWorkspaceMutationToken === 'this-renderer',
      }),
    ).resolves.toEqual({ ok: false });

    expect(setActiveWorkspace).toHaveBeenCalledOnce();
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
      getBackendActiveConversationId: async () => activeConversationId,
      getSelectionGeneration: () => selectionGeneration,
      getActiveWorkspaceId: () => activeWorkspaceId,
      getKnownWorkspaceIds: () => ['workspace-a', 'workspace-b'],
      saveLastConversation,
      getWorkspaceSelectionGeneration: () => 1,
      workspaceSelectionGeneration: 1,
      getBrowserAttentionGeneration: () => 1,
      browserAttentionGeneration: 1,
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
    expect(saveLastConversation).toHaveBeenCalledWith({ workspaceId: 'workspace-b', conversationId: 'chat-b' });
    expect(setActiveWorkspace).toHaveBeenCalledWith('workspace-b', 'workspace-b', 'navigate');
    expect(switchConversation).toHaveBeenCalledWith('chat-b', 'chat-a', selectionGeneration);
    expect(cancelObservation).toHaveBeenCalledOnce();
  });

  it('uses the backend active conversation as the selection compare-and-set snapshot', async () => {
    const switchConversation = vi.fn(async () => true);

    await expect(
      openBrowserConversationInWorkspace({
        conversationId: 'chat-browser',
        selectionGeneration: 1,
        getConversation: async () => ({ workspaceId: 'workspace-a' }),
        getActiveConversationId: () => 'chat-renderer',
        getBackendActiveConversationId: async () => 'chat-backend',
        getSelectionGeneration: () => 1,
        getActiveWorkspaceId: () => 'workspace-a',
        getKnownWorkspaceIds: () => ['workspace-a'],
        saveLastConversation: async () => undefined,
        getWorkspaceSelectionGeneration: () => 1,
        workspaceSelectionGeneration: 1,
        getBrowserAttentionGeneration: () => 1,
        browserAttentionGeneration: 1,
        setActiveWorkspace: async () => true,
        createWorkspaceObservationWait: () => ({ promise: Promise.resolve(true), cancel: vi.fn() }),
        switchConversation,
      }),
    ).resolves.toBe(true);

    expect(switchConversation).toHaveBeenCalledWith('chat-browser', 'chat-backend', 1);
  });

  it('adopts a pending workspace transition when the target is already selected', async () => {
    const adoptActiveWorkspaceTransition = vi.fn();
    const setActiveWorkspace = vi.fn(async () => true);
    const switchConversation = vi.fn(async () => true);

    await expect(
      openBrowserConversationInWorkspace({
        conversationId: 'chat-b',
        selectionGeneration: 2,
        getConversation: async () => ({ workspaceId: 'workspace-b' }),
        getActiveConversationId: () => 'chat-b',
        getBackendActiveConversationId: async () => 'chat-b',
        getSelectionGeneration: () => 2,
        getActiveWorkspaceId: () => 'workspace-b',
        getKnownWorkspaceIds: () => ['workspace-a', 'workspace-b'],
        saveLastConversation: async () => undefined,
        getWorkspaceSelectionGeneration: () => 1,
        workspaceSelectionGeneration: 1,
        getBrowserAttentionGeneration: () => 2,
        browserAttentionGeneration: 2,
        setActiveWorkspace,
        createWorkspaceObservationWait: () => ({ promise: Promise.resolve(true), cancel: vi.fn() }),
        adoptActiveWorkspaceTransition,
        switchConversation,
      }),
    ).resolves.toBe(true);

    expect(adoptActiveWorkspaceTransition).toHaveBeenCalledWith('workspace-b');
    expect(setActiveWorkspace).toHaveBeenCalledWith('workspace-b', 'workspace-b', 'navigate');
    expect(switchConversation).not.toHaveBeenCalled();
  });

  it('adopts a pending transition before selecting another chat in the already-active workspace', async () => {
    const adoptActiveWorkspaceTransition = vi.fn();
    const switchConversation = vi.fn(async () => true);

    await expect(
      openBrowserConversationInWorkspace({
        conversationId: 'chat-b',
        selectionGeneration: 2,
        getConversation: async () => ({ workspaceId: 'workspace-b' }),
        getActiveConversationId: () => 'chat-a',
        getBackendActiveConversationId: async () => 'chat-a',
        getSelectionGeneration: () => 2,
        getActiveWorkspaceId: () => 'workspace-b',
        getKnownWorkspaceIds: () => ['workspace-a', 'workspace-b'],
        saveLastConversation: async () => undefined,
        getWorkspaceSelectionGeneration: () => 1,
        workspaceSelectionGeneration: 1,
        getBrowserAttentionGeneration: () => 2,
        browserAttentionGeneration: 2,
        setActiveWorkspace: async () => true,
        createWorkspaceObservationWait: () => ({ promise: Promise.resolve(true), cancel: vi.fn() }),
        adoptActiveWorkspaceTransition,
        switchConversation,
      }),
    ).resolves.toBe(true);

    expect(adoptActiveWorkspaceTransition).toHaveBeenCalledWith('workspace-b');
    expect(switchConversation).toHaveBeenCalledWith('chat-b', 'chat-a', 2);
  });

  it('does not let a delayed older request adopt a newer transition', async () => {
    const adoptActiveWorkspaceTransition = vi.fn();

    await expect(
      openBrowserConversationInWorkspace({
        conversationId: 'chat-b',
        selectionGeneration: 1,
        getConversation: async () => ({ workspaceId: 'workspace-b' }),
        getActiveConversationId: () => 'chat-b',
        getBackendActiveConversationId: async () => 'chat-b',
        getSelectionGeneration: () => 2,
        getActiveWorkspaceId: () => 'workspace-b',
        getKnownWorkspaceIds: () => ['workspace-a', 'workspace-b'],
        saveLastConversation: async () => undefined,
        getWorkspaceSelectionGeneration: () => 1,
        workspaceSelectionGeneration: 1,
        getBrowserAttentionGeneration: () => 2,
        browserAttentionGeneration: 1,
        setActiveWorkspace: async () => true,
        createWorkspaceObservationWait: () => ({ promise: Promise.resolve(true), cancel: vi.fn() }),
        adoptActiveWorkspaceTransition,
        switchConversation: vi.fn(async () => true),
      }),
    ).resolves.toBe(false);

    expect(adoptActiveWorkspaceTransition).not.toHaveBeenCalled();
  });

  it('switches workspaces when Browser attention targets the already-selected conversation', async () => {
    let activeWorkspaceId = 'workspace-b';
    const saveLastConversation = vi.fn(async () => undefined);
    const setActiveWorkspace = vi.fn(async (workspaceId: string | null) => {
      activeWorkspaceId = workspaceId ?? '';
      return true;
    });
    const switchConversation = vi.fn(async () => true);
    const cancelObservation = vi.fn();

    await expect(
      openBrowserConversationInWorkspace({
        conversationId: 'chat-a',
        selectionGeneration: 1,
        getConversation: async () => ({ workspaceId: 'workspace-a' }),
        getActiveConversationId: () => 'chat-a',
        getBackendActiveConversationId: async () => 'chat-a',
        getSelectionGeneration: () => 1,
        getActiveWorkspaceId: () => activeWorkspaceId,
        getKnownWorkspaceIds: () => ['workspace-a', 'workspace-b'],
        saveLastConversation,
        getWorkspaceSelectionGeneration: () => 1,
        workspaceSelectionGeneration: 1,
        getBrowserAttentionGeneration: () => 1,
        browserAttentionGeneration: 1,
        setActiveWorkspace,
        createWorkspaceObservationWait: () => ({ promise: Promise.resolve(true), cancel: cancelObservation }),
        switchConversation,
      }),
    ).resolves.toBe(true);

    expect(saveLastConversation).toHaveBeenCalledWith({ workspaceId: 'workspace-a', conversationId: 'chat-a' });
    expect(setActiveWorkspace).toHaveBeenCalledWith('workspace-a', 'workspace-b', 'navigate');
    expect(switchConversation).not.toHaveBeenCalled();
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
      getBackendActiveConversationId: async () => activeConversationId,
      getSelectionGeneration: () => selectionGeneration,
      getActiveWorkspaceId: () => activeWorkspaceId,
      getKnownWorkspaceIds: () => ['workspace-a', 'workspace-b'],
      saveLastConversation: async () => undefined,
      getWorkspaceSelectionGeneration: () => workspaceSelectionGeneration,
      workspaceSelectionGeneration,
      getBrowserAttentionGeneration: () => 1,
      browserAttentionGeneration: 1,
      setActiveWorkspace,
      createWorkspaceObservationWait: () => ({
        promise: new Promise<boolean>((resolve) => {
          resolveObservation = resolve;
        }),
        cancel: vi.fn(),
      }),
      switchConversation,
    });

    await vi.waitFor(() => expect(setActiveWorkspace).toHaveBeenCalledWith('workspace-b', 'workspace-a', 'navigate'));
    activeConversationId = 'chat-user-choice';
    selectionGeneration++;
    resolveObservation(true);

    await expect(opening).resolves.toBe(false);
    expect(switchConversation).not.toHaveBeenCalled();
    expect(setActiveWorkspace).toHaveBeenLastCalledWith('workspace-a', 'workspace-b', 'rollback');
    expect(activeWorkspaceId).toBe('workspace-a');
  });

  it('does not select a destination conversation after another window leaves its workspace', async () => {
    let activeWorkspaceId = 'workspace-a';
    const activeConversationId = 'chat-a';
    let resolveObservation: (observed: boolean) => void = () => {};
    const setActiveWorkspace = vi.fn(
      async (workspaceId: string | null, expectedWorkspaceId: string | null, operation: 'navigate' | 'rollback') => {
        if (activeWorkspaceId !== expectedWorkspaceId) {
          return { ok: false, activeWorkspaceId };
        }
        const previousWorkspaceId = activeWorkspaceId;
        activeWorkspaceId = workspaceId ?? '';
        return operation === 'navigate' ? { ok: true, previousWorkspaceId } : true;
      },
    );
    const switchConversation = vi.fn(async () => true);

    const opening = openBrowserConversationInWorkspace({
      conversationId: 'chat-b',
      selectionGeneration: 1,
      getConversation: async () => ({ workspaceId: 'workspace-b' }),
      getActiveConversationId: () => activeConversationId,
      getBackendActiveConversationId: async () => activeConversationId,
      getSelectionGeneration: () => 1,
      getActiveWorkspaceId: () => activeWorkspaceId,
      getKnownWorkspaceIds: () => ['workspace-a', 'workspace-b', 'workspace-c'],
      saveLastConversation: async () => undefined,
      getWorkspaceSelectionGeneration: () => 1,
      workspaceSelectionGeneration: 1,
      getBrowserAttentionGeneration: () => 1,
      browserAttentionGeneration: 1,
      setActiveWorkspace,
      createWorkspaceObservationWait: () => ({
        promise: new Promise<boolean>((resolve) => {
          resolveObservation = resolve;
        }),
        cancel: vi.fn(),
      }),
      switchConversation,
    });

    await vi.waitFor(() => expect(activeWorkspaceId).toBe('workspace-b'));
    activeWorkspaceId = 'workspace-c';
    resolveObservation(true);

    await expect(opening).resolves.toBe(false);
    expect(switchConversation).not.toHaveBeenCalled();
    expect(setActiveWorkspace).toHaveBeenLastCalledWith('workspace-a', 'workspace-b', 'rollback');
    expect(activeWorkspaceId).toBe('workspace-c');
  });

  it('rolls back workspace and destination metadata when conversation activation fails', async () => {
    let activeWorkspaceId = 'workspace-a';
    let destinationConversationId: string | null = 'chat-b-previous';
    const saveLastConversation = vi.fn(
      async ({
        conversationId,
        expectedCurrentConversationId,
      }: {
        conversationId: string | null;
        expectedCurrentConversationId?: string | null;
      }) => {
        if (
          expectedCurrentConversationId !== undefined &&
          expectedCurrentConversationId !== destinationConversationId
        ) {
          return { ok: false, error: 'last-conversation-changed' as const };
        }
        const previousConversationId = destinationConversationId;
        destinationConversationId = conversationId;
        return { ok: true, previousConversationId, lastActiveConversationId: conversationId };
      },
    );
    const setActiveWorkspace = vi.fn(
      async (workspaceId: string | null, expectedWorkspaceId: string | null, operation: 'navigate' | 'rollback') => {
        if (activeWorkspaceId !== expectedWorkspaceId) return { ok: false, activeWorkspaceId };
        const previousWorkspaceId = activeWorkspaceId;
        activeWorkspaceId = workspaceId ?? '';
        return operation === 'navigate' ? { ok: true, previousWorkspaceId } : true;
      },
    );
    const switchConversation = vi.fn(async () => false);

    await expect(
      openBrowserConversationInWorkspace({
        conversationId: 'chat-b',
        selectionGeneration: 1,
        getConversation: async () => ({ workspaceId: 'workspace-b' }),
        getActiveConversationId: () => 'chat-a',
        getBackendActiveConversationId: async () => 'chat-a',
        getSelectionGeneration: () => 1,
        getActiveWorkspaceId: () => activeWorkspaceId,
        getKnownWorkspaceIds: () => ['workspace-a', 'workspace-b'],
        saveLastConversation,
        getWorkspaceSelectionGeneration: () => 1,
        workspaceSelectionGeneration: 1,
        getBrowserAttentionGeneration: () => 1,
        browserAttentionGeneration: 1,
        setActiveWorkspace,
        createWorkspaceObservationWait: () => ({ promise: Promise.resolve(true), cancel: vi.fn() }),
        switchConversation,
      }),
    ).resolves.toBe(false);

    expect(switchConversation).toHaveBeenCalledWith('chat-b', 'chat-a', 1);
    expect(setActiveWorkspace).toHaveBeenLastCalledWith('workspace-a', 'workspace-b', 'rollback');
    expect(activeWorkspaceId).toBe('workspace-a');
    expect(destinationConversationId).toBe('chat-b-previous');
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
      getBackendActiveConversationId: async () => activeConversationId,
      getSelectionGeneration: () => selectionGeneration,
      getActiveWorkspaceId: () => activeWorkspaceId,
      getKnownWorkspaceIds: () => ['workspace-a', 'workspace-b'],
      saveLastConversation: async () => undefined,
      getWorkspaceSelectionGeneration: () => 1,
      workspaceSelectionGeneration: 1,
      getBrowserAttentionGeneration: () => 1,
      browserAttentionGeneration: 1,
      setActiveWorkspace,
      createWorkspaceObservationWait: () => ({ promise: new Promise<boolean>(() => undefined), cancel: vi.fn() }),
      switchConversation: vi.fn(async () => true),
    });

    await vi.waitFor(() => expect(setActiveWorkspace).toHaveBeenCalledWith('workspace-b', 'workspace-a', 'navigate'));
    selectionGeneration++;
    resolveWorkspaceSwitch();

    await expect(opening).resolves.toBe(false);
    expect(setActiveWorkspace).toHaveBeenLastCalledWith('workspace-a', 'workspace-b', 'rollback');
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
      getBackendActiveConversationId: async () => activeConversationId,
      getSelectionGeneration: () => selectionGeneration,
      getActiveWorkspaceId: () => 'workspace-a',
      getKnownWorkspaceIds: () => ['workspace-a'],
      saveLastConversation: async () => undefined,
      getWorkspaceSelectionGeneration: () => 0,
      workspaceSelectionGeneration: 0,
      getBrowserAttentionGeneration: () => selectionGeneration,
      browserAttentionGeneration: 0,
      setActiveWorkspace: async () => true,
      createWorkspaceObservationWait: () => ({ promise: Promise.resolve(true), cancel: vi.fn() }),
      switchConversation,
    };

    const first = openBrowserConversationInWorkspace({
      ...common,
      conversationId: 'chat-b',
      selectionGeneration: ++selectionGeneration,
      browserAttentionGeneration: selectionGeneration,
    });
    const second = openBrowserConversationInWorkspace({
      ...common,
      conversationId: 'chat-c',
      selectionGeneration: ++selectionGeneration,
      browserAttentionGeneration: selectionGeneration,
    });

    await expect(second).resolves.toBe(true);
    resolveFirstConversation({ workspaceId: 'workspace-a' });
    await expect(first).resolves.toBe(false);
    expect(switchConversation).toHaveBeenCalledOnce();
    expect(switchConversation).toHaveBeenCalledWith('chat-c', 'chat-a', 2);
  });

  it('does not let an older Browser-attention request roll back the newer request workspace', async () => {
    let activeWorkspaceId = 'workspace-a';
    let activeConversationId = 'chat-a';
    let selectionGeneration = 1;
    let browserAttentionGeneration = 1;
    let resolveOldObservation: (observed: boolean) => void = () => {};
    let resolveNewConversation: (conversation: { workspaceId: string }) => void = () => {};
    const setActiveWorkspace = vi.fn(
      async (workspaceId: string | null, _expected: string | null, _operation: 'navigate' | 'rollback') => {
        activeWorkspaceId = workspaceId ?? '';
        return true;
      },
    );
    const common = {
      getActiveConversationId: () => activeConversationId,
      getBackendActiveConversationId: async () => activeConversationId,
      getSelectionGeneration: () => selectionGeneration,
      getActiveWorkspaceId: () => activeWorkspaceId,
      getKnownWorkspaceIds: () => ['workspace-a', 'workspace-b', 'workspace-c'],
      saveLastConversation: async () => undefined,
      getWorkspaceSelectionGeneration: () => 1,
      workspaceSelectionGeneration: 1,
      getBrowserAttentionGeneration: () => browserAttentionGeneration,
      setActiveWorkspace,
      switchConversation: vi.fn(async (conversationId: string) => {
        activeConversationId = conversationId;
        return true;
      }),
    };

    const oldOpening = openBrowserConversationInWorkspace({
      ...common,
      conversationId: 'chat-b',
      selectionGeneration,
      browserAttentionGeneration,
      getConversation: async () => ({ workspaceId: 'workspace-b' }),
      createWorkspaceObservationWait: () => ({
        promise: new Promise<boolean>((resolve) => {
          resolveOldObservation = resolve;
        }),
        cancel: vi.fn(),
      }),
    });
    await vi.waitFor(() => expect(setActiveWorkspace).toHaveBeenCalledWith('workspace-b', 'workspace-a', 'navigate'));

    selectionGeneration = 2;
    browserAttentionGeneration = 2;
    const newOpening = openBrowserConversationInWorkspace({
      ...common,
      conversationId: 'chat-c',
      selectionGeneration,
      browserAttentionGeneration,
      getConversation: () =>
        new Promise<{ workspaceId: string }>((resolve) => {
          resolveNewConversation = resolve;
        }),
      createWorkspaceObservationWait: () => ({ promise: Promise.resolve(true), cancel: vi.fn() }),
    });

    resolveOldObservation(true);
    await expect(oldOpening).resolves.toBe(false);
    expect(setActiveWorkspace).toHaveBeenCalledTimes(1);
    expect(activeWorkspaceId).toBe('workspace-b');

    resolveNewConversation({ workspaceId: 'workspace-c' });
    await expect(newOpening).resolves.toBe(true);
    expect(setActiveWorkspace).toHaveBeenNthCalledWith(2, 'workspace-c', 'workspace-b', 'navigate');
    expect(activeWorkspaceId).toBe('workspace-c');
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
      getBackendActiveConversationId: async () => activeConversationId,
      getSelectionGeneration: () => selectionGeneration,
      getActiveWorkspaceId: () => activeWorkspaceId,
      getKnownWorkspaceIds: () => ['workspace-a', 'workspace-b'],
      saveLastConversation: async () => undefined,
      getWorkspaceSelectionGeneration: () => workspaceSelectionGeneration,
      workspaceSelectionGeneration,
      getBrowserAttentionGeneration: () => 1,
      browserAttentionGeneration: 1,
      setActiveWorkspace,
      createWorkspaceObservationWait: () => ({
        promise: new Promise<boolean>((resolve) => {
          resolveObservation = resolve;
        }),
        cancel: vi.fn(),
      }),
      switchConversation,
    });

    await vi.waitFor(() => expect(setActiveWorkspace).toHaveBeenCalledWith('workspace-b', 'workspace-a', 'navigate'));
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
    expect(saveLastConversation).toHaveBeenCalledWith({ workspaceId: 'workspace-b', conversationId: 'chat-b' });
    expect(setActiveWorkspace).toHaveBeenCalledWith('workspace-b', 'workspace-b', 'navigate');

    resolveObservation(true);
    await expect(preparation).resolves.toBe(true);
    expect(cancelObservation).toHaveBeenCalledOnce();
  });

  it('discards the exact Browser transition when workspace observation fails', async () => {
    const discardActiveWorkspaceTransition = vi.fn();

    await expect(
      prepareConversationWorkspaceSwitch({
        conversationId: 'chat-b',
        conversationWorkspaceId: 'workspace-b',
        activeWorkspaceId: 'workspace-a',
        knownWorkspaceIds: ['workspace-a', 'workspace-b'],
        saveLastConversation: async () => undefined,
        setActiveWorkspace: async () => true,
        createWorkspaceObservationWait: () => ({ promise: Promise.resolve(false), cancel: vi.fn() }),
        discardActiveWorkspaceTransition,
      }),
    ).resolves.toBe(false);

    expect(discardActiveWorkspaceTransition).toHaveBeenCalledWith('workspace-b');
  });

  it('rolls a stale authoritative rebase back to the workspace actually replaced', async () => {
    const setActiveWorkspace = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, previousWorkspaceId: 'workspace-authoritative' })
      .mockResolvedValueOnce(true);

    await expect(
      prepareConversationWorkspaceSwitch({
        conversationId: 'chat-a',
        conversationWorkspaceId: 'workspace-a',
        activeWorkspaceId: 'workspace-a',
        knownWorkspaceIds: ['workspace-a', 'workspace-authoritative'],
        saveLastConversation: async () => undefined,
        setActiveWorkspace,
        createWorkspaceObservationWait: () => ({ promise: Promise.resolve(true), cancel: vi.fn() }),
        isCurrent: () => true,
        isCurrentAfterSwitch: () => false,
        canRollbackStaleSwitch: () => true,
      }),
    ).resolves.toBe(false);

    expect(setActiveWorkspace).toHaveBeenNthCalledWith(1, 'workspace-a', 'workspace-a', 'navigate');
    expect(setActiveWorkspace).toHaveBeenNthCalledWith(2, 'workspace-authoritative', 'workspace-a', 'rollback');
  });

  it('waits for the departing-workspace effect before the caller selects the destination chat', async () => {
    const calls: string[] = [];
    const lastConversation = new Map<string, string | null>();
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

  it('restores destination metadata when navigation loses ownership before switching workspaces', async () => {
    let current = true;
    let lastConversation: string | null = 'chat-b-previous';
    const saveLastConversation = vi.fn(
      async ({
        conversationId,
        expectedCurrentConversationId,
      }: {
        conversationId: string | null;
        expectedCurrentConversationId?: string | null;
      }) => {
        const previousConversationId = lastConversation;
        if (expectedCurrentConversationId !== undefined && expectedCurrentConversationId !== lastConversation) {
          return {
            ok: false,
            error: 'last-conversation-changed' as const,
            lastActiveConversationId: lastConversation,
          };
        }
        lastConversation = conversationId;
        if (expectedCurrentConversationId === undefined) current = false;
        return { ok: true, previousConversationId, lastActiveConversationId: conversationId };
      },
    );
    const setActiveWorkspace = vi.fn(async () => true);

    await expect(
      prepareConversationWorkspaceSwitch({
        conversationId: 'chat-b-canceled',
        conversationWorkspaceId: 'workspace-b',
        activeWorkspaceId: 'workspace-a',
        knownWorkspaceIds: ['workspace-a', 'workspace-b'],
        saveLastConversation,
        setActiveWorkspace,
        createWorkspaceObservationWait: () => ({ promise: Promise.resolve(true), cancel: vi.fn() }),
        isCurrent: () => current,
      }),
    ).resolves.toBe(false);

    expect(lastConversation).toBe('chat-b-previous');
    expect(setActiveWorkspace).not.toHaveBeenCalled();
    expect(saveLastConversation).toHaveBeenNthCalledWith(1, {
      workspaceId: 'workspace-b',
      conversationId: 'chat-b-canceled',
    });
    expect(saveLastConversation).toHaveBeenNthCalledWith(2, {
      workspaceId: 'workspace-b',
      conversationId: 'chat-b-previous',
      expectedCurrentConversationId: 'chat-b-canceled',
    });
  });

  it('does not overwrite newer destination metadata while undoing canceled navigation', async () => {
    let current = true;
    let lastConversation: string | null = 'chat-b-previous';
    const saveLastConversation = vi.fn(
      async ({
        conversationId,
        expectedCurrentConversationId,
      }: {
        conversationId: string | null;
        expectedCurrentConversationId?: string | null;
      }) => {
        const previousConversationId = lastConversation;
        if (expectedCurrentConversationId !== undefined && expectedCurrentConversationId !== lastConversation) {
          return {
            ok: false,
            error: 'last-conversation-changed' as const,
            lastActiveConversationId: lastConversation,
          };
        }
        lastConversation = conversationId;
        if (expectedCurrentConversationId === undefined) {
          current = false;
          // Model a newer request updating the same workspace before the
          // canceled request's continuation gets a chance to undo its write.
          lastConversation = 'chat-b-newer';
        }
        return { ok: true, previousConversationId, lastActiveConversationId: conversationId };
      },
    );

    await expect(
      prepareConversationWorkspaceSwitch({
        conversationId: 'chat-b-canceled',
        conversationWorkspaceId: 'workspace-b',
        activeWorkspaceId: 'workspace-a',
        knownWorkspaceIds: ['workspace-a', 'workspace-b'],
        saveLastConversation,
        setActiveWorkspace: vi.fn(async () => true),
        createWorkspaceObservationWait: () => ({ promise: Promise.resolve(true), cancel: vi.fn() }),
        isCurrent: () => current,
      }),
    ).resolves.toBe(false);

    expect(lastConversation).toBe('chat-b-newer');
    expect(saveLastConversation).toHaveBeenLastCalledWith({
      workspaceId: 'workspace-b',
      conversationId: 'chat-b-previous',
      expectedCurrentConversationId: 'chat-b-canceled',
    });
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
