/**
 * Pure decision for the sidebar's active-conversation sync.
 *
 * "Active conversation" is a single GLOBAL value on the backend, so any client
 * (the GUI, another GUI window, or the `kai` CLI) flipping it broadcasts a
 * change to everyone. A window must NOT blindly adopt that broadcast's active-id
 * as its own selection — otherwise the CLI creating/selecting a chat yanks the
 * GUI user's selection outline onto a different conversation (the reported bug).
 *
 * This encodes when a window SHOULD follow a broadcast `upsert` that carries a
 * new active-id: only when the window has no selection yet (initial load) or the
 * new active-id already matches its own. A cross-client switch to a DIFFERENT
 * conversation leaves the window's selection put (the list still refreshes to
 * surface the new chat elsewhere).
 */
export function shouldAdoptBroadcastActiveId(
  /** This window's current selection (null when nothing is selected yet). */
  mySelection: string | null,
  /** The active-id carried by the broadcast (the new global active). */
  broadcastActiveId: string | null,
): boolean {
  if (broadcastActiveId == null) return false; // no active to adopt
  // Adopt only on first selection, or when it's already ours (idempotent refresh).
  return mySelection == null || mySelection === broadcastActiveId;
}

/** A null global active-id is not enough to clear this window's independent
 * selection. Another client can make chat B globally active while this window
 * remains on chat A, then delete B. That delete broadcasts null even though A
 * is still valid. Clear only when the broadcast proves this window's selected
 * record disappeared, or when the entire conversation store was reset. */
export function shouldClearSelectionForNullActiveBroadcast(
  mySelection: string | null,
  change: { kind: 'upsert' | 'delete' | 'reset' | 'active'; id?: string },
): boolean {
  if (mySelection == null) return true;
  if (change.kind === 'reset') return true;
  return change.kind === 'delete' && change.id === mySelection;
}

/** A conversation delete can await Browser profile cleanup after the record is
 * already gone. Apply its precomputed fallback only if this window was deleting
 * its selected chat and the user has not selected another chat meanwhile. */
export function shouldApplyConversationDeleteFallback(
  deletedId: string,
  selectionWhenDeleteStarted: string | null,
  currentSelection: string | null,
): boolean {
  return selectionWhenDeleteStarted === deletedId && currentSelection === deletedId;
}

/** Commit a renderer-owned selection intent synchronously before scheduling
 * React state. Async delete cleanup consults the ref and must observe the new
 * chat even before React flushes its state update. */
export function commitLocalConversationSelection(
  selectionRef: { current: string | null },
  conversationId: string | null,
  setSelection: (conversationId: string | null) => void,
): void {
  selectionRef.current = conversationId;
  setSelection(conversationId);
}

/** Workspace restoration is an asynchronous selection intent. It may commit
 * only while both the destination workspace and the renderer selection state
 * still match the snapshot captured before its backend activation began. */
export function isConversationWorkspaceRestorationCurrent(options: {
  workspaceId: string;
  currentWorkspaceId: string | null | undefined;
  selectionSequence: number;
  currentSelectionSequence: number;
  selectionWhenStarted: string | null;
  currentSelection: string | null;
}): boolean {
  return (
    options.currentWorkspaceId === options.workspaceId &&
    options.currentSelectionSequence === options.selectionSequence &&
    options.currentSelection === options.selectionWhenStarted
  );
}

type ConversationFallbackCandidate = {
  id: string;
  workspaceId?: string | null;
  archived?: boolean;
  messageCount?: number;
  title?: string | null;
  fallbackTitle?: string | null;
};

/** Keep delete navigation inside the list the user was actually viewing. When
 * a caller cannot provide an exact view snapshot (for example, the title-bar
 * delete action), fall back to the normal unarchived list for the active
 * workspace rather than selecting a hidden/global conversation. */
export function filterConversationDeleteFallbackCandidates<T extends ConversationFallbackCandidate>(
  conversations: readonly T[],
  excludedIds: Iterable<string>,
  options: {
    fallbackCandidateIds?: readonly string[];
    workspaceId?: string | null;
  },
): T[] {
  const excluded = new Set(excludedIds);
  const exactCandidates = options.fallbackCandidateIds === undefined ? null : new Set(options.fallbackCandidateIds);
  return conversations.filter((conversation) => {
    if (excluded.has(conversation.id)) return false;
    if (exactCandidates) return exactCandidates.has(conversation.id);
    if (options.workspaceId && conversation.workspaceId && conversation.workspaceId !== options.workspaceId) {
      return false;
    }
    if (conversation.archived) return false;
    return (
      (conversation.messageCount ?? 0) > 0 || Boolean(conversation.title?.trim() || conversation.fallbackTitle?.trim())
    );
  });
}

export type WorkspaceObservationWait = {
  promise: Promise<boolean>;
  cancel: () => void;
};

export type ActiveWorkspaceCasResult = {
  ok: boolean;
  error?: 'active-workspace-changed';
  activeWorkspaceId?: string | null;
};

const MAX_BROWSER_WORKSPACE_CAS_ATTEMPTS = 4;

