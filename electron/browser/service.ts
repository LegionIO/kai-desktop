import { app, session, type BrowserWindow } from 'electron';
import type { AppConfig } from '../config/schema.js';
import { conversationExistenceState } from '../ipc/conversation-store.js';
import { BrowserManager } from './manager.js';
import { BrowserCredentialVault } from './credential-vault.js';
import { runBrowserDataClearOperations } from './data-clear.js';
import { runBrowserSessionOperation } from './session-operations.js';
import { removeAssistantDownloadQuarantineForScope } from './download-quarantine.js';
import { browserPartitionForScopeKey, browserScopeKey } from './session.js';
import { BrowserProfileStore } from './store.js';
import { stopRunningBrowserServiceWorkers } from './service-workers.js';
import { removeBrowserScreenshotsForConversation } from './screenshot-store.js';
import {
  clearPendingBrowserCleanupScopeKey,
  hasStoredBrowserScopeData,
  markChromiumBrowserScopeCleared,
  markPendingBrowserCleanupScopeKey,
} from './profile-data.js';

let manager: BrowserManager | null = null;
const conversationRemovalsInFlight = new Map<string, number>();

function beginConversationRemoval(conversationId: string): () => void {
  conversationRemovalsInFlight.set(conversationId, (conversationRemovalsInFlight.get(conversationId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (conversationRemovalsInFlight.get(conversationId) ?? 1) - 1;
    if (remaining > 0) conversationRemovalsInFlight.set(conversationId, remaining);
    else conversationRemovalsInFlight.delete(conversationId);
  };
}
export const BROWSER_SHUTDOWN_TIMEOUT_MS = 10_000;
/** Hard process-exit fallbacks must leave the graceful browser barrier time to
 * finish, plus a small margin for the quit handler to re-enter app.quit(). */
export const BROWSER_FORCE_EXIT_GRACE_MS = BROWSER_SHUTDOWN_TIMEOUT_MS + 2_000;

export function initializeBrowserManager(
  appHome: string,
  getConfig: () => AppConfig,
  getWindow: () => BrowserWindow | null,
  pagePreloadPath: string,
): BrowserManager {
  if (manager) {
    throw new Error('The in-app Browser manager is already initialized; await replacement shutdown first.');
  }
  const next = new BrowserManager(appHome, getConfig, getWindow, pagePreloadPath, (conversationId) => {
    if (conversationRemovalsInFlight.has(conversationId)) return false;
    // Distinguish a GENUINELY-absent conversation (deleted → fence) from a TRANSIENT read failure
    // (EMFILE/EACCES → do NOT permanently fence a live conversation's Browser access; R178). A
    // tri-state 'unknown' THROWS so the manager's isConversationAvailable catch denies access this
    // once without fencing; only a definitive 'absent' returns false (→ fence).
    const state = conversationExistenceState(appHome, conversationId);
    if (state === 'unknown') throw new Error('conversation existence unknown (transient read failure)');
    return state === 'exists';
  });
  // A headless profile clear can yield to Chromium before a GUI promotion
  // creates this manager. Fence every such conversation before publishing the
  // manager so no tab/session can enter the partition outside the clear queue.
  for (const conversationId of conversationRemovalsInFlight.keys()) next.fenceRemovedConversation(conversationId);
  manager = next;
  return next;
}

/** Replace the Browser service only after its persistent sessions, workers,
 * profile mutations, and native views have crossed the graceful shutdown
 * barrier. A failed shutdown keeps the old manager authoritative and guarded. */
export async function replaceBrowserManager(
  appHome: string,
  getConfig: () => AppConfig,
  getWindow: () => BrowserWindow | null,
  pagePreloadPath: string,
): Promise<BrowserManager> {
  const previous = manager;
  if (previous) {
    await previous.shutdown();
    if (manager === previous) manager = null;
  }
  return initializeBrowserManager(appHome, getConfig, getWindow, pagePreloadPath);
}

export function getBrowserManager(): BrowserManager {
  if (!manager) throw new Error('The in-app browser is unavailable in this process.');
  return manager;
}

export function getExistingBrowserManager(): BrowserManager | null {
  return manager;
}

type PreparedBrowserConversationRemoval = {
  conversationId: string;
  scopeKey: string;
  finish: () => void;
  managerRemoval?: Promise<void>;
  headlessProfileCleanup?: boolean;
  pendingCleanupMarkerInstalled?: boolean;
  preparationError?: unknown;
};

/** Establish the deletion fence synchronously. Bulk callers prepare every
 * target before awaiting any profile clear, so a slow first clear cannot leave
 * later deleted conversations with live renderers or unrestricted workers. */
function prepareBrowserConversationRemoval(
  appHome: string,
  conversationId: string,
): PreparedBrowserConversationRemoval {
  const scopeKey = browserScopeKey('conversation', conversationId);
  const finish = beginConversationRemoval(conversationId);
  try {
    if (manager) {
      // removeConversation fences the id and destroys its views synchronously
      // before its first await. Attach a rejection observer immediately because
      // a later entry may be awaited only after an earlier cleanup completes.
      const managerRemoval = manager.removeConversation(conversationId);
      void managerRemoval.catch(() => undefined);
      return { conversationId, scopeKey, finish, managerRemoval };
    }
    if (hasStoredBrowserScopeData(appHome, app.getPath('sessionData'), scopeKey)) {
      // Quarantine every deleted profile durably before the bulk caller awaits
      // its first clear. Do not instantiate every persistent Electron Session
      // here: those native objects are heavyweight and a large clear-all would
      // otherwise retain an unbounded set of them at once. The in-flight fence
      // also prevents a manager promoted during cleanup from opening this chat.
      markPendingBrowserCleanupScopeKey(appHome, scopeKey);
      return {
        conversationId,
        scopeKey,
        finish,
        headlessProfileCleanup: true,
        pendingCleanupMarkerInstalled: true,
      };
    }
    return { conversationId, scopeKey, finish };
  } catch (preparationError) {
    return { conversationId, scopeKey, finish, preparationError };
  }
}

async function completeBrowserConversationRemoval(
  appHome: string,
  prepared: PreparedBrowserConversationRemoval,
): Promise<void> {
  const {
    conversationId,
    scopeKey,
    finish,
    managerRemoval,
    headlessProfileCleanup,
    pendingCleanupMarkerInstalled,
    preparationError,
  } = prepared;
  let pendingCleanupMarkerNeedsRestore = pendingCleanupMarkerInstalled !== true;
  try {
    if (preparationError) throw preparationError;
    if (managerRemoval) {
      await managerRemoval;
    } else if (headlessProfileCleanup && manager) {
      // A GUI manager may be promoted while an earlier bulk entry is clearing.
      // Let it own this profile's Session and request-policy lifecycle instead of
      // installing a second headless hook on the same persistent partition.
      await manager.removeConversation(conversationId);
    } else if (headlessProfileCleanup) {
      const scopedSession = session.fromPartition(browserPartitionForScopeKey(scopeKey));
      const requestFilter = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] };
      // Materialize only the profile currently being cleared, then install its
      // fail-closed guard before any worker or connection shutdown can yield.
      scopedSession.webRequest.onBeforeRequest(requestFilter, (_details, callback) => callback({ cancel: true }));
      let cleanupSucceeded = false;
      try {
        // A headless profile can still own service workers and pooled sockets.
        // Quiesce both before clearing storage so background code cannot race the
        // clear or immediately repopulate it. Failure leaves the retry marker.
        await stopRunningBrowserServiceWorkers(scopedSession, undefined, true);
        await runBrowserSessionOperation(scopedSession, 'Browser conversation connection reset', () =>
          scopedSession.closeAllConnections(),
        );
        await runBrowserDataClearOperations(`Browser profile ${scopeKey}`, [
          {
            label: 'Chromium storage',
            run: () =>
              runBrowserSessionOperation(scopedSession, 'Browser conversation Chromium storage clear', () =>
                scopedSession.clearStorageData(),
              ),
          },
          {
            label: 'Chromium cache',
            run: () =>
              runBrowserSessionOperation(scopedSession, 'Browser conversation Chromium cache clear', () =>
                scopedSession.clearCache(),
              ),
          },
          {
            label: 'HTTP authentication cache',
            run: () =>
              runBrowserSessionOperation(scopedSession, 'Browser conversation HTTP authentication cache clear', () =>
                scopedSession.clearAuthCache(),
              ),
          },
          {
            label: 'assistant download quarantine',
            run: () => removeAssistantDownloadQuarantineForScope(appHome, scopeKey),
          },
          {
            label: 'history, bookmarks, permissions, and downloads',
            run: () => new BrowserProfileStore(appHome, scopeKey).clear(),
          },
          { label: 'saved passwords', run: () => new BrowserCredentialVault(scopeKey, appHome).clear() },
        ]);
        markChromiumBrowserScopeCleared(appHome, scopeKey);
        cleanupSucceeded = true;
      } finally {
        // A failed worker stop, connection drain, or clear can leave executable
        // background state in this persistent partition. Keep the deny-all
        // request hook installed until a later retry proves the profile clear
        // completed; removing it here would restore network access fail-open.
        if (cleanupSucceeded && (!manager || !manager.managesSession(scopeKey, scopedSession))) {
          scopedSession.webRequest.onBeforeRequest(null);
        }
        // A GUI promotion may initialize BrowserManager while this headless
        // clear is awaiting Chromium. Preserve the listener only if that manager
        // adopted this exact Session and replaced it with its full request
        // policy; otherwise the headless deny hook has no remaining owner and
        // must be removed so the Session can be reclaimed.
      }
    }
    removeBrowserScreenshotsForConversation(appHome, conversationId);
    // clearPendingBrowserCleanupScopeKey removes the exact sidecar before it
    // validates/migrates legacy metadata. If that validation fails, restore the
    // sidecar in the catch path so this profile remains explicitly retryable.
    pendingCleanupMarkerNeedsRestore = true;
    if (!clearPendingBrowserCleanupScopeKey(appHome, scopeKey)) {
      throw new Error('Pending Browser-profile cleanup metadata remains unreadable; cleanup stays quarantined.');
    }
    pendingCleanupMarkerNeedsRestore = false;
  } catch (error) {
    if (pendingCleanupMarkerNeedsRestore) {
      try {
        markPendingBrowserCleanupScopeKey(appHome, scopeKey);
      } catch (markerError) {
        console.warn('[Browser] Failed to retain pending conversation-profile cleanup:', scopeKey, markerError);
      }
    }
    throw error;
  } finally {
    finish();
  }
}

