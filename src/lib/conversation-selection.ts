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

export type BrowserWorkspaceTransitionMarker = {
  navigationGeneration: number;
  browserAttentionGeneration: number;
  workspaceSelectionGeneration: number;
  /** A newer Browser request inherited this already-committed workspace
   * mutation. The workspace cursor must advance, but restoring the arriving
   * workspace's saved chat would invalidate that newer request. */
  suppressArrivingWorkspaceRestoration?: boolean;
  operation: 'navigate' | 'rollback';
  departingWorkspaceId: string | null;
  destinationWorkspaceId: string | null;
  departingConversationId: string | null;
};

/** Rollbacks are ordinary cursor reconciliation, and a same-workspace set can
 * never produce a workspace-ID effect. Neither operation may leave a marker
 * for a later unrelated transition to consume. */
export function createBrowserWorkspaceTransitionMarker(options: {
  navigationGeneration: number;
  browserAttentionGeneration: number;
  workspaceSelectionGeneration: number;
  operation: 'navigate' | 'rollback';
  departingWorkspaceId: string | null;
  destinationWorkspaceId: string | null;
  departingConversationId: string | null;
}): BrowserWorkspaceTransitionMarker | undefined {
  if (options.operation === 'rollback' || options.departingWorkspaceId === options.destinationWorkspaceId) {
    return undefined;
  }
  return options;
}

/** A newer Browser request may intentionally retain a workspace reached by an
 * older request before React observes it. Transfer ownership of that pending
 * transition while preserving the real departing workspace/conversation. */
export function adoptBrowserWorkspaceTransitionMarker(options: {
  marker?: BrowserWorkspaceTransitionMarker;
  activeWorkspaceId: string;
  previousWorkspaceId: string | null | undefined;
  navigationGeneration: number;
  browserAttentionGeneration: number;
  currentWorkspaceSelectionGeneration: number;
}): BrowserWorkspaceTransitionMarker | undefined {
  const marker = options.marker;
  if (
    !marker ||
    marker.operation !== 'navigate' ||
    marker.destinationWorkspaceId !== options.activeWorkspaceId ||
    marker.departingWorkspaceId !== options.previousWorkspaceId ||
    marker.workspaceSelectionGeneration !== options.currentWorkspaceSelectionGeneration ||
    marker.browserAttentionGeneration >= options.browserAttentionGeneration
  ) {
    return marker;
  }
  return {
    ...marker,
    navigationGeneration: options.navigationGeneration,
    browserAttentionGeneration: options.browserAttentionGeneration,
    suppressArrivingWorkspaceRestoration: true,
  };
}

/** Decide whether an observed workspace change belongs to a Browser request
 * that has already lost navigation ownership. A stale transient must retain the
 * real previous-workspace cursor so a subsequent rebase/rollback cannot record
 * the current conversation against a workspace the window never entered. */
export function resolveConversationWorkspaceTransition(options: {
  previousWorkspaceId: string | null;
  activeWorkspaceId: string | null;
  currentConversationId: string | null;
  browserTransition?: BrowserWorkspaceTransitionMarker;
  currentNavigationGeneration: number;
  currentBrowserAttentionGeneration: number;
  currentWorkspaceSelectionGeneration: number;
}): {
  staleBrowserTransition: boolean;
  suppressArrivingWorkspaceRestoration: boolean;
  departingWorkspaceId: string | null;
  departingConversationId: string | null;
  nextPreviousWorkspaceId: string | null;
} {
  const markerDescribesTransition =
    options.browserTransition !== undefined &&
    options.browserTransition.departingWorkspaceId === options.previousWorkspaceId &&
    options.browserTransition.destinationWorkspaceId === options.activeWorkspaceId &&
    options.browserTransition.workspaceSelectionGeneration === options.currentWorkspaceSelectionGeneration;
  const staleBrowserTransition =
    markerDescribesTransition &&
    options.browserTransition?.operation === 'navigate' &&
    options.browserTransition.suppressArrivingWorkspaceRestoration !== true &&
    options.browserTransition.navigationGeneration !== options.currentNavigationGeneration &&
    // A newer Browser-attention request inherits a workspace mutation that has
    // already committed. The older request can no longer roll it back, so the
    // effect must reconcile the real departing cursor instead of discarding it
    // while the newer request is still loading its conversation record.
    options.browserTransition.browserAttentionGeneration >= options.currentBrowserAttentionGeneration &&
    options.browserTransition.workspaceSelectionGeneration === options.currentWorkspaceSelectionGeneration;
  const suppressArrivingWorkspaceRestoration =
    staleBrowserTransition ||
    (markerDescribesTransition &&
      options.browserTransition?.operation === 'navigate' &&
      (options.browserTransition.suppressArrivingWorkspaceRestoration === true ||
        options.browserTransition.browserAttentionGeneration < options.currentBrowserAttentionGeneration));
  return {
    staleBrowserTransition,
    suppressArrivingWorkspaceRestoration,
    departingWorkspaceId: markerDescribesTransition
      ? (options.browserTransition?.departingWorkspaceId ?? null)
      : options.previousWorkspaceId,
    departingConversationId: markerDescribesTransition
      ? (options.browserTransition?.departingConversationId ?? null)
      : options.currentConversationId,
    nextPreviousWorkspaceId: staleBrowserTransition ? options.previousWorkspaceId : options.activeWorkspaceId,
  };
}