/** A newer Browser-attention request may observe a workspace CAS failure after
 * an older request commits first. Rebase only while this exact request still
 * owns navigation; user workspace/view/chat intent invalidates it immediately. */
export async function setActiveBrowserWorkspaceWithRebase(options: {
  workspaceId: string;
  expectedCurrentWorkspaceId: string | null;
  setActiveWorkspace: (
    workspaceId: string,
    expectedCurrentWorkspaceId: string | null,
  ) => Promise<ActiveWorkspaceCasResult>;
  isCurrent: () => boolean;
}): Promise<boolean> {
  let expectedCurrentWorkspaceId = options.expectedCurrentWorkspaceId;
  for (let attempt = 0; attempt < MAX_BROWSER_WORKSPACE_CAS_ATTEMPTS; attempt += 1) {
    const result = await options.setActiveWorkspace(options.workspaceId, expectedCurrentWorkspaceId);
    if (result.ok) return true;
    if (!options.isCurrent() || result.activeWorkspaceId === undefined) return false;
    expectedCurrentWorkspaceId = result.activeWorkspaceId;
  }
  return false;
}

export async function openBrowserConversationInWorkspace(options: {
  conversationId: string;
  selectionGeneration: number;
  getConversation: (conversationId: string) => Promise<{ workspaceId?: string | null } | null>;
  getActiveConversationId: () => string | null;
  getBackendActiveConversationId: () => Promise<string | null>;
  getSelectionGeneration: () => number;
  getActiveWorkspaceId: () => string | null | undefined;
  getKnownWorkspaceIds: () => Iterable<string>;
  saveLastConversation: (args: { workspaceId: string; conversationId: string }) => Promise<void>;
  getWorkspaceSelectionGeneration: () => number;
  workspaceSelectionGeneration: number;
  getBrowserAttentionGeneration: () => number;
  browserAttentionGeneration: number;
  setActiveWorkspace: (
    workspaceId: string | null,
    expectedCurrentWorkspaceId: string | null,
    operation: 'navigate' | 'rollback',
  ) => Promise<boolean>;
  createWorkspaceObservationWait: (workspaceId: string) => WorkspaceObservationWait;
  switchConversation: (
    conversationId: string,
    expectedCurrentConversationId: string | null,
    selectionGeneration: number,
  ) => Promise<boolean>;
}): Promise<boolean> {
  const selectionWhenStarted = options.getActiveConversationId();
  const selectionIsCurrent = (): boolean =>
    options.getSelectionGeneration() === options.selectionGeneration &&
    options.getActiveConversationId() === selectionWhenStarted;
  const selectionIsCompatibleAfterWorkspaceSwitch = (): boolean =>
    options.getSelectionGeneration() === options.selectionGeneration &&
    (options.getActiveConversationId() === selectionWhenStarted ||
      options.getActiveConversationId() === options.conversationId);
  const [conversation, backendSelectionWhenStarted] = await Promise.all([
    options.getConversation(options.conversationId),
    options.getBackendActiveConversationId(),
  ]);
  if (!conversation) return false;

  // A Browser-attention click is navigation intent, but it must not become a
  // newer intent merely because its record/workspace lookup was slow. If the
  // target was selected by the workspace restoration we initiated, the request
  // already succeeded and must not issue a second selection CAS.
  const activeWorkspaceAfterLookup = options.getActiveWorkspaceId();
  if (
    options.getActiveConversationId() === options.conversationId &&
    (!conversation.workspaceId || conversation.workspaceId === activeWorkspaceAfterLookup)
  ) {
    return true;
  }
  if (!selectionIsCurrent()) return false;
  const activeWorkspaceAtPreparation = activeWorkspaceAfterLookup;

  // Read workspace state only after the async record lookup. Browser attention
  // can arrive while the user is changing workspaces, and render-captured state
  // from before this await could otherwise select the chat under the workspace
  // the user just left.
  const workspaceReady = await prepareConversationWorkspaceSwitch({
    conversationId: options.conversationId,
    conversationWorkspaceId: conversation.workspaceId,
    activeWorkspaceId: activeWorkspaceAtPreparation,
    knownWorkspaceIds: options.getKnownWorkspaceIds(),
    saveLastConversation: options.saveLastConversation,
    setActiveWorkspace: options.setActiveWorkspace,
    createWorkspaceObservationWait: options.createWorkspaceObservationWait,
    isCurrent: () => selectionIsCurrent() && options.getActiveWorkspaceId() === activeWorkspaceAtPreparation,
    isCurrentAfterSwitch: selectionIsCompatibleAfterWorkspaceSwitch,
    canRollbackStaleSwitch: () =>
      options.getWorkspaceSelectionGeneration() === options.workspaceSelectionGeneration &&
      options.getBrowserAttentionGeneration() === options.browserAttentionGeneration,
  });
  if (!workspaceReady) return false;
  if (options.getActiveConversationId() === options.conversationId) return true;
  if (!selectionIsCurrent()) return false;
  return options.switchConversation(options.conversationId, backendSelectionWhenStarted, options.selectionGeneration);
}