/** Remove a conversation-owned tab set and its persistent browser profile even
 * when Kai is running headlessly and no BrowserManager/window was initialized. */
export async function removeBrowserConversationData(appHome: string, conversationId: string): Promise<void> {
  await completeBrowserConversationRemoval(appHome, prepareBrowserConversationRemoval(appHome, conversationId));
}

/** Bounded bulk cleanup used by delete-many/clear-all. It deliberately runs
 * sequentially: BrowserManager profile clears already serialize internally,
 * and headless Electron sessions are heavyweight. Continue after individual
 * failures so callers can surface precise warning ids. */
export async function removeBrowserConversationsData(
  appHome: string,
  conversationIds: Iterable<string>,
): Promise<string[]> {
  // Preparation is synchronous up to the manager's first await. Consequently
  // every target is fenced, every live view is destroyed, and every headless
  // profile has a durable quarantine marker before any one profile can wait on
  // downloads, workers, Chromium, or persistent storage. Headless Sessions are
  // then materialized one at a time by the sequential completion loop.
  const removals = [...new Set(conversationIds)].map((conversationId) =>
    prepareBrowserConversationRemoval(appHome, conversationId),
  );
  const failures: string[] = [];
  for (const removal of removals) {
    try {
      await completeBrowserConversationRemoval(appHome, removal);
    } catch (error) {
      console.warn('[Browser] Conversation profile cleanup failed:', removal.conversationId, error);
      failures.push(removal.conversationId);
    }
  }
  return failures;
}

export async function disposeBrowserManager(): Promise<void> {
  const current = manager;
  if (!current) return;
  await current.shutdown();
  if (manager === current) manager = null;
}

/** Graceful app shutdown barrier. Quiesce renderer/download callbacks before
 * the manager performs its final durable profile flush. */
export async function shutdownBrowserManager(timeoutMs = BROWSER_SHUTDOWN_TIMEOUT_MS): Promise<void> {
  const current = manager;
  if (!current) return;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let completed = false;
  const gracefulShutdown = current.shutdown();
  // If the caller's deadline expires but Chromium later quiesces successfully,
  // retire the completed service then. Until that point the manager remains
  // reachable so its request guards and views cannot become unowned.
  void gracefulShutdown.then(
    () => {
      if (manager === current) manager = null;
    },
    () => undefined,
  );
  try {
    await Promise.race([
      gracefulShutdown,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => {
            reject(new Error(`Browser shutdown exceeded its ${timeoutMs} ms deadline.`));
          },
          Math.max(0, timeoutMs),
        );
        timeout.unref?.();
      }),
    ]);
    completed = true;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (completed && manager === current) manager = null;
  }
}