/** Workspace restoration is an asynchronous selection intent. It may commit
 * only while the destination workspace, navigation intent, and renderer
 * selection state still match the snapshot captured before its backend
 * activation began. */
export function isConversationWorkspaceRestorationCurrent(options: {
  workspaceId: string;
  currentWorkspaceId: string | null | undefined;
  selectionIntentGeneration: number;
  currentSelectionIntentGeneration: number;
  selectionSequence: number;
  currentSelectionSequence: number;
  selectionWhenStarted: string | null;
  currentSelection: string | null;
}): boolean {
  return (
    options.currentWorkspaceId === options.workspaceId &&
    options.currentSelectionIntentGeneration === options.selectionIntentGeneration &&
    options.currentSelectionSequence === options.selectionSequence &&
    options.currentSelection === options.selectionWhenStarted
  );
}

/** A strict read can fail after the backend selection CAS has already
 * succeeded. Restore the prior backend selection only while this restoration
 * still owns the renderer intent, and use a CAS so a newer selection wins. */
export async function rollbackUnavailableWorkspaceRestoration(options: {
  restoredConversationId: string;
  previousConversationId: string | null;
  isCurrent: () => boolean;
  setActiveId: (
    conversationId: string | null,
    expectedCurrentConversationId: string | null,
  ) => Promise<{ ok: boolean }>;
}): Promise<boolean> {
  if (!options.isCurrent()) return false;
  const result = await options.setActiveId(options.previousConversationId, options.restoredConversationId);
  return result.ok && options.isCurrent();
}

export type ActiveConversationCasResult = {
  ok: boolean;
  error?: 'active-conversation-changed' | 'conversation-not-found' | 'conversation-unavailable';
  activeConversationId?: string | null;
};

export type WorkspaceRestorationReadResult<T> =
  | { status: 'found'; conversation: T }
  | { status: 'missing' }
  | { status: 'unavailable' };

const WORKSPACE_RESTORATION_RETRY_DELAYS_MS = [25, 75, 150] as const;

/** A strict conversation read can fail transiently before the selection CAS is
 * attempted. Retry only that temporary failure, remain bound to the original
 * renderer intent, and stop after a small deterministic backoff budget. */
export async function setActiveConversationForWorkspaceRestoration(options: {
  conversationId: string;
  expectedCurrentConversationId: string | null;
  isCurrent: () => boolean;
  setActiveId: (
    conversationId: string,
    expectedCurrentConversationId: string | null,
  ) => Promise<ActiveConversationCasResult>;
  waitForRetry?: (delayMs: number) => Promise<void>;
}): Promise<ActiveConversationCasResult | null> {
  const waitForRetry =
    options.waitForRetry ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      }));
  for (let attempt = 0; ; attempt += 1) {
    if (!options.isCurrent()) return null;
    const result = await options.setActiveId(options.conversationId, options.expectedCurrentConversationId);
    if (!options.isCurrent()) return null;
    if (result.error === 'active-conversation-changed' && result.activeConversationId === options.conversationId) {
      return { ok: true, activeConversationId: result.activeConversationId };
    }
    if (result.error !== 'conversation-unavailable') return result;
    const delayMs = WORKSPACE_RESTORATION_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined) return result;
    await waitForRetry(delayMs);
  }
}