/** Prepare cross-workspace navigation initiated by Browser attention. Saving
 * the destination first prevents the workspace-restoration effect from
 * selecting that workspace's previous chat. Waiting for the renderer to
 * observe the workspace transition keeps its departing-workspace effect from
 * recording the destination chat as the workspace we just left. */
export async function prepareConversationWorkspaceSwitch(options: {
  conversationId: string;
  conversationWorkspaceId?: string | null;
  activeWorkspaceId?: string | null;
  knownWorkspaceIds: Iterable<string>;
  saveLastConversation: (args: { workspaceId: string; conversationId: string }) => Promise<void>;
  setActiveWorkspace: (
    workspaceId: string | null,
    expectedCurrentWorkspaceId: string | null,
    operation: 'navigate' | 'rollback',
  ) => Promise<boolean>;
  createWorkspaceObservationWait: (workspaceId: string) => WorkspaceObservationWait;
  isCurrent?: () => boolean;
  isCurrentAfterSwitch?: () => boolean;
  canRollbackStaleSwitch?: () => boolean;
}): Promise<boolean> {
  const targetWorkspaceId = options.conversationWorkspaceId;
  if (!targetWorkspaceId) return true;
  if (!new Set(options.knownWorkspaceIds).has(targetWorkspaceId)) return false;
  const observation = options.createWorkspaceObservationWait(targetWorkspaceId);
  try {
    if (targetWorkspaceId !== options.activeWorkspaceId) {
      await options.saveLastConversation({
        workspaceId: targetWorkspaceId,
        conversationId: options.conversationId,
      });
      if (options.isCurrent && !options.isCurrent()) return false;
      const switched = await options.setActiveWorkspace(
        targetWorkspaceId,
        options.activeWorkspaceId ?? null,
        'navigate',
      );
      if (!switched) return false;
      if (options.isCurrentAfterSwitch && !options.isCurrentAfterSwitch()) {
        if (options.canRollbackStaleSwitch?.()) {
          await options.setActiveWorkspace(options.activeWorkspaceId ?? null, targetWorkspaceId, 'rollback');
        }
        return false;
      }
    }
    const observed = await observation.promise;
    if (!observed) return false;
    if (targetWorkspaceId !== options.activeWorkspaceId && options.isCurrentAfterSwitch?.() === false) {
      if (options.canRollbackStaleSwitch?.()) {
        await options.setActiveWorkspace(options.activeWorkspaceId ?? null, targetWorkspaceId, 'rollback');
      }
      return false;
    }
    return true;
  } finally {
    observation.cancel();
  }
}

type ActiveConversationCasResult = {
  ok: boolean;
  activeConversationId?: string | null;
};

/** Resolve a surviving delete fallback against fresh backend state. Browser
 * profile cleanup can keep the delete IPC pending long enough for another
 * window to delete or select the originally chosen fallback. Each attempt
 * relists records and CAS-validates the backend active id before returning it. */
export async function selectConversationDeleteFallback<T extends { id: string }>(options: {
  deletedId: string;
  expectedBackendId: string | null;
  list: () => Promise<T[]>;
  setActiveId: (id: string | null, expectedCurrentId: string | null) => Promise<ActiveConversationCasResult>;
}): Promise<T | null> {
  let expectedBackendId = options.expectedBackendId;
  let authoritativeSelectionObserved = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidates = (await options.list()).filter((conversation) => conversation.id !== options.deletedId);
    const expectedCandidate = candidates.find((conversation) => conversation.id === expectedBackendId);
    // A failed CAS reports the authoritative global selection. If it belongs to
    // another workspace/filter, this window must not replace it merely because
    // it is absent from this window's fallback list.
    if (authoritativeSelectionObserved && expectedBackendId !== null && !expectedCandidate) return null;
    if (candidates.length === 0) {
      if (expectedBackendId === null) return null;
      const cleared = await options.setActiveId(null, expectedBackendId);
      if (cleared.ok) return null;
      expectedBackendId = cleared.activeConversationId ?? null;
      authoritativeSelectionObserved = true;
      continue;
    }
    const candidate = expectedCandidate ?? candidates[0];
    const result = await options.setActiveId(candidate.id, expectedBackendId);
    if (!result.ok) {
      expectedBackendId = result.activeConversationId ?? null;
      authoritativeSelectionObserved = true;
      continue;
    }

    // setActiveId is a selection CAS, not a record-existence transaction. A
    // second window can delete the candidate between this window's list and
    // CAS, so verify against one more fresh list before exposing it locally.
    const verified = (await options.list()).find((conversation) => conversation.id === candidate.id);
    if (verified) return verified;
    // We won the selection CAS but the record disappeared before verification.
    // Clear only while the backend still points at that exact candidate; if
    // another window selected something else meanwhile, preserve it and retry
    // against the authoritative active id returned by the failed CAS.
    const cleared = await options.setActiveId(null, candidate.id);
    expectedBackendId = cleared.ok ? null : (cleared.activeConversationId ?? null);
    authoritativeSelectionObserved = !cleared.ok;
  }
  return null;
}
