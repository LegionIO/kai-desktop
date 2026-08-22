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

/** A bare active-id broadcast carries no conversation-record update. Ignore it
 * when it already matches this renderer's selection: setActiveId emits this
 * notification before the initiating IPC promise resolves, and treating that
 * acknowledgement as a fresh async refresh would invalidate the very local
 * selection transaction that caused it. */
export function isRedundantActiveConversationBroadcast(
  mySelection: string | null,
  change: { kind: 'upsert' | 'delete' | 'reset' | 'active'; activeConversationId?: string | null },
): boolean {
  return change.kind === 'active' && mySelection !== null && change.activeConversationId === mySelection;
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

/** A same-workspace set can never produce a workspace-ID effect. Rollbacks do
 * need provenance: without it the workspace effect can mistake the selected
 * source chat for the chat departing the failed destination and corrupt that
 * destination's saved cursor. */
export function createBrowserWorkspaceTransitionMarker(options: {
  navigationGeneration: number;
  browserAttentionGeneration: number;
  workspaceSelectionGeneration: number;
  operation: 'navigate' | 'rollback';
  departingWorkspaceId: string | null;
  destinationWorkspaceId: string | null;
  departingConversationId: string | null;
}): BrowserWorkspaceTransitionMarker | undefined {
  if (options.departingWorkspaceId === options.destinationWorkspaceId) return undefined;
  return options.operation === 'rollback'
    ? {
        ...options,
        // Destination metadata is restored transactionally by the failed
        // Browser navigation. The workspace effect must neither overwrite it
        // nor restore another chat over the user's surviving selection.
        departingConversationId: null,
        suppressArrivingWorkspaceRestoration: true,
      }
    : options;
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
      (options.browserTransition?.operation === 'rollback' ||
        (options.browserTransition?.operation === 'navigate' &&
          (options.browserTransition.suppressArrivingWorkspaceRestoration === true ||
            options.browserTransition.browserAttentionGeneration < options.currentBrowserAttentionGeneration))));
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
  activeConversationRevision?: number;
};

export type ActiveConversationState = {
  activeConversationId: string | null;
  activeConversationRevision: number;
};

export type ConversationActivationDisposition = 'foreground' | 'background' | 'superseded';

/** A Browser attention request owns two related decisions: which conversation
 * is selected and whether Chat should be brought to the foreground. A newer
 * view-only navigation revokes only the latter; once the backend activation
 * succeeds, still commit its selection locally so renderer and main cannot
 * diverge after the matching active-id broadcast was treated as an ack. */
export function resolveConversationActivationDisposition(options: {
  sequence: number;
  currentSequence: number;
  conversationId: string;
  currentConversationId: string | null;
  conversationSelectionGeneration: number;
  currentConversationSelectionGeneration: number;
  navigationGeneration: number;
  currentNavigationGeneration: number;
}): ConversationActivationDisposition {
  if (
    options.sequence !== options.currentSequence ||
    options.currentConversationId !== options.conversationId ||
    options.conversationSelectionGeneration !== options.currentConversationSelectionGeneration
  ) {
    return 'superseded';
  }
  return options.navigationGeneration === options.currentNavigationGeneration ? 'foreground' : 'background';
}

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
  /** Current authoritative workspace when a compare-and-set is rejected. */
  activeWorkspaceId?: string | null;
  /** Current authoritative mutation owner when known. */
  activeWorkspaceMutationToken?: string | null;
};

export type StaleWorkspaceSwitchDisposition = 'rollback' | 'retain' | 'superseded';

export type WorkspaceLastConversationCasResult = {
  ok: boolean;
  error?: 'workspace-not-found' | 'last-conversation-changed';
  previousConversationId?: string | null;
  lastActiveConversationId?: string | null;
  lastActiveConversationMutationToken?: string | null;
};