/** The post-CAS strict read can encounter the same transient filesystem window
 * as the activation read. Keep it tied to the original renderer intent and use
 * the same bounded retry budget before deciding that rollback is necessary. */
export async function getConversationForWorkspaceRestoration<T>(options: {
  conversationId: string;
  isCurrent: () => boolean;
  getForRestore: (conversationId: string) => Promise<WorkspaceRestorationReadResult<T>>;
  waitForRetry?: (delayMs: number) => Promise<void>;
}): Promise<WorkspaceRestorationReadResult<T> | null> {
  const waitForRetry =
    options.waitForRetry ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      }));
  for (let attempt = 0; ; attempt += 1) {
    if (!options.isCurrent()) return null;
    const result = await options.getForRestore(options.conversationId);
    if (!options.isCurrent()) return null;
    if (result.status !== 'unavailable') return result;
    const delayMs = WORKSPACE_RESTORATION_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined) return result;
    await waitForRetry(delayMs);
  }
}

/** A failed workspace mutation may request restoration only while it remains
 * the newest conversation/workspace selection intent and the renderer is still
 * in its source scope. View-only navigation must not suppress the repair. */
export function shouldRetryWorkspaceConversationRestoration(options: {
  workspaceId: string | null;
  currentWorkspaceId: string | null;
  selectionIntentGeneration: number;
  currentSelectionIntentGeneration: number;
}): boolean {
  return (
    options.workspaceId === options.currentWorkspaceId &&
    options.selectionIntentGeneration === options.currentSelectionIntentGeneration
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

export type WorkspaceObservationWaiter = (observed: boolean) => void;

/** Wait for React to observe a workspace change without leaving Browser
 * attention hung forever when a config refresh is lost or coalesced. */
export function createBoundedWorkspaceObservationWait(options: {
  workspaceId: string;
  configuredWorkspaceId: string | null;
  observedWorkspaceId: string | null | undefined;
  waiters: Map<string, Set<WorkspaceObservationWaiter>>;
  timeoutMs: number;
}): WorkspaceObservationWait {
  if (options.configuredWorkspaceId === options.workspaceId && options.observedWorkspaceId === options.workspaceId) {
    return { promise: Promise.resolve(true), cancel: () => {} };
  }

  let settle: WorkspaceObservationWaiter = () => {};
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<boolean>((resolve) => {
    const waiters = options.waiters.get(options.workspaceId) ?? new Set<WorkspaceObservationWaiter>();
    let settled = false;
    settle = (observed) => {
      if (settled) return;
      settled = true;
      if (timeout !== null) clearTimeout(timeout);
      waiters.delete(settle);
      if (waiters.size === 0 && options.waiters.get(options.workspaceId) === waiters) {
        options.waiters.delete(options.workspaceId);
      }
      resolve(observed);
    };
    waiters.add(settle);
    options.waiters.set(options.workspaceId, waiters);
  });
  timeout = setTimeout(() => settle(false), options.timeoutMs);
  return { promise, cancel: () => settle(false) };
}

export type ActiveWorkspaceCasResult = {
  ok: boolean;
  error?: 'active-workspace-changed';
  activeWorkspaceId?: string | null;
  activeWorkspaceLastConversationId?: string | null;
  /** Opaque provenance for the mutation that selected activeWorkspaceId. */
  activeWorkspaceMutationToken?: string | null;
};

export type BrowserWorkspaceSwitchResult = {
  ok: boolean;
  /** Authoritative workspace replaced by the successful compare-and-set. */
  previousWorkspaceId?: string | null;
};

export type WorkspaceLastConversationCasResult = {
  ok: boolean;
  error?: 'workspace-not-found' | 'last-conversation-changed';
  previousConversationId?: string | null;
  lastActiveConversationId?: string | null;
};

type SaveWorkspaceLastConversation = (args: {
  workspaceId: string;
  conversationId: string | null;
  expectedCurrentConversationId?: string | null;
}) => Promise<WorkspaceLastConversationCasResult | void>;

const MAX_WORKSPACE_CAS_ATTEMPTS = 4;

/** A user workspace click may race an older Browser-attention mutation from
 * this renderer. Rebase only across that locally attributable mutation and
 * only while this exact user intent remains current. */
export async function setActiveUserWorkspaceWithRebase(options: {
  workspaceId: string;
  expectedCurrentWorkspaceId: string | null;
  setActiveWorkspace: (
    workspaceId: string,
    expectedCurrentWorkspaceId: string | null,
  ) => Promise<ActiveWorkspaceCasResult>;
  isCurrent: () => boolean;
  canRebase: (result: ActiveWorkspaceCasResult) => boolean;
}): Promise<ActiveWorkspaceCasResult> {
  let expectedCurrentWorkspaceId = options.expectedCurrentWorkspaceId;
  let lastResult: ActiveWorkspaceCasResult = { ok: false };
  for (let attempt = 0; attempt < MAX_WORKSPACE_CAS_ATTEMPTS; attempt += 1) {
    if (!options.isCurrent()) return lastResult;
    const result = await options.setActiveWorkspace(options.workspaceId, expectedCurrentWorkspaceId);
    if (result.ok) return result;
    lastResult = result;
    if (!options.isCurrent() || !options.canRebase(result) || result.activeWorkspaceId === undefined) return result;
    expectedCurrentWorkspaceId = result.activeWorkspaceId;
  }
  return lastResult;
}

/** A newer Browser-attention request may observe a workspace CAS failure after
 * an older request commits first. Rebase only while this exact request still
 * owns navigation; user workspace/view/chat intent invalidates it immediately. */
export async function setActiveBrowserWorkspaceWithRebase(options: {
  workspaceId: string;
  expectedCurrentWorkspaceId: string | null;
  departingConversationId: string | null;
  setActiveWorkspace: (
    workspaceId: string,
    expectedCurrentWorkspaceId: string | null,
    departingConversationId: string | null,
  ) => Promise<ActiveWorkspaceCasResult>;
  isCurrent: () => boolean;
  canRebase: (result: ActiveWorkspaceCasResult) => boolean;
}): Promise<BrowserWorkspaceSwitchResult> {
  let expectedCurrentWorkspaceId = options.expectedCurrentWorkspaceId;
  let departingConversationId = options.departingConversationId;
  for (let attempt = 0; attempt < MAX_WORKSPACE_CAS_ATTEMPTS; attempt += 1) {
    const result = await options.setActiveWorkspace(
      options.workspaceId,
      expectedCurrentWorkspaceId,
      departingConversationId,
    );
    if (result.ok) return { ok: true, previousWorkspaceId: expectedCurrentWorkspaceId };
    if (
      !options.isCurrent() ||
      !options.canRebase(result) ||
      result.activeWorkspaceId === undefined ||
      result.activeWorkspaceLastConversationId === undefined
    )
      return { ok: false };
    expectedCurrentWorkspaceId = result.activeWorkspaceId;
    departingConversationId = result.activeWorkspaceLastConversationId;
  }
  return { ok: false };
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
  saveLastConversation: SaveWorkspaceLastConversation;
  getWorkspaceSelectionGeneration: () => number;
  workspaceSelectionGeneration: number;
  getBrowserAttentionGeneration: () => number;
  browserAttentionGeneration: number;
  setActiveWorkspace: (
    workspaceId: string | null,
    expectedCurrentWorkspaceId: string | null,
    operation: 'navigate' | 'rollback',
  ) => Promise<boolean | BrowserWorkspaceSwitchResult>;
  createWorkspaceObservationWait: (workspaceId: string) => WorkspaceObservationWait;
  adoptActiveWorkspaceTransition?: (workspaceId: string) => void;
  discardActiveWorkspaceTransition?: (workspaceId: string) => void;
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
  const selectionIsCompatibleAfterWorkspaceSwitch = (workspaceId: string): boolean =>
    options.getSelectionGeneration() === options.selectionGeneration &&
    options.getActiveWorkspaceId() === workspaceId &&
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
  const requestOwnsNavigation = options.getSelectionGeneration() === options.selectionGeneration;
  if (!requestOwnsNavigation) return false;
  if (conversation.workspaceId && conversation.workspaceId === activeWorkspaceAfterLookup) {
    options.adoptActiveWorkspaceTransition?.(conversation.workspaceId);
  }
  if (!selectionIsCurrent()) return false;
  const activeWorkspaceAtPreparation = activeWorkspaceAfterLookup;
  const targetWorkspaceId = conversation.workspaceId ?? null;
  const selectTargetConversation = async (): Promise<boolean> => {
    if (options.getActiveConversationId() === options.conversationId) return true;
    if (!selectionIsCurrent()) return false;
    return options.switchConversation(options.conversationId, backendSelectionWhenStarted, options.selectionGeneration);
  };

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
    isCurrentAfterSwitch: targetWorkspaceId
      ? () => selectionIsCompatibleAfterWorkspaceSwitch(targetWorkspaceId)
      : undefined,
    canRollbackStaleSwitch: () =>
      options.getWorkspaceSelectionGeneration() === options.workspaceSelectionGeneration &&
      options.getBrowserAttentionGeneration() === options.browserAttentionGeneration,
    discardActiveWorkspaceTransition: options.discardActiveWorkspaceTransition,
    commitConversationSelection: targetWorkspaceId ? selectTargetConversation : undefined,
  });
  if (!workspaceReady) return false;
  return targetWorkspaceId ? true : selectTargetConversation();
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
  saveLastConversation: SaveWorkspaceLastConversation;
  setActiveWorkspace: (
    workspaceId: string | null,
    expectedCurrentWorkspaceId: string | null,
    operation: 'navigate' | 'rollback',
  ) => Promise<boolean | BrowserWorkspaceSwitchResult>;
  createWorkspaceObservationWait: (workspaceId: string) => WorkspaceObservationWait;
  isCurrent?: () => boolean;
  isCurrentAfterSwitch?: () => boolean;
  canRollbackStaleSwitch?: () => boolean;
  discardActiveWorkspaceTransition?: (workspaceId: string) => void;
  commitConversationSelection?: () => Promise<boolean>;
}): Promise<boolean> {
  const targetWorkspaceId = options.conversationWorkspaceId;
  if (!targetWorkspaceId) return true;
  if (!new Set(options.knownWorkspaceIds).has(targetWorkspaceId)) return false;
  const observation = options.createWorkspaceObservationWait(targetWorkspaceId);
  let destinationUpdate: WorkspaceLastConversationCasResult | void;
  let committed = false;
  let switchedWorkspace = false;
  let previousWorkspaceId = options.activeWorkspaceId ?? null;
  const restoreDestination = async (): Promise<void> => {
    if (!destinationUpdate?.ok || destinationUpdate.previousConversationId === undefined) return;
    await options.saveLastConversation({
      workspaceId: targetWorkspaceId,
      conversationId: destinationUpdate.previousConversationId,
      expectedCurrentConversationId: options.conversationId,
    });
  };
  try {
    // The renderer's config can lag another window's workspace mutation. Always
    // write the destination cursor transactionally and perform the authoritative
    // workspace CAS, even when the cached workspace already equals the target.
    if (options.isCurrent?.() === false) return false;
    destinationUpdate = await options.saveLastConversation({
      workspaceId: targetWorkspaceId,
      conversationId: options.conversationId,
    });
    if (destinationUpdate && !destinationUpdate.ok) return false;
    if (options.isCurrent && !options.isCurrent()) return false;
    const switchResult = await options.setActiveWorkspace(
      targetWorkspaceId,
      options.activeWorkspaceId ?? null,
      'navigate',
    );
    const switched = typeof switchResult === 'boolean' ? switchResult : switchResult.ok;
    if (!switched) return false;
    previousWorkspaceId =
      typeof switchResult === 'boolean'
        ? (options.activeWorkspaceId ?? null)
        : switchResult.previousWorkspaceId === undefined
          ? (options.activeWorkspaceId ?? null)
          : switchResult.previousWorkspaceId;
    switchedWorkspace = previousWorkspaceId !== targetWorkspaceId;
    if (options.isCurrentAfterSwitch && !options.isCurrentAfterSwitch()) {
      return false;
    }
    const observed = await observation.promise;
    if (!observed) {
      options.discardActiveWorkspaceTransition?.(targetWorkspaceId);
      return false;
    }
    if (options.isCurrentAfterSwitch?.() === false) {
      return false;
    }
    if (options.commitConversationSelection && !(await options.commitConversationSelection())) {
      return false;
    }
    committed = true;
    return true;
  } finally {
    observation.cancel();
    if (!committed) {
      try {
        if (switchedWorkspace && options.canRollbackStaleSwitch?.()) {
          await options.setActiveWorkspace(previousWorkspaceId, targetWorkspaceId, 'rollback');
        }
      } finally {
        await restoreDestination();
      }
    }
  }
}

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
