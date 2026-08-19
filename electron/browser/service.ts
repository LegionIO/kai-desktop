import { app, session, type BrowserWindow, type Session } from 'electron';
import type { AppConfig } from '../config/schema.js';
import { conversationExistenceState } from '../ipc/conversation-store.js';
import { BrowserManager } from './manager.js';
import { BrowserCredentialVault } from './credential-vault.js';
import { runBrowserDataClearOperations } from './data-clear.js';
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

/** Remove a conversation-owned tab set and its persistent browser profile even
 * when Kai is running headlessly and no BrowserManager/window was initialized. */
export async function removeBrowserConversationData(appHome: string, conversationId: string): Promise<void> {
  const scopeKey = browserScopeKey('conversation', conversationId);
  const finishConversationRemoval = beginConversationRemoval(conversationId);
  try {
    if (manager) {
      await manager.removeConversation(conversationId);
    } else if (hasStoredBrowserScopeData(appHome, app.getPath('sessionData'), scopeKey)) {
      let targetSession: Session | undefined;
      const getTargetSession = () => {
        targetSession ??= session.fromPartition(browserPartitionForScopeKey(scopeKey));
        return targetSession;
      };
      const scopedSession = getTargetSession();
      const requestFilter = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] };
      scopedSession.webRequest.onBeforeRequest(requestFilter, (_details, callback) => callback({ cancel: true }));
      let cleanupSucceeded = false;
      try {
        // A headless profile can still own service workers and pooled sockets.
        // Quiesce both before clearing storage so background code cannot race the
        // clear or immediately repopulate it. Failure leaves the retry marker.
        await stopRunningBrowserServiceWorkers(scopedSession, undefined, true);
        await scopedSession.closeAllConnections();
        await runBrowserDataClearOperations(`Browser profile ${scopeKey}`, [
          { label: 'Chromium storage', run: () => scopedSession.clearStorageData() },
          { label: 'Chromium cache', run: () => scopedSession.clearCache() },
          { label: 'HTTP authentication cache', run: () => scopedSession.clearAuthCache() },
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
        if (cleanupSucceeded && !manager) {
          scopedSession.webRequest.onBeforeRequest(null);
        }
        // A GUI promotion may initialize BrowserManager while this headless
        // clear is awaiting Chromium. In that case its wireSession call either
        // already replaced this deny-all listener or will replace it when the
        // profile is next used. Do not clear the shared Session listener here:
        // Electron supports only one onBeforeRequest listener, so doing so
        // would silently remove the manager's newly installed AI policy.
      }
    }
    removeBrowserScreenshotsForConversation(appHome, conversationId);
    if (!clearPendingBrowserCleanupScopeKey(appHome, scopeKey)) {
      throw new Error('Pending Browser-profile cleanup metadata remains unreadable; cleanup stays quarantined.');
    }
  } catch (error) {
    try {
      markPendingBrowserCleanupScopeKey(appHome, scopeKey);
    } catch (markerError) {
      console.warn('[Browser] Failed to retain pending conversation-profile cleanup:', scopeKey, markerError);
    }
    throw error;
  } finally {
    finishConversationRemoval();
  }
}

/** Bounded bulk cleanup used by delete-many/clear-all. It deliberately runs
 * sequentially: BrowserManager profile clears already serialize internally,
 * and headless Electron sessions are heavyweight. Continue after individual
 * failures so callers can surface precise warning ids. */
export async function removeBrowserConversationsData(
  appHome: string,
  conversationIds: Iterable<string>,
): Promise<string[]> {
  const failures: string[] = [];
  for (const conversationId of new Set(conversationIds)) {
    try {
      await removeBrowserConversationData(appHome, conversationId);
    } catch (error) {
      console.warn('[Browser] Conversation profile cleanup failed:', conversationId, error);
      failures.push(conversationId);
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
