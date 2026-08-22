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
  isRedundantActiveConversationBroadcast,
  isConversationWorkspaceRestorationCurrent,
  openBrowserConversationInWorkspace,
  prepareConversationWorkspaceSwitch,
  resolveConversationActivationDisposition,
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

const activeConversationState = (activeConversationId: string | null, activeConversationRevision = 1) => ({
  activeConversationId,
  activeConversationRevision,
});

describe('resolveConversationActivationDisposition', () => {
  const current = {
    sequence: 4,
    currentSequence: 4,
    conversationId: 'chat-b',
    currentConversationId: 'chat-b',
    conversationSelectionGeneration: 3,
    currentConversationSelectionGeneration: 3,
    navigationGeneration: 7,
    currentNavigationGeneration: 7,
  };

  it('keeps a successful selection while suppressing stale foreground navigation', () => {
    expect(resolveConversationActivationDisposition(current)).toBe('foreground');
    expect(resolveConversationActivationDisposition({ ...current, currentNavigationGeneration: 8 })).toBe('background');
  });

  it('drops an activation superseded by a newer conversation selection', () => {
    expect(resolveConversationActivationDisposition({ ...current, currentSequence: 5 })).toBe('superseded');
    expect(resolveConversationActivationDisposition({ ...current, currentConversationId: 'chat-c' })).toBe(
      'superseded',
    );
    expect(resolveConversationActivationDisposition({ ...current, currentConversationSelectionGeneration: 4 })).toBe(
      'superseded',
    );
  });
});

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

  it('advances the workspace cursor after a newer destination chat retains a stale switch', () => {
    const retained = resolveConversationWorkspaceTransition({
      previousWorkspaceId: 'workspace-a',
      activeWorkspaceId: 'workspace-b',
      currentConversationId: 'chat-b-newer',
      browserTransition: {
        navigationGeneration: 2,
        browserAttentionGeneration: 1,
        workspaceSelectionGeneration: 7,
        suppressArrivingWorkspaceRestoration: true,
        operation: 'navigate',
        departingWorkspaceId: 'workspace-a',
        destinationWorkspaceId: 'workspace-b',
        departingConversationId: 'chat-a',
      },
      currentNavigationGeneration: 2,
      currentBrowserAttentionGeneration: 1,
      currentWorkspaceSelectionGeneration: 7,
    });

    expect(retained).toEqual({
      staleBrowserTransition: false,
      suppressArrivingWorkspaceRestoration: true,
      departingWorkspaceId: 'workspace-a',
      departingConversationId: 'chat-a',
      nextPreviousWorkspaceId: 'workspace-b',
    });

    expect(
      resolveConversationWorkspaceTransition({
        previousWorkspaceId: retained.nextPreviousWorkspaceId,
        activeWorkspaceId: 'workspace-c',
        currentConversationId: 'chat-b-newer',
        currentNavigationGeneration: 3,
        currentBrowserAttentionGeneration: 1,
        currentWorkspaceSelectionGeneration: 8,
      }),
    ).toEqual({
      staleBrowserTransition: false,
      suppressArrivingWorkspaceRestoration: false,
      departingWorkspaceId: 'workspace-b',
      departingConversationId: 'chat-b-newer',
      nextPreviousWorkspaceId: 'workspace-c',
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

  it('does not create a marker for same-workspace operations and preserves rollback provenance', () => {
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
        departingConversationId: 'chat-a',
      }),
    ).toEqual({
      navigationGeneration: 1,
      browserAttentionGeneration: 1,
      workspaceSelectionGeneration: 2,
      operation: 'rollback',
      departingWorkspaceId: 'workspace-b',
      destinationWorkspaceId: 'workspace-a',
      departingConversationId: null,
      suppressArrivingWorkspaceRestoration: true,
    });
  });

  it('does not save or restore conversations while observing a Browser rollback', () => {
    const rollback = createBrowserWorkspaceTransitionMarker({
      navigationGeneration: 3,
      browserAttentionGeneration: 2,
      workspaceSelectionGeneration: 7,
      operation: 'rollback',
      departingWorkspaceId: 'workspace-b',
      destinationWorkspaceId: 'workspace-a',
      departingConversationId: 'chat-a',
    });

    expect(
      resolveConversationWorkspaceTransition({
        previousWorkspaceId: 'workspace-b',
        activeWorkspaceId: 'workspace-a',
        currentConversationId: 'chat-a',
        browserTransition: rollback,
        currentNavigationGeneration: 3,
        currentBrowserAttentionGeneration: 2,
        currentWorkspaceSelectionGeneration: 7,
      }),
    ).toEqual({
      staleBrowserTransition: false,
      suppressArrivingWorkspaceRestoration: true,
      departingWorkspaceId: 'workspace-b',
      departingConversationId: null,
      nextPreviousWorkspaceId: 'workspace-a',
    });
  });
});