type SaveWorkspaceLastConversation = (args: {
  workspaceId: string;
  conversationId: string | null;
  expectedCurrentConversationId?: string | null;
  expectedCurrentMutationToken?: string | null;
  mutationToken?: string;
}) => Promise<WorkspaceLastConversationCasResult | void>;

const MAX_WORKSPACE_CAS_ATTEMPTS = 4;

// Browser-attention requests may resolve their conversation records in either
// order, but their destination-cursor writes and workspace CAS/rollback pairs
// form one transaction chain. Serialize only that stateful portion: lookups
// remain concurrent, while every canceled transition fully restores its
// predecessor before the next request can mutate workspace state.
let browserWorkspaceTransitionTail: Promise<void> = Promise.resolve();

function serializeBrowserWorkspaceTransition<T>(operation: () => Promise<T>): Promise<T> {
  const result = browserWorkspaceTransitionTail.then(operation, operation);
  browserWorkspaceTransitionTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** A user workspace click may race an older Browser-attention or user mutation
 * from this renderer. Rebase only across that locally attributable mutation,
 * reuse one provenance token for every attempt, and stop as soon as a newer
 * user intent takes ownership. */
export async function setActiveUserWorkspaceWithRebase(options: {
  workspaceId: string;
  expectedCurrentWorkspaceId: string | null;
  mutationToken: string;
  setActiveWorkspace: (
    workspaceId: string | null,
    expectedCurrentWorkspaceId: string | null,
    mutationToken: string,
    expectedCurrentMutationToken?: string,
  ) => Promise<ActiveWorkspaceCasResult>;
  isCurrent: () => boolean;
  canRebase: (result: ActiveWorkspaceCasResult) => boolean;
}): Promise<ActiveWorkspaceCasResult> {
  let expectedCurrentWorkspaceId = options.expectedCurrentWorkspaceId;
  let expectedCurrentMutationToken: string | undefined;
  let lastResult: ActiveWorkspaceCasResult = { ok: false };
  for (let attempt = 0; attempt < MAX_WORKSPACE_CAS_ATTEMPTS; attempt += 1) {
    if (!options.isCurrent()) return lastResult;
    const result =
      expectedCurrentMutationToken === undefined
        ? await options.setActiveWorkspace(options.workspaceId, expectedCurrentWorkspaceId, options.mutationToken)
        : await options.setActiveWorkspace(
            options.workspaceId,
            expectedCurrentWorkspaceId,
            options.mutationToken,
            expectedCurrentMutationToken,
          );
    if (result.ok) {
      if (options.isCurrent()) return result;
      // The stale request committed while a newer navigation intent was taking
      // ownership. Undo only our exact mutation: both workspace id and token
      // participate in the CAS, so a newer same-destination click still wins.
      const rollback = await options.setActiveWorkspace(
        expectedCurrentWorkspaceId,
        options.workspaceId,
        options.mutationToken,
        options.mutationToken,
      );
      if (!rollback.ok) return rollback;
      return {
        ok: false,
        error: 'active-workspace-changed',
        activeWorkspaceId: expectedCurrentWorkspaceId,
        activeWorkspaceMutationToken: options.mutationToken,
      };
    }
    lastResult = result;
    if (
      !options.isCurrent() ||
      !options.canRebase(result) ||
      result.activeWorkspaceId === undefined ||
      typeof result.activeWorkspaceMutationToken !== 'string'
    )
      return result;
    expectedCurrentWorkspaceId = result.activeWorkspaceId;
    expectedCurrentMutationToken = result.activeWorkspaceMutationToken;
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
    expectedCurrentMutationToken?: string,
  ) => Promise<ActiveWorkspaceCasResult>;
  isCurrent: () => boolean;
  canRebase: (result: ActiveWorkspaceCasResult) => boolean;
}): Promise<BrowserWorkspaceSwitchResult> {
  let expectedCurrentWorkspaceId = options.expectedCurrentWorkspaceId;
  let departingConversationId = options.departingConversationId;
  let expectedCurrentMutationToken: string | undefined;
  for (let attempt = 0; attempt < MAX_WORKSPACE_CAS_ATTEMPTS; attempt += 1) {
    const result =
      expectedCurrentMutationToken === undefined
        ? await options.setActiveWorkspace(options.workspaceId, expectedCurrentWorkspaceId, departingConversationId)
        : await options.setActiveWorkspace(
            options.workspaceId,
            expectedCurrentWorkspaceId,
            departingConversationId,
            expectedCurrentMutationToken,
          );
    if (result.ok) return { ok: true, previousWorkspaceId: expectedCurrentWorkspaceId };
    if (
      !options.isCurrent() ||
      !options.canRebase(result) ||
      result.activeWorkspaceId === undefined ||
      result.activeWorkspaceLastConversationId === undefined ||
      typeof result.activeWorkspaceMutationToken !== 'string'
    )
      return { ok: false };
    expectedCurrentWorkspaceId = result.activeWorkspaceId;
    departingConversationId = result.activeWorkspaceLastConversationId;
    expectedCurrentMutationToken = result.activeWorkspaceMutationToken;
  }
  return { ok: false };
}

export async function openBrowserConversationInWorkspace(options: {
  conversationId: string;
  selectionGeneration: number;
  conversationSelectionGeneration: number;
  workspaceMutationToken: string;
  getConversation: (conversationId: string) => Promise<{ workspaceId?: string | null } | null>;
  getActiveConversationId: () => string | null;
  getBackendActiveConversationState: () => Promise<ActiveConversationState>;
  getSelectionGeneration: () => number;
  getConversationSelectionGeneration: () => number;
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
    expectedCurrentMutationToken?: string,
  ) => Promise<boolean | BrowserWorkspaceSwitchResult>;
  createWorkspaceObservationWait: (workspaceId: string) => WorkspaceObservationWait;
  adoptActiveWorkspaceTransition?: (workspaceId: string) => void;
  retainActiveWorkspaceTransition?: (workspaceId: string) => void;
  discardActiveWorkspaceTransition?: (workspaceId: string) => void;
  switchConversation: (
    conversationId: string,
    expectedCurrentConversationId: string | null,
    selectionGeneration: number,
    expectedCurrentConversationRevision: number,
    conversationSelectionGeneration: number,
  ) => Promise<boolean>;
}): Promise<boolean> {
  const selectionWhenStarted = options.getActiveConversationId();
  const selectionIsCurrent = (): boolean =>
    options.getSelectionGeneration() === options.selectionGeneration &&
    options.getActiveConversationId() === selectionWhenStarted;
  const selectionIntentIsCompatibleAfterWorkspaceSwitch = (): boolean =>
    options.getSelectionGeneration() === options.selectionGeneration &&
    (options.getActiveConversationId() === selectionWhenStarted ||
      options.getActiveConversationId() === options.conversationId);
  const selectionIsCompatibleAfterWorkspaceSwitch = (workspaceId: string): boolean =>
    selectionIntentIsCompatibleAfterWorkspaceSwitch() && options.getActiveWorkspaceId() === workspaceId;
  const [conversation, backendSelectionWhenStarted] = await Promise.all([
    options.getConversation(options.conversationId),
    options.getBackendActiveConversationState(),
  ]);
  if (!conversation) return false;

  const targetWorkspaceId = conversation.workspaceId ?? null;
  const selectTargetConversation = async (): Promise<boolean> => {
    if (options.getActiveConversationId() === options.conversationId) return true;
    if (!selectionIsCurrent()) return false;
    return options.switchConversation(
      options.conversationId,
      backendSelectionWhenStarted.activeConversationId,
      options.selectionGeneration,
      backendSelectionWhenStarted.activeConversationRevision,
      options.conversationSelectionGeneration,
    );
  };
  if (!targetWorkspaceId) {
    if (!selectionIsCurrent()) return false;
    return selectTargetConversation();
  }

  return serializeBrowserWorkspaceTransition(async () => {
    // Read workspace state only after both the async record lookup and earlier
    // Browser transitions. A faster successor may enter first; the generation
    // check then makes this stale request a no-op.
    const activeWorkspaceAtPreparation = options.getActiveWorkspaceId();
    if (options.getSelectionGeneration() !== options.selectionGeneration) return false;
    // Adoption is transaction ownership. Perform it under the same queue as
    // rollback so an older request cannot relinquish its marker in the gap
    // between a newer request's lookup and this transfer.
    if (targetWorkspaceId === activeWorkspaceAtPreparation) {
      options.adoptActiveWorkspaceTransition?.(targetWorkspaceId);
    }
    if (!selectionIsCurrent()) return false;

    const workspaceReady = await prepareConversationWorkspaceSwitch({
      conversationId: options.conversationId,
      conversationWorkspaceId: targetWorkspaceId,
      activeWorkspaceId: activeWorkspaceAtPreparation,
      workspaceMutationToken: options.workspaceMutationToken,
      knownWorkspaceIds: options.getKnownWorkspaceIds(),
      saveLastConversation: options.saveLastConversation,
      setActiveWorkspace: options.setActiveWorkspace,
      createWorkspaceObservationWait: options.createWorkspaceObservationWait,
      isCurrent: () => selectionIsCurrent() && options.getActiveWorkspaceId() === activeWorkspaceAtPreparation,
      isCurrentAfterSwitchIntent: selectionIntentIsCompatibleAfterWorkspaceSwitch,
      isCurrentAfterSwitch: () => selectionIsCompatibleAfterWorkspaceSwitch(targetWorkspaceId),
      resolveStaleSwitchDisposition: async () => {
        // Explicit workspace selection owns the authoritative state and must
        // never be overwritten by Browser rollback.
        if (options.getWorkspaceSelectionGeneration() !== options.workspaceSelectionGeneration) {
          return 'superseded';
        }
        // A newer Browser request cannot have entered this serialized mutation
        // section yet. Restore our predecessor first; its successor will then
        // adopt or create a transition from that authoritative state.
        if (options.getBrowserAttentionGeneration() !== options.browserAttentionGeneration) {
          return 'rollback';
        }
        if (options.getConversationSelectionGeneration() === options.conversationSelectionGeneration) {
          return 'rollback';
        }

        // A newer user chat choice should keep the Browser-selected workspace
        // only when that chat actually belongs to the destination. Follow rapid
        // choices until one snapshot survives its local record read.
        for (let attempt = 0; attempt < MAX_WORKSPACE_CAS_ATTEMPTS; attempt += 1) {
          const selectedConversationId = options.getActiveConversationId();
          if (!selectedConversationId) return 'rollback';
          const selectedConversationGeneration = options.getConversationSelectionGeneration();
          let selectedConversation: { workspaceId?: string | null } | null = null;
          try {
            selectedConversation = await options.getConversation(selectedConversationId);
          } catch {
            // Only a positively identified destination chat suppresses rollback.
          }
          if (options.getWorkspaceSelectionGeneration() !== options.workspaceSelectionGeneration) {
            return 'superseded';
          }
          if (options.getBrowserAttentionGeneration() !== options.browserAttentionGeneration) {
            return 'rollback';
          }
          if (
            options.getConversationSelectionGeneration() !== selectedConversationGeneration ||
            options.getActiveConversationId() !== selectedConversationId
          ) {
            continue;
          }
          if (selectedConversation?.workspaceId !== targetWorkspaceId) return 'rollback';
          if (options.getActiveWorkspaceId() !== targetWorkspaceId) return 'superseded';
          options.retainActiveWorkspaceTransition?.(targetWorkspaceId);
          return 'retain';
        }
        return 'rollback';
      },
      discardActiveWorkspaceTransition: options.discardActiveWorkspaceTransition,
      commitConversationSelection: selectTargetConversation,
    });
    return workspaceReady;
  });
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
  workspaceMutationToken: string;
  knownWorkspaceIds: Iterable<string>;
  saveLastConversation: SaveWorkspaceLastConversation;
  setActiveWorkspace: (
    workspaceId: string | null,
    expectedCurrentWorkspaceId: string | null,
    operation: 'navigate' | 'rollback',
    expectedCurrentMutationToken?: string,
  ) => Promise<boolean | BrowserWorkspaceSwitchResult>;
  createWorkspaceObservationWait: (workspaceId: string) => WorkspaceObservationWait;
  isCurrent?: () => boolean;
  /** Check post-mutation ownership without requiring React's workspace cursor,
   * which is expected to lag until createWorkspaceObservationWait resolves. */
  isCurrentAfterSwitchIntent?: () => boolean;
  isCurrentAfterSwitch?: () => boolean;
  resolveStaleSwitchDisposition?: () => StaleWorkspaceSwitchDisposition | Promise<StaleWorkspaceSwitchDisposition>;
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
  let shouldDiscardTransition = true;
  let shouldRestoreDestination = true;
  let previousWorkspaceId = options.activeWorkspaceId ?? null;
  const restoreDestination = async (): Promise<void> => {
    if (!destinationUpdate?.ok || destinationUpdate.previousConversationId === undefined) return;
    await options.saveLastConversation({
      workspaceId: targetWorkspaceId,
      conversationId: destinationUpdate.previousConversationId,
      expectedCurrentConversationId: options.conversationId,
      expectedCurrentMutationToken: options.workspaceMutationToken,
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
      mutationToken: options.workspaceMutationToken,
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
    if (options.isCurrentAfterSwitchIntent?.() === false) return false;
    const observed = await observation.promise;
    if (!observed) return false;
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
        if (switchedWorkspace) {
          try {
            const disposition = (await options.resolveStaleSwitchDisposition?.()) ?? 'superseded';
            if (disposition === 'rollback') {
              const rollbackResult = await options.setActiveWorkspace(
                previousWorkspaceId,
                targetWorkspaceId,
                'rollback',
                options.workspaceMutationToken,
              );
              const rolledBack = typeof rollbackResult === 'boolean' ? rollbackResult : rollbackResult.ok;
              if (!rolledBack) {
                const authoritativeWorkspaceId =
                  typeof rollbackResult === 'boolean' ? undefined : rollbackResult.activeWorkspaceId;
                const authoritativeMutationToken =
                  typeof rollbackResult === 'boolean' ? undefined : rollbackResult.activeWorkspaceMutationToken;
                // Preserve the marker only when the failed rollback may have
                // left the destination authoritative. A rejected CAS that names
                // another workspace or another mutation owner proves that owner
                // will reconcile the edge.
                shouldDiscardTransition =
                  (authoritativeWorkspaceId !== undefined && authoritativeWorkspaceId !== targetWorkspaceId) ||
                  (authoritativeMutationToken !== undefined &&
                    authoritativeMutationToken !== options.workspaceMutationToken);
              }
            } else if (disposition === 'retain') {
              // A newer user selection intentionally owns the destination.
              // Restoring the Browser request's previous cursor would replace
              // that retained workspace with stale metadata.
              shouldRestoreDestination = false;
            }
          } catch (error) {
            shouldDiscardTransition = false;
            throw error;
          }
        }
      } finally {
        try {
          // Relinquish the exact marker this request created or adopted unless
          // a failed rollback left the destination authoritative. In that case
          // the marker must survive so React can reconcile its lagging cursor.
          // The callback generation-checks this request, so a newer Browser
          // request's marker remains untouched.
          if (shouldDiscardTransition) options.discardActiveWorkspaceTransition?.(targetWorkspaceId);
        } finally {
          if (shouldRestoreDestination) await restoreDestination();
        }
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