describe('rollbackUnavailableWorkspaceRestoration', () => {
  it('CAS-restores the prior backend selection while the restoration still owns navigation', async () => {
    const setActiveId = vi.fn(async () => ({ ok: true }));

    await expect(
      rollbackUnavailableWorkspaceRestoration({
        restoredConversationId: 'chat-b',
        restoredConversationRevision: 12,
        previousConversationId: 'chat-a',
        isCurrent: () => true,
        setActiveId,
      }),
    ).resolves.toBe(true);

    expect(setActiveId).toHaveBeenCalledWith('chat-a', 'chat-b', 12);
  });

  it('does not overwrite a newer renderer selection', async () => {
    const setActiveId = vi.fn(async () => ({ ok: true }));

    await expect(
      rollbackUnavailableWorkspaceRestoration({
        restoredConversationId: 'chat-b',
        restoredConversationRevision: 12,
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
      activeConversationRevision: 9,
    }));

    await expect(
      setActiveConversationForWorkspaceRestoration({
        conversationId: 'chat-b',
        expectedCurrentConversationId: 'chat-a',
        expectedCurrentConversationRevision: 8,
        isCurrent: () => true,
        setActiveId,
      }),
    ).resolves.toEqual({ ok: true, activeConversationId: 'chat-b', activeConversationRevision: 9 });

    expect(setActiveId).toHaveBeenCalledOnce();
    expect(setActiveId).toHaveBeenCalledWith('chat-b', 'chat-a', 8);
  });

  it('does not coalesce a target-id match without an authoritative revision', async () => {
    const stale = {
      ok: false,
      error: 'active-conversation-changed' as const,
      activeConversationId: 'chat-b',
    };
    const setActiveId = vi.fn(async () => stale);

    await expect(
      setActiveConversationForWorkspaceRestoration({
        conversationId: 'chat-b',
        expectedCurrentConversationId: 'chat-a',
        expectedCurrentConversationRevision: 8,
        isCurrent: () => true,
        setActiveId,
      }),
    ).resolves.toBe(stale);
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
        expectedCurrentConversationRevision: 8,
        isCurrent: () => true,
        setActiveId,
        waitForRetry,
      }),
    ).resolves.toEqual({ ok: true });

    expect(setActiveId).toHaveBeenCalledTimes(3);
    expect(setActiveId).toHaveBeenNthCalledWith(3, 'chat-b', 'chat-a', 8);
    expect(waitForRetry.mock.calls).toEqual([[25], [75]]);
  });

  it('stops retrying as soon as a newer selection intent wins', async () => {
    let current = true;
    const setActiveId = vi.fn(async () => ({ ok: false, error: 'conversation-unavailable' as const }));

    await expect(
      setActiveConversationForWorkspaceRestoration({
        conversationId: 'chat-b',
        expectedCurrentConversationId: 'chat-a',
        expectedCurrentConversationRevision: 8,
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
        expectedCurrentConversationRevision: 8,
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
        mutationToken: 'local-user_request-1',
        setActiveWorkspace,
        isCurrent: () => true,
        canRebase: (result) => result.activeWorkspaceMutationToken?.startsWith('local-browser_') === true,
      }),
    ).resolves.toEqual({ ok: true, activeWorkspaceId: 'workspace-user' });

    expect(setActiveWorkspace).toHaveBeenNthCalledWith(1, 'workspace-user', 'workspace-a', 'local-user_request-1');
    expect(setActiveWorkspace).toHaveBeenNthCalledWith(
      2,
      'workspace-user',
      'workspace-browser',
      'local-user_request-1',
      'local-browser_request-1',
    );
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
      mutationToken: 'local-user_request-2',
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
      mutationToken: 'local-user_request-3',
      setActiveWorkspace: foreignConflict,
      isCurrent: () => true,
      canRebase: (result) => result.activeWorkspaceMutationToken?.startsWith('local-browser_') === true,
    });
    expect(foreignConflict).toHaveBeenCalledOnce();
  });

  it('rolls back its exact workspace mutation when a newer intent wins during the CAS', async () => {
    let current = true;
    let activeWorkspaceId = 'workspace-a';
    const setActiveWorkspace = vi.fn(
      async (
        workspaceId: string | null,
        expectedCurrentWorkspaceId: string | null,
        mutationToken: string,
        expectedCurrentMutationToken?: string,
      ) => {
        expect(activeWorkspaceId).toBe(expectedCurrentWorkspaceId);
        if (expectedCurrentMutationToken !== undefined) expect(expectedCurrentMutationToken).toBe(mutationToken);
        activeWorkspaceId = workspaceId ?? '';
        if (workspaceId === 'workspace-b') current = false;
        return { ok: true, activeWorkspaceId };
      },
    );

    await expect(
      setActiveUserWorkspaceWithRebase({
        workspaceId: 'workspace-b',
        expectedCurrentWorkspaceId: 'workspace-a',
        mutationToken: 'local-user_request-stale',
        setActiveWorkspace,
        isCurrent: () => current,
        canRebase: () => true,
      }),
    ).resolves.toMatchObject({ ok: false, activeWorkspaceId: 'workspace-a' });

    expect(setActiveWorkspace).toHaveBeenNthCalledWith(1, 'workspace-b', 'workspace-a', 'local-user_request-stale');
    expect(setActiveWorkspace).toHaveBeenNthCalledWith(
      2,
      'workspace-a',
      'workspace-b',
      'local-user_request-stale',
      'local-user_request-stale',
    );
    expect(activeWorkspaceId).toBe('workspace-a');
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
        activeWorkspaceMutationToken: 'local-browser_request-1',
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
      'local-browser_request-1',
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
      conversationSelectionGeneration: selectionGeneration,
      workspaceMutationToken: 'browser_request-test',
      getConversation,
      getActiveConversationId: () => activeConversationId,
      getBackendActiveConversationState: async () => activeConversationState(activeConversationId),
      getSelectionGeneration: () => selectionGeneration,
      getConversationSelectionGeneration: () => selectionGeneration,
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
    expect(saveLastConversation).toHaveBeenCalledWith({
      workspaceId: 'workspace-b',
      conversationId: 'chat-b',
      mutationToken: 'browser_request-test',
    });
    expect(setActiveWorkspace).toHaveBeenCalledWith('workspace-b', 'workspace-b', 'navigate');
    expect(switchConversation).toHaveBeenCalledWith('chat-b', 'chat-a', selectionGeneration, 1, selectionGeneration);
    expect(cancelObservation).toHaveBeenCalledOnce();
  });

  it('uses the backend active conversation as the selection compare-and-set snapshot', async () => {
    const switchConversation = vi.fn(async () => true);

    await expect(
      openBrowserConversationInWorkspace({
        conversationId: 'chat-browser',
        selectionGeneration: 1,
        conversationSelectionGeneration: 1,
        workspaceMutationToken: 'browser_request-test',
        getConversation: async () => ({ workspaceId: 'workspace-a' }),
        getActiveConversationId: () => 'chat-renderer',
        getBackendActiveConversationState: async () => activeConversationState('chat-backend', 42),
        getSelectionGeneration: () => 1,
        getConversationSelectionGeneration: () => 1,
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

    expect(switchConversation).toHaveBeenCalledWith('chat-browser', 'chat-backend', 1, 42, 1);
  });

  it('adopts a pending workspace transition when the target is already selected', async () => {
    const adoptActiveWorkspaceTransition = vi.fn();
    const setActiveWorkspace = vi.fn(async () => true);
    const switchConversation = vi.fn(async () => true);

    await expect(
      openBrowserConversationInWorkspace({
        conversationId: 'chat-b',
        selectionGeneration: 2,
        conversationSelectionGeneration: 2,
        workspaceMutationToken: 'browser_request-test',
        getConversation: async () => ({ workspaceId: 'workspace-b' }),
        getActiveConversationId: () => 'chat-b',
        getBackendActiveConversationState: async () => activeConversationState('chat-b'),
        getSelectionGeneration: () => 2,
        getConversationSelectionGeneration: () => 2,
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
        conversationSelectionGeneration: 2,
        workspaceMutationToken: 'browser_request-test',
        getConversation: async () => ({ workspaceId: 'workspace-b' }),
        getActiveConversationId: () => 'chat-a',
        getBackendActiveConversationState: async () => activeConversationState('chat-a'),
        getSelectionGeneration: () => 2,
        getConversationSelectionGeneration: () => 2,
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
    expect(switchConversation).toHaveBeenCalledWith('chat-b', 'chat-a', 2, 1, 2);
  });

  it('does not let a delayed older request adopt a newer transition', async () => {
    const adoptActiveWorkspaceTransition = vi.fn();

    await expect(
      openBrowserConversationInWorkspace({
        conversationId: 'chat-b',
        selectionGeneration: 1,
        conversationSelectionGeneration: 1,
        workspaceMutationToken: 'browser_request-test',
        getConversation: async () => ({ workspaceId: 'workspace-b' }),
        getActiveConversationId: () => 'chat-b',
        getBackendActiveConversationState: async () => activeConversationState('chat-b'),
        getSelectionGeneration: () => 2,
        getConversationSelectionGeneration: () => 2,
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
    const setActiveWorkspace = vi.fn(async (workspaceId: string | null) => {
      activeWorkspaceId = workspaceId ?? '';
      return true;
    });
    const saveLastConversation = vi.fn(async () => ({
      ok: true,
      previousConversationId: 'chat-b-previous',
      lastActiveConversationId: 'chat-b',
    }));
    const switchConversation = vi.fn(async () => true);
    const cancelObservation = vi.fn();

    await expect(
      openBrowserConversationInWorkspace({
        conversationId: 'chat-a',
        selectionGeneration: 1,
        conversationSelectionGeneration: 1,
        workspaceMutationToken: 'browser_request-test',
        getConversation: async () => ({ workspaceId: 'workspace-a' }),
        getActiveConversationId: () => 'chat-a',
        getBackendActiveConversationState: async () => activeConversationState('chat-a'),
        getSelectionGeneration: () => 1,
        getConversationSelectionGeneration: () => 1,
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

    expect(saveLastConversation).toHaveBeenCalledWith({
      workspaceId: 'workspace-a',
      conversationId: 'chat-a',
      mutationToken: 'browser_request-test',
    });
    expect(setActiveWorkspace).toHaveBeenCalledWith('workspace-a', 'workspace-b', 'navigate');
    expect(switchConversation).not.toHaveBeenCalled();
    expect(cancelObservation).toHaveBeenCalledOnce();
  });

  it('keeps the destination workspace after a newer destination-workspace conversation selection', async () => {
    let activeWorkspaceId = 'workspace-a';
    let activeConversationId = 'chat-a';
    let selectionGeneration = 1;
    let conversationSelectionGeneration = 1;
    let resolveObservation: (observed: boolean) => void = () => {};
    const workspaceSelectionGeneration = 1;
    const setActiveWorkspace = vi.fn(async (workspaceId: string | null) => {
      activeWorkspaceId = workspaceId ?? '';
      return true;
    });
    const saveLastConversation = vi.fn(async () => ({
      ok: true,
      previousConversationId: 'chat-b-previous',
      lastActiveConversationId: 'chat-b',
    }));
    const switchConversation = vi.fn(async () => true);
    const retainActiveWorkspaceTransition = vi.fn();

    const opening = openBrowserConversationInWorkspace({
      conversationId: 'chat-b',
      selectionGeneration,
      conversationSelectionGeneration,
      workspaceMutationToken: 'browser_request-test',
      getConversation: async () => ({ workspaceId: 'workspace-b' }),
      getActiveConversationId: () => activeConversationId,
      getBackendActiveConversationState: async () => activeConversationState(activeConversationId),
      getSelectionGeneration: () => selectionGeneration,
      getConversationSelectionGeneration: () => conversationSelectionGeneration,
      getActiveWorkspaceId: () => activeWorkspaceId,
      getKnownWorkspaceIds: () => ['workspace-a', 'workspace-b'],
      saveLastConversation,
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
      retainActiveWorkspaceTransition,
      switchConversation,
    });

    await vi.waitFor(() => expect(setActiveWorkspace).toHaveBeenCalledWith('workspace-b', 'workspace-a', 'navigate'));
    activeConversationId = 'chat-user-choice';
    selectionGeneration++;
    conversationSelectionGeneration++;
    resolveObservation(true);

    await expect(opening).resolves.toBe(false);
    expect(switchConversation).not.toHaveBeenCalled();
    expect(setActiveWorkspace).toHaveBeenCalledOnce();
    expect(activeWorkspaceId).toBe('workspace-b');
    expect(retainActiveWorkspaceTransition).toHaveBeenCalledOnce();
    expect(retainActiveWorkspaceTransition).toHaveBeenCalledWith('workspace-b');
    expect(saveLastConversation).toHaveBeenCalledOnce();
    expect(saveLastConversation).toHaveBeenCalledWith({
      workspaceId: 'workspace-b',
      conversationId: 'chat-b',
      mutationToken: 'browser_request-test',
    });
  });

  it('rolls back after a newer source-workspace conversation selection', async () => {
    let activeWorkspaceId = 'workspace-a';
    let activeConversationId = 'chat-a';
    let selectionGeneration = 1;
    let conversationSelectionGeneration = 1;
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
      conversationSelectionGeneration,
      workspaceMutationToken: 'browser_request-test',
      getConversation: async (conversationId) => ({
        workspaceId: conversationId === 'chat-b' ? 'workspace-b' : 'workspace-a',
      }),
      getActiveConversationId: () => activeConversationId,
      getBackendActiveConversationState: async () => activeConversationState(activeConversationId),
      getSelectionGeneration: () => selectionGeneration,
      getConversationSelectionGeneration: () => conversationSelectionGeneration,
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
    activeConversationId = 'chat-a-newer';
    selectionGeneration++;
    conversationSelectionGeneration++;
    resolveObservation(true);

    await expect(opening).resolves.toBe(false);
    expect(switchConversation).not.toHaveBeenCalled();
    expect(setActiveWorkspace).toHaveBeenLastCalledWith(
      'workspace-a',
      'workspace-b',
      'rollback',
      'browser_request-test',
    );
    expect(activeWorkspaceId).toBe('workspace-a');
  });

  it('uses the latest stable chat workspace when selection changes during rollback lookup', async () => {
    let activeWorkspaceId = 'workspace-a';
    let activeConversationId = 'chat-a';
    let selectionGeneration = 1;
    let conversationSelectionGeneration = 1;
    let resolveObservation: (observed: boolean) => void = () => {};
    let resolveFirstSelectionLookup: (conversation: { workspaceId: string }) => void = () => {};
    let firstSelectionLookupStarted = false;
    const setActiveWorkspace = vi.fn(async (workspaceId: string | null) => {
      activeWorkspaceId = workspaceId ?? '';
      return true;
    });

    const opening = openBrowserConversationInWorkspace({
      conversationId: 'chat-b',
      selectionGeneration,
      conversationSelectionGeneration,
      workspaceMutationToken: 'browser_request-test',
      getConversation: (conversationId) => {
        if (conversationId === 'chat-b') return Promise.resolve({ workspaceId: 'workspace-b' });
        if (conversationId === 'chat-b-newer') {
          return new Promise<{ workspaceId: string }>((resolve) => {
            firstSelectionLookupStarted = true;
            resolveFirstSelectionLookup = resolve;
          });
        }
        return Promise.resolve({ workspaceId: 'workspace-a' });
      },
      getActiveConversationId: () => activeConversationId,
      getBackendActiveConversationState: async () => activeConversationState(activeConversationId),
      getSelectionGeneration: () => selectionGeneration,
      getConversationSelectionGeneration: () => conversationSelectionGeneration,
      getActiveWorkspaceId: () => activeWorkspaceId,
      getKnownWorkspaceIds: () => ['workspace-a', 'workspace-b'],
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
      switchConversation: vi.fn(async () => true),
    });

    await vi.waitFor(() => expect(setActiveWorkspace).toHaveBeenCalledWith('workspace-b', 'workspace-a', 'navigate'));
    activeConversationId = 'chat-b-newer';
    selectionGeneration++;
    conversationSelectionGeneration++;
    resolveObservation(true);
    await vi.waitFor(() => expect(firstSelectionLookupStarted).toBe(true));
    activeConversationId = 'chat-a-latest';
    selectionGeneration++;
    conversationSelectionGeneration++;
    resolveFirstSelectionLookup({ workspaceId: 'workspace-b' });

    await expect(opening).resolves.toBe(false);
    expect(setActiveWorkspace).toHaveBeenLastCalledWith(
      'workspace-a',
      'workspace-b',
      'rollback',
      'browser_request-test',
    );
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
      conversationSelectionGeneration: 1,
      workspaceMutationToken: 'browser_request-test',
      getConversation: async () => ({ workspaceId: 'workspace-b' }),
      getActiveConversationId: () => activeConversationId,
      getBackendActiveConversationState: async () => activeConversationState(activeConversationId),
      getSelectionGeneration: () => 1,
      getConversationSelectionGeneration: () => 1,
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
    expect(setActiveWorkspace).toHaveBeenLastCalledWith(
      'workspace-a',
      'workspace-b',
      'rollback',
      'browser_request-test',
    );
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
        conversationSelectionGeneration: 1,
        workspaceMutationToken: 'browser_request-test',
        getConversation: async () => ({ workspaceId: 'workspace-b' }),
        getActiveConversationId: () => 'chat-a',
        getBackendActiveConversationState: async () => activeConversationState('chat-a'),
        getSelectionGeneration: () => 1,
        getConversationSelectionGeneration: () => 1,
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

    expect(switchConversation).toHaveBeenCalledWith('chat-b', 'chat-a', 1, 1, 1);
    expect(setActiveWorkspace).toHaveBeenLastCalledWith(
      'workspace-a',
      'workspace-b',
      'rollback',
      'browser_request-test',
    );
    expect(activeWorkspaceId).toBe('workspace-a');
    expect(destinationConversationId).toBe('chat-b-previous');
  });

  it('rolls back a workspace switch after newer view-only navigation', async () => {
    let activeWorkspaceId = 'workspace-a';
    const activeConversationId = 'chat-a';
    let selectionGeneration = 1;
    const conversationSelectionGeneration = 1;
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
      conversationSelectionGeneration,
      workspaceMutationToken: 'browser_request-test',
      getConversation: async () => ({ workspaceId: 'workspace-b' }),
      getActiveConversationId: () => activeConversationId,
      getBackendActiveConversationState: async () => activeConversationState(activeConversationId),
      getSelectionGeneration: () => selectionGeneration,
      getConversationSelectionGeneration: () => conversationSelectionGeneration,
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
    expect(setActiveWorkspace).toHaveBeenLastCalledWith(
      'workspace-a',
      'workspace-b',
      'rollback',
      'browser_request-test',
    );
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
      getBackendActiveConversationState: async () => activeConversationState(activeConversationId),
      getSelectionGeneration: () => selectionGeneration,
      getConversationSelectionGeneration: () => selectionGeneration,
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
      conversationSelectionGeneration: selectionGeneration,
      workspaceMutationToken: 'browser_request-test',
      browserAttentionGeneration: selectionGeneration,
    });
    const second = openBrowserConversationInWorkspace({
      ...common,
      conversationId: 'chat-c',
      selectionGeneration: ++selectionGeneration,
      conversationSelectionGeneration: selectionGeneration,
      workspaceMutationToken: 'browser_request-test',
      browserAttentionGeneration: selectionGeneration,
    });

    await expect(second).resolves.toBe(true);
    resolveFirstConversation({ workspaceId: 'workspace-a' });
    await expect(first).resolves.toBe(false);
    expect(switchConversation).toHaveBeenCalledOnce();
    expect(switchConversation).toHaveBeenCalledWith('chat-c', 'chat-a', 2, 1, 2);
  });

  it('rolls an older Browser transition back before the serialized successor mutates workspace state', async () => {
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
      getBackendActiveConversationState: async () => activeConversationState(activeConversationId),
      getSelectionGeneration: () => selectionGeneration,
      getConversationSelectionGeneration: () => selectionGeneration,
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
      conversationSelectionGeneration: selectionGeneration,
      workspaceMutationToken: 'browser_request-test',
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
      conversationSelectionGeneration: selectionGeneration,
      workspaceMutationToken: 'browser_request-test',
      browserAttentionGeneration,
      getConversation: () =>
        new Promise<{ workspaceId: string }>((resolve) => {
          resolveNewConversation = resolve;
        }),
      createWorkspaceObservationWait: () => ({ promise: Promise.resolve(true), cancel: vi.fn() }),
    });

    resolveOldObservation(true);
    await expect(oldOpening).resolves.toBe(false);
    expect(setActiveWorkspace).toHaveBeenCalledTimes(2);
    expect(setActiveWorkspace).toHaveBeenNthCalledWith(
      2,
      'workspace-a',
      'workspace-b',
      'rollback',
      'browser_request-test',
    );
    expect(activeWorkspaceId).toBe('workspace-a');

    resolveNewConversation({ workspaceId: 'workspace-c' });
    await expect(newOpening).resolves.toBe(true);
    expect(setActiveWorkspace).toHaveBeenNthCalledWith(3, 'workspace-c', 'workspace-a', 'navigate');
    expect(activeWorkspaceId).toBe('workspace-c');
  });

  it('rolls an older switch back when its newer Browser successor fails before adopting it', async () => {
    let activeWorkspaceId = 'workspace-a';
    const activeConversationId = 'chat-a';
    let selectionGeneration = 1;
    let conversationSelectionGeneration = 1;
    let browserAttentionGeneration = 1;
    let resolveOldObservation: (observed: boolean) => void = () => {};
    const setActiveWorkspace = vi.fn(
      async (workspaceId: string | null, expectedWorkspaceId: string | null, operation: 'navigate' | 'rollback') => {
        if (activeWorkspaceId !== expectedWorkspaceId) return { ok: false, activeWorkspaceId };
        const previousWorkspaceId = activeWorkspaceId;
        activeWorkspaceId = workspaceId ?? '';
        return operation === 'navigate' ? { ok: true, previousWorkspaceId } : true;
      },
    );
    const common = {
      getActiveConversationId: () => activeConversationId,
      getBackendActiveConversationState: async () => activeConversationState(activeConversationId),
      getSelectionGeneration: () => selectionGeneration,
      getConversationSelectionGeneration: () => conversationSelectionGeneration,
      getActiveWorkspaceId: () => activeWorkspaceId,
      getKnownWorkspaceIds: () => ['workspace-a', 'workspace-b'],
      saveLastConversation: async () => undefined,
      getWorkspaceSelectionGeneration: () => 1,
      workspaceSelectionGeneration: 1,
      getBrowserAttentionGeneration: () => browserAttentionGeneration,
      setActiveWorkspace,
      switchConversation: vi.fn(async () => true),
    };

    const oldOpening = openBrowserConversationInWorkspace({
      ...common,
      conversationId: 'chat-b',
      selectionGeneration,
      conversationSelectionGeneration,
      workspaceMutationToken: 'browser_request-test',
      browserAttentionGeneration,
      getConversation: async () => ({ workspaceId: 'workspace-b' }),
      createWorkspaceObservationWait: () => ({
        promise: new Promise<boolean>((resolve) => {
          resolveOldObservation = resolve;
        }),
        cancel: vi.fn(),
      }),
    });
    await vi.waitFor(() => expect(activeWorkspaceId).toBe('workspace-b'));

    selectionGeneration = 2;
    conversationSelectionGeneration = 2;
    browserAttentionGeneration = 2;
    await expect(
      openBrowserConversationInWorkspace({
        ...common,
        conversationId: 'missing-chat',
        selectionGeneration,
        conversationSelectionGeneration,
        workspaceMutationToken: 'browser_request-test',
        browserAttentionGeneration,
        getConversation: async () => null,
        createWorkspaceObservationWait: vi.fn(() => ({ promise: Promise.resolve(true), cancel: vi.fn() })),
      }),
    ).resolves.toBe(false);

    resolveOldObservation(false);
    await expect(oldOpening).resolves.toBe(false);
    expect(setActiveWorkspace).toHaveBeenLastCalledWith(
      'workspace-a',
      'workspace-b',
      'rollback',
      'browser_request-test',
    );
    expect(activeWorkspaceId).toBe('workspace-a');
  });

  it('serializes canceled same-destination cursor writes so both restore the original value', async () => {
    let activeWorkspaceId = 'workspace-a';
    const activeConversationId = 'chat-a';
    let selectionGeneration = 1;
    let conversationSelectionGeneration = 1;
    let browserAttentionGeneration = 1;
    let destinationConversationId: string | null = 'chat-b-original';
    const observationResolvers: Array<(observed: boolean) => void> = [];
    const getConversation = vi.fn(async () => ({ workspaceId: 'workspace-b' }));
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
          return {
            ok: false,
            error: 'last-conversation-changed' as const,
            lastActiveConversationId: destinationConversationId,
          };
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
    const common = {
      getConversation,
      getActiveConversationId: () => activeConversationId,
      getBackendActiveConversationState: async () => activeConversationState(activeConversationId),
      getSelectionGeneration: () => selectionGeneration,
      getConversationSelectionGeneration: () => conversationSelectionGeneration,
      getActiveWorkspaceId: () => activeWorkspaceId,
      getKnownWorkspaceIds: () => ['workspace-a', 'workspace-b'],
      saveLastConversation,
      getWorkspaceSelectionGeneration: () => 1,
      workspaceSelectionGeneration: 1,
      getBrowserAttentionGeneration: () => browserAttentionGeneration,
      setActiveWorkspace,
      createWorkspaceObservationWait: () => ({
        promise: new Promise<boolean>((resolve) => observationResolvers.push(resolve)),
        cancel: vi.fn(),
      }),
      switchConversation: vi.fn(async () => true),
    };

    const first = openBrowserConversationInWorkspace({
      ...common,
      conversationId: 'chat-b-first',
      selectionGeneration,
      conversationSelectionGeneration,
      workspaceMutationToken: 'browser_request-test',
      browserAttentionGeneration,
    });
    await vi.waitFor(() => expect(destinationConversationId).toBe('chat-b-first'));

    selectionGeneration = 2;
    conversationSelectionGeneration = 2;
    browserAttentionGeneration = 2;
    const second = openBrowserConversationInWorkspace({
      ...common,
      conversationId: 'chat-b-second',
      selectionGeneration,
      conversationSelectionGeneration,
      workspaceMutationToken: 'browser_request-test',
      browserAttentionGeneration,
    });
    await vi.waitFor(() => expect(getConversation).toHaveBeenCalledWith('chat-b-second'));
    expect(destinationConversationId).toBe('chat-b-first');

    observationResolvers[0](false);
    await expect(first).resolves.toBe(false);
    await vi.waitFor(() => expect(destinationConversationId).toBe('chat-b-second'));

    selectionGeneration = 3;
    observationResolvers[1](false);
    await expect(second).resolves.toBe(false);

    expect(activeWorkspaceId).toBe('workspace-a');
    expect(destinationConversationId).toBe('chat-b-original');
    expect(saveLastConversation.mock.calls.map(([args]) => args)).toEqual([
      {
        workspaceId: 'workspace-b',
        conversationId: 'chat-b-first',
        mutationToken: 'browser_request-test',
      },
      {
        workspaceId: 'workspace-b',
        conversationId: 'chat-b-original',
        expectedCurrentConversationId: 'chat-b-first',
        expectedCurrentMutationToken: 'browser_request-test',
      },
      {
        workspaceId: 'workspace-b',
        conversationId: 'chat-b-second',
        mutationToken: 'browser_request-test',
      },
      {
        workspaceId: 'workspace-b',
        conversationId: 'chat-b-original',
        expectedCurrentConversationId: 'chat-b-second',
        expectedCurrentMutationToken: 'browser_request-test',
      },
    ]);
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
      conversationSelectionGeneration: selectionGeneration,
      workspaceMutationToken: 'browser_request-test',
      getConversation: async () => ({ workspaceId: 'workspace-b' }),
      getActiveConversationId: () => activeConversationId,
      getBackendActiveConversationState: async () => activeConversationState(activeConversationId),
      getSelectionGeneration: () => selectionGeneration,
      getConversationSelectionGeneration: () => selectionGeneration,
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
      workspaceMutationToken: 'browser_request-test',
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
    expect(saveLastConversation).toHaveBeenCalledWith({
      workspaceId: 'workspace-b',
      conversationId: 'chat-b',
      mutationToken: 'browser_request-test',
    });
    expect(setActiveWorkspace).toHaveBeenCalledWith('workspace-b', 'workspace-b', 'navigate');

    resolveObservation(true);
    await expect(preparation).resolves.toBe(true);
    expect(cancelObservation).toHaveBeenCalledOnce();
  });

  it('waits for workspace observation before validating the renderer workspace cursor', async () => {
    let rendererWorkspaceId = 'workspace-a';
    let resolveObservation: (observed: boolean) => void = () => {};
    let settled = false;
    const discardActiveWorkspaceTransition = vi.fn();

    const preparation = prepareConversationWorkspaceSwitch({
      conversationId: 'chat-b',
      conversationWorkspaceId: 'workspace-b',
      activeWorkspaceId: 'workspace-a',
      workspaceMutationToken: 'browser_request-test',
      knownWorkspaceIds: ['workspace-a', 'workspace-b'],
      saveLastConversation: async () => undefined,
      setActiveWorkspace: async () => ({ ok: true, previousWorkspaceId: 'workspace-a' }),
      createWorkspaceObservationWait: () => ({
        promise: new Promise<boolean>((resolve) => {
          resolveObservation = resolve;
        }),
        cancel: vi.fn(),
      }),
      isCurrentAfterSwitch: () => rendererWorkspaceId === 'workspace-b',
      discardActiveWorkspaceTransition,
    }).then((ready) => {
      settled = true;
      return ready;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(discardActiveWorkspaceTransition).not.toHaveBeenCalled();

    rendererWorkspaceId = 'workspace-b';
    resolveObservation(true);

    await expect(preparation).resolves.toBe(true);
    expect(discardActiveWorkspaceTransition).not.toHaveBeenCalled();
  });

  it('discards the exact Browser transition when workspace observation fails', async () => {
    const discardActiveWorkspaceTransition = vi.fn();

    await expect(
      prepareConversationWorkspaceSwitch({
        conversationId: 'chat-b',
        conversationWorkspaceId: 'workspace-b',
        activeWorkspaceId: 'workspace-a',
        workspaceMutationToken: 'browser_request-test',
        knownWorkspaceIds: ['workspace-a', 'workspace-b'],
        saveLastConversation: async () => undefined,
        setActiveWorkspace: async () => true,
        createWorkspaceObservationWait: () => ({ promise: Promise.resolve(false), cancel: vi.fn() }),
        discardActiveWorkspaceTransition,
      }),
    ).resolves.toBe(false);

    expect(discardActiveWorkspaceTransition).toHaveBeenCalledWith('workspace-b');
  });

  it('discards the exact Browser transition when an uncommitted switch cannot roll back', async () => {
    const discardActiveWorkspaceTransition = vi.fn();
    const setActiveWorkspace = vi.fn().mockResolvedValueOnce({ ok: true, previousWorkspaceId: 'workspace-a' });

    await expect(
      prepareConversationWorkspaceSwitch({
        conversationId: 'chat-b',
        conversationWorkspaceId: 'workspace-b',
        activeWorkspaceId: 'workspace-a',
        workspaceMutationToken: 'browser_request-test',
        knownWorkspaceIds: ['workspace-a', 'workspace-b'],
        saveLastConversation: async () => undefined,
        setActiveWorkspace,
        createWorkspaceObservationWait: () => ({ promise: Promise.resolve(true), cancel: vi.fn() }),
        isCurrentAfterSwitch: () => false,
        resolveStaleSwitchDisposition: () => 'superseded',
        discardActiveWorkspaceTransition,
      }),
    ).resolves.toBe(false);

    expect(setActiveWorkspace).toHaveBeenCalledOnce();
    expect(discardActiveWorkspaceTransition).toHaveBeenCalledOnce();
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
        workspaceMutationToken: 'browser_request-test',
        knownWorkspaceIds: ['workspace-a', 'workspace-authoritative'],
        saveLastConversation: async () => undefined,
        setActiveWorkspace,
        createWorkspaceObservationWait: () => ({ promise: Promise.resolve(true), cancel: vi.fn() }),
        isCurrent: () => true,
        isCurrentAfterSwitch: () => false,
        resolveStaleSwitchDisposition: () => 'rollback',
      }),
    ).resolves.toBe(false);

    expect(setActiveWorkspace).toHaveBeenNthCalledWith(1, 'workspace-a', 'workspace-a', 'navigate');
    expect(setActiveWorkspace).toHaveBeenNthCalledWith(
      2,
      'workspace-authoritative',
      'workspace-a',
      'rollback',
      'browser_request-test',
    );
  });

  it('retains the Browser transition when a stale workspace rollback is rejected', async () => {
    const discardActiveWorkspaceTransition = vi.fn();
    const setActiveWorkspace = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, previousWorkspaceId: 'workspace-a' })
      .mockResolvedValueOnce({ ok: false, activeWorkspaceId: 'workspace-b' });

    await expect(
      prepareConversationWorkspaceSwitch({
        conversationId: 'chat-b',
        conversationWorkspaceId: 'workspace-b',
        activeWorkspaceId: 'workspace-a',
        workspaceMutationToken: 'browser_request-test',
        knownWorkspaceIds: ['workspace-a', 'workspace-b'],
        saveLastConversation: async () => undefined,
        setActiveWorkspace,
        createWorkspaceObservationWait: () => ({ promise: Promise.resolve(true), cancel: vi.fn() }),
        isCurrentAfterSwitch: () => false,
        resolveStaleSwitchDisposition: () => 'rollback',
        discardActiveWorkspaceTransition,
      }),
    ).resolves.toBe(false);

    expect(setActiveWorkspace).toHaveBeenNthCalledWith(
      2,
      'workspace-a',
      'workspace-b',
      'rollback',
      'browser_request-test',
    );
    expect(discardActiveWorkspaceTransition).not.toHaveBeenCalled();
  });

  it('discards the Browser transition when the destination has another mutation owner', async () => {
    const discardActiveWorkspaceTransition = vi.fn();
    const setActiveWorkspace = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, previousWorkspaceId: 'workspace-a' })
      .mockResolvedValueOnce({
        ok: false,
        activeWorkspaceId: 'workspace-b',
        activeWorkspaceMutationToken: 'other_request',
      });

    await expect(
      prepareConversationWorkspaceSwitch({
        conversationId: 'chat-b',
        conversationWorkspaceId: 'workspace-b',
        activeWorkspaceId: 'workspace-a',
        workspaceMutationToken: 'browser_request-test',
        knownWorkspaceIds: ['workspace-a', 'workspace-b'],
        saveLastConversation: async () => undefined,
        setActiveWorkspace,
        createWorkspaceObservationWait: () => ({ promise: Promise.resolve(true), cancel: vi.fn() }),
        isCurrentAfterSwitch: () => false,
        resolveStaleSwitchDisposition: () => 'rollback',
        discardActiveWorkspaceTransition,
      }),
    ).resolves.toBe(false);

    expect(discardActiveWorkspaceTransition).toHaveBeenCalledOnce();
    expect(discardActiveWorkspaceTransition).toHaveBeenCalledWith('workspace-b');
  });

  it('discards the Browser transition when a rejected rollback reports another authoritative workspace', async () => {
    const discardActiveWorkspaceTransition = vi.fn();
    const setActiveWorkspace = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, previousWorkspaceId: 'workspace-a' })
      .mockResolvedValueOnce({ ok: false, activeWorkspaceId: 'workspace-c' });

    await expect(
      prepareConversationWorkspaceSwitch({
        conversationId: 'chat-b',
        conversationWorkspaceId: 'workspace-b',
        activeWorkspaceId: 'workspace-a',
        workspaceMutationToken: 'browser_request-test',
        knownWorkspaceIds: ['workspace-a', 'workspace-b', 'workspace-c'],
        saveLastConversation: async () => undefined,
        setActiveWorkspace,
        createWorkspaceObservationWait: () => ({ promise: Promise.resolve(true), cancel: vi.fn() }),
        isCurrentAfterSwitch: () => false,
        resolveStaleSwitchDisposition: () => 'rollback',
        discardActiveWorkspaceTransition,
      }),
    ).resolves.toBe(false);

    expect(setActiveWorkspace).toHaveBeenNthCalledWith(
      2,
      'workspace-a',
      'workspace-b',
      'rollback',
      'browser_request-test',
    );
    expect(discardActiveWorkspaceTransition).toHaveBeenCalledOnce();
    expect(discardActiveWorkspaceTransition).toHaveBeenCalledWith('workspace-b');
  });

  it('retains the Browser transition when a stale workspace rollback throws', async () => {
    const discardActiveWorkspaceTransition = vi.fn();
    const setActiveWorkspace = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, previousWorkspaceId: 'workspace-a' })
      .mockRejectedValueOnce(new Error('rollback unavailable'));

    await expect(
      prepareConversationWorkspaceSwitch({
        conversationId: 'chat-b',
        conversationWorkspaceId: 'workspace-b',
        activeWorkspaceId: 'workspace-a',
        workspaceMutationToken: 'browser_request-test',
        knownWorkspaceIds: ['workspace-a', 'workspace-b'],
        saveLastConversation: async () => undefined,
        setActiveWorkspace,
        createWorkspaceObservationWait: () => ({ promise: Promise.resolve(true), cancel: vi.fn() }),
        isCurrentAfterSwitch: () => false,
        resolveStaleSwitchDisposition: () => 'rollback',
        discardActiveWorkspaceTransition,
      }),
    ).rejects.toThrow('rollback unavailable');

    expect(setActiveWorkspace).toHaveBeenNthCalledWith(
      2,
      'workspace-a',
      'workspace-b',
      'rollback',
      'browser_request-test',
    );
    expect(discardActiveWorkspaceTransition).not.toHaveBeenCalled();
  });

  it('retains the Browser transition when rollback disposition cannot be resolved', async () => {
    const discardActiveWorkspaceTransition = vi.fn();
    const setActiveWorkspace = vi.fn().mockResolvedValueOnce({ ok: true, previousWorkspaceId: 'workspace-a' });

    await expect(
      prepareConversationWorkspaceSwitch({
        conversationId: 'chat-b',
        conversationWorkspaceId: 'workspace-b',
        activeWorkspaceId: 'workspace-a',
        workspaceMutationToken: 'browser_request-test',
        knownWorkspaceIds: ['workspace-a', 'workspace-b'],
        saveLastConversation: async () => undefined,
        setActiveWorkspace,
        createWorkspaceObservationWait: () => ({ promise: Promise.resolve(true), cancel: vi.fn() }),
        isCurrentAfterSwitch: () => false,
        resolveStaleSwitchDisposition: () => {
          throw new Error('workspace state unavailable');
        },
        discardActiveWorkspaceTransition,
      }),
    ).rejects.toThrow('workspace state unavailable');

    expect(setActiveWorkspace).toHaveBeenCalledOnce();
    expect(discardActiveWorkspaceTransition).not.toHaveBeenCalled();
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
      workspaceMutationToken: 'browser_request-test',
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
        workspaceMutationToken: 'browser_request-test',
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
      mutationToken: 'browser_request-test',
    });
    expect(saveLastConversation).toHaveBeenNthCalledWith(2, {
      workspaceId: 'workspace-b',
      conversationId: 'chat-b-previous',
      expectedCurrentConversationId: 'chat-b-canceled',
      expectedCurrentMutationToken: 'browser_request-test',
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
        workspaceMutationToken: 'browser_request-test',
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
      expectedCurrentMutationToken: 'browser_request-test',
    });
  });

  it('does not restore destination metadata after its value changes away and back', async () => {
    let current = true;
    let lastConversation: string | null = 'chat-b-previous';
    let lastMutationToken: string | null = null;
    const saveLastConversation = vi.fn(
      async ({
        conversationId,
        expectedCurrentConversationId,
        expectedCurrentMutationToken,
        mutationToken,
      }: {
        conversationId: string | null;
        expectedCurrentConversationId?: string | null;
        expectedCurrentMutationToken?: string | null;
        mutationToken?: string;
      }) => {
        if (
          (expectedCurrentConversationId !== undefined && expectedCurrentConversationId !== lastConversation) ||
          (expectedCurrentMutationToken !== undefined && expectedCurrentMutationToken !== lastMutationToken)
        ) {
          return {
            ok: false,
            error: 'last-conversation-changed' as const,
            lastActiveConversationId: lastConversation,
            lastActiveConversationMutationToken: lastMutationToken,
          };
        }
        const previousConversationId = lastConversation;
        lastConversation = conversationId;
        lastMutationToken = mutationToken ?? null;
        if (expectedCurrentConversationId === undefined) {
          current = false;
          lastConversation = 'chat-user-intermediate';
          lastMutationToken = 'user_first';
          lastConversation = 'chat-b-canceled';
          lastMutationToken = 'user_second';
        }
        return { ok: true, previousConversationId, lastActiveConversationId: conversationId };
      },
    );

    await expect(
      prepareConversationWorkspaceSwitch({
        conversationId: 'chat-b-canceled',
        conversationWorkspaceId: 'workspace-b',
        activeWorkspaceId: 'workspace-a',
        workspaceMutationToken: 'browser_request-test',
        knownWorkspaceIds: ['workspace-a', 'workspace-b'],
        saveLastConversation,
        setActiveWorkspace: vi.fn(async () => true),
        createWorkspaceObservationWait: () => ({ promise: Promise.resolve(true), cancel: vi.fn() }),
        isCurrent: () => current,
      }),
    ).resolves.toBe(false);

    expect(lastConversation).toBe('chat-b-canceled');
    expect(lastMutationToken).toBe('user_second');
    expect(saveLastConversation).toHaveBeenLastCalledWith({
      workspaceId: 'workspace-b',
      conversationId: 'chat-b-previous',
      expectedCurrentConversationId: 'chat-b-canceled',
      expectedCurrentMutationToken: 'browser_request-test',
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
        workspaceMutationToken: 'browser_request-test',
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

describe('isRedundantActiveConversationBroadcast', () => {
  it('ignores a matching bare active-id acknowledgement', () => {
    expect(
      isRedundantActiveConversationBroadcast('conv-a', {
        kind: 'active',
        activeConversationId: 'conv-a',
      }),
    ).toBe(true);
  });

  it('does not hide record updates, initial selection, or a different active id', () => {
    expect(
      isRedundantActiveConversationBroadcast('conv-a', {
        kind: 'upsert',
        activeConversationId: 'conv-a',
      }),
    ).toBe(false);
    expect(
      isRedundantActiveConversationBroadcast(null, {
        kind: 'active',
        activeConversationId: 'conv-a',
      }),
    ).toBe(false);
    expect(
      isRedundantActiveConversationBroadcast('conv-a', {
        kind: 'active',
        activeConversationId: 'conv-b',
      }),
    ).toBe(false);
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
