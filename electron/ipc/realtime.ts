/**
 * IPC handlers for the Realtime Audio session.
 * Bridges the renderer process to the RealtimeSession in the main process.
 */

import { join } from 'path';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { RealtimeSession } from '../realtime/realtime-session.js';
import { buildRealtimeMemoryContext } from '../realtime/realtime-context.js';
import type { AppConfig } from '../config/schema.js';
import type { ToolDefinition } from '../tools/types.js';
import { getExistingBrowserManager } from '../browser/service.js';
import { recordUsageEvent } from './usage.js';
import { dismissPendingNativeBrowserApprovalsForOwner, type ToolApprovalAuthority } from './tool-approval.js';

let activeSession: RealtimeSession | null = null;
let sessionStartTime: string | null = null;
let sessionConversationId: string | null = null;
let activeSessionBrowserInitiated = false;
let activeSessionAllowsBrowserTools = false;
let pendingStart: {
  generation: number;
  conversationId: string;
  session: RealtimeSession | null;
  browserInitiated: boolean;
  allowsBrowserTools: boolean;
  browserToolsRevoked: boolean;
} | null = null;
/**
 * Monotonic start generation. Bumped at the top of BOTH start-session and
 * end-session. `start-session` awaits memory-context building BEFORE the session
 * object exists, so an end-session (hangup) or a second start during that window
 * can't cancel the in-flight start. Each start captures its generation and, after
 * every async gap, bails (+ tears down anything it created) if a newer start or an
 * end has since bumped the counter — so a pending start can't outlive a hangup or
 * race an overlapping start.
 */
let startGeneration = 0;
const assistantTabCleanupTails = new Map<string, Promise<void>>();

function scheduleAssistantTabCleanup(conversationId: string, browserOwnerId: string): Promise<void> {
  const previous = assistantTabCleanupTails.get(conversationId) ?? Promise.resolve();
  const browserManager = getExistingBrowserManager();
  const cleanup = previous.then(async () => {
    try {
      await browserManager?.cleanupAssistantTabs(conversationId, browserOwnerId);
    } catch (error) {
      console.warn('[Realtime IPC] Failed to reclaim Browser assistant tabs:', error);
    }
  });
  assistantTabCleanupTails.set(conversationId, cleanup);
  void cleanup.then(() => {
    if (assistantTabCleanupTails.get(conversationId) === cleanup) assistantTabCleanupTails.delete(conversationId);
  });
  return cleanup;
}

function waitForAssistantTabCleanup(conversationId: string): Promise<void> {
  return assistantTabCleanupTails.get(conversationId) ?? Promise.resolve();
}

function realtimeOwnerMatches(
  session: RealtimeSession | null | undefined,
  conversationId: string | null | undefined,
  expectedConversationId: string,
  browserOwnerId: string,
): boolean {
  return conversationId === expectedConversationId && session?.browserOwnerId === browserOwnerId;
}

/** Realtime turns participate in the same per-conversation exclusion contract
 * as text turns. Include both an installed session and the async start window,
 * where memory/context setup is already a live turn even though no socket has
 * been installed yet. */
export function isRealtimeConversationTurnActive(conversationId: string): boolean {
  return (
    (!!activeSession && sessionConversationId === conversationId) || pendingStart?.conversationId === conversationId
  );
}

/** Whether a live/pending Realtime turn was admitted by the native primary
 * renderer with Browser authority. Keep the initiator bit after tool revocation,
 * matching text turns: a mirror must not take over conversation persistence
 * merely because the Browser capability was revoked mid-call. */
export function isRealtimeConversationBrowserAuthorized(conversationId: string): boolean {
  return (
    (sessionConversationId === conversationId &&
      !!activeSession &&
      (activeSessionBrowserInitiated || activeSessionAllowsBrowserTools)) ||
    (pendingStart?.conversationId === conversationId &&
      (pendingStart.browserInitiated || pendingStart.allowsBrowserTools))
  );
}

/** Resolve a Browser-authorized Realtime owner at approval-registration time.
 * The returned liveness check intentionally follows the call after Browser
 * revocation so generic approvals can still be answered; only native Browser
 * prompts are dismissed by revokeRealtimeBrowserTools(). */
export function resolveRealtimeBrowserApprovalOwner(
  conversationId: string,
  browserOwnerId: string,
  authority: ToolApprovalAuthority = 'any-renderer',
): (() => boolean) | undefined {
  const requiresLiveBrowserCapability = authority === 'native-browser';
  const isAuthorized =
    ((requiresLiveBrowserCapability
      ? activeSessionAllowsBrowserTools
      : activeSessionBrowserInitiated || activeSessionAllowsBrowserTools) &&
      realtimeOwnerMatches(activeSession, sessionConversationId, conversationId, browserOwnerId)) ||
    ((requiresLiveBrowserCapability
      ? pendingStart?.allowsBrowserTools === true && !pendingStart.browserToolsRevoked
      : pendingStart?.browserInitiated === true || pendingStart?.allowsBrowserTools === true) &&
      realtimeOwnerMatches(pendingStart?.session, pendingStart?.conversationId, conversationId, browserOwnerId));
  if (!isAuthorized) return undefined;
  return () =>
    realtimeOwnerMatches(activeSession, sessionConversationId, conversationId, browserOwnerId) ||
    realtimeOwnerMatches(pendingStart?.session, pendingStart?.conversationId, conversationId, browserOwnerId);
}

function isCurrentPrimaryMainFrame(event: IpcMainInvokeEvent, getPrimaryWindow: () => BrowserWindow | null): boolean {
  const primaryWindow = getPrimaryWindow();
  return (
    !!primaryWindow &&
    !primaryWindow.isDestroyed() &&
    event.sender === primaryWindow.webContents &&
    event.senderFrame === primaryWindow.webContents.mainFrame
  );
}

export function updateActiveRealtimeSessionTools(tools: ToolDefinition[]): void {
  const withoutBrowserTools = tools.filter((tool) => tool.source !== 'browser');
  activeSession?.updateTools(activeSessionAllowsBrowserTools ? tools : withoutBrowserTools);
  pendingStart?.session?.updateTools(pendingStart.allowsBrowserTools ? tools : withoutBrowserTools);
}

/** Permanently remove native Browser authority from the current call/start.
 * A later registry refresh or replacement primary window must not restore it. */
export function revokeRealtimeBrowserTools(tools: ToolDefinition[]): void {
  if (activeSessionAllowsBrowserTools && activeSession && sessionConversationId) {
    dismissPendingNativeBrowserApprovalsForOwner(sessionConversationId, activeSession.browserOwnerId);
  }
  if (pendingStart?.allowsBrowserTools && pendingStart.session) {
    dismissPendingNativeBrowserApprovalsForOwner(pendingStart.conversationId, pendingStart.session.browserOwnerId);
  }
  activeSessionAllowsBrowserTools = false;
  if (pendingStart) {
    pendingStart.allowsBrowserTools = false;
    pendingStart.browserToolsRevoked = true;
  }
  const withoutBrowserTools = tools.filter((tool) => tool.source !== 'browser');
  activeSession?.updateTools(withoutBrowserTools);
  pendingStart?.session?.updateTools(withoutBrowserTools);
}

/**
 * Record usage for the active session (best-effort) then close + clear it.
 * Shared by end-session (hangup) and start-session (superseding a live call) so
 * neither path can (a) skip usage for a session it tears down, nor (b) leak the
 * session if usage recording throws. Usage recording is wrapped so a disk-write
 * failure never blocks the socket/computer-use cleanup in close().
 */
function recordAndCloseActiveSession(closeSession = true): Promise<void> {
  const session = activeSession;
  const startedAt = sessionStartTime;
  const convId = sessionConversationId;
  // Detach + clear FIRST so close() failures or a re-entrant call can't act on a
  // half-torn-down session.
  activeSession = null;
  sessionStartTime = null;
  sessionConversationId = null;
  activeSessionBrowserInitiated = false;
  activeSessionAllowsBrowserTools = false;

  if (!session) return Promise.resolve();

  if (startedAt) {
    try {
      const durationSec = (Date.now() - new Date(startedAt).getTime()) / 1000;
      recordUsageEvent({
        modality: 'realtime',
        conversationId: convId ?? undefined,
        durationSec: Math.round(durationSec),
      });
    } catch (err) {
      console.warn('[Realtime IPC] Failed to record usage (continuing to close):', err);
    }
  }

  try {
    if (closeSession) session.close();
  } catch {
    /* best-effort */
  }
  // Realtime tools share the same temporary-tab contract as text turns.
  // close() aborts in-flight tool calls first; reclaim their assistant tabs
  // and leave kept/user tabs visible to the user. Successor admission waits on
  // this per-conversation barrier so a draining predecessor cannot reject it.
  return convId ? scheduleAssistantTabCleanup(convId, session.browserOwnerId) : Promise.resolve();
}

function handleRealtimeSessionTerminal(session: RealtimeSession): void {
  if (activeSession === session) void recordAndCloseActiveSession(false);
}

/** Stop an active call or an in-flight start only when it belongs to the chat
 * being deleted. The generation bump prevents a pending memory/connect await
 * from installing a session after its conversation has disappeared. */
export function stopRealtimeSessionForConversation(conversationId: string): void {
  if (pendingStart?.conversationId === conversationId) {
    const session = pendingStart.session;
    startGeneration++;
    pendingStart = null;
    try {
      session?.close();
    } catch {
      /* best-effort */
    }
    if (session) void scheduleAssistantTabCleanup(conversationId, session.browserOwnerId);
  }
  if (sessionConversationId === conversationId) void recordAndCloseActiveSession();
}

export function registerRealtimeHandlers(
  ipcMain: IpcMain,
  getConfig: () => AppConfig,
  getTools: () => ToolDefinition[],
  appHome: string,
  getPrimaryWindow: () => BrowserWindow | null = () => null,
  isTextTurnActive: (conversationId: string) => boolean = () => false,
): void {
  const dbPath = join(appHome, 'data', 'memory.db');

  ipcMain.handle('realtime:start-session', async (event, conversationId: string) => {
    const browserManagerAtAuthorization = getExistingBrowserManager();
    const primaryRendererInitiated = isCurrentPrimaryMainFrame(event, getPrimaryWindow);
    // A Browser-authorized call can act on authenticated native tabs. Do not
    // let a web bridge, plugin/approval window, or stale renderer supersede it.
    // This check must precede every generation or pending-session mutation.
    if ((activeSessionBrowserInitiated || pendingStart?.browserInitiated) && !primaryRendererInitiated) {
      return { error: 'Only the current primary renderer can replace a Browser-authorized realtime session.' };
    }
    // Claiming a Realtime turn while text is streaming would give two runtimes
    // independent tool/persistence ownership over the same conversation and
    // merge their events into one renderer accumulator. Reject before changing
    // the Realtime generation or pending-session state.
    if (isTextTurnActive(conversationId)) {
      return { error: 'A text response is already running for this conversation.' };
    }
    // A max-turn continuation has already released activeStreams, but it still
    // owns temporary authenticated tabs and conversation persistence. Only the
    // primary renderer may replace that retained text turn with Realtime; a web
    // or secondary renderer must not strand the native successor or persist a
    // transcript that the retained Browser-authority gate will reject.
    if (
      browserManagerAtAuthorization?.hasPendingAssistantContinuationForConversation(conversationId) &&
      !primaryRendererInitiated
    ) {
      return { error: 'Only the current primary renderer can replace a retained Browser continuation.' };
    }
    // Claim this start. Any older in-flight start is now stale; a later start or
    // an end-session will bump this again and supersede US.
    const previousPendingSession = pendingStart?.session;
    const previousPendingConversationId = pendingStart?.conversationId;
    const browserAuthorityGeneration = browserManagerAtAuthorization?.getHostRendererAuthorityGeneration() ?? null;
    const browserInitiated =
      getTools().some((tool) => tool.source === 'browser') &&
      primaryRendererInitiated &&
      browserManagerAtAuthorization !== null &&
      browserAuthorityGeneration !== null &&
      browserManagerAtAuthorization.isHostRendererAuthorityCurrent(browserAuthorityGeneration);
    const myGeneration = ++startGeneration;
    pendingStart = {
      generation: myGeneration,
      conversationId,
      session: null,
      browserInitiated,
      allowsBrowserTools: false,
      browserToolsRevoked: false,
    };
    try {
      previousPendingSession?.close();
    } catch {
      /* best-effort */
    }
    if (previousPendingSession && previousPendingConversationId) {
      void scheduleAssistantTabCleanup(previousPendingConversationId, previousPendingSession.browserOwnerId);
    }
    const isStale = () => myGeneration !== startGeneration;
    // Hoisted so the catch can tear down a session that threw during start()
    // (at that point it isn't installed as `activeSession` yet).
    let session: RealtimeSession | null = null;
    let browserRunRegistered = false;
    try {
      console.info(`[Realtime IPC] start-session called for conversationId="${conversationId}"`);

      // End any existing session — record its usage before tearing it down so a
      // start-while-active (e.g. switching calls) doesn't drop the prior call's
      // duration.
      if (activeSession) {
        void recordAndCloseActiveSession();
      }

      const config = getConfig();
      console.info(`[Realtime IPC] memoryContext config: ${JSON.stringify(config.realtime.memoryContext)}`);

      // Build memory context (the "ringing" phase — may take a moment)
      let memoryContext = '';
      if (config.realtime.memoryContext?.enabled) {
        try {
          const startTime = Date.now();
          memoryContext = await buildRealtimeMemoryContext(conversationId, config, dbPath);
          console.info(
            `[Realtime IPC] Memory context built in ${Date.now() - startTime}ms: ${memoryContext.length} chars`,
          );
        } catch (err) {
          console.warn('[Realtime IPC] Memory context build failed (continuing without):', err);
        }
      }

      // A hangup (end-session) or a newer start happened while we were building
      // memory context — abort this stale start so it can't connect after the
      // user already hung up / a newer call took over.
      if (isStale()) {
        console.info('[Realtime IPC] start superseded during memory-context build — aborting stale start');
        return { error: 'Session start superseded' };
      }
      if (
        browserManagerAtAuthorization?.hasPendingAssistantContinuationForConversation(conversationId) &&
        !isCurrentPrimaryMainFrame(event, getPrimaryWindow)
      ) {
        return { error: 'Only the current primary renderer can replace a retained Browser continuation.' };
      }

      // Only the primary Electron renderer owns the native Browser sidebar.
      // Web bridges and secondary/approval/plugin windows must never receive
      // tools that can control its authenticated tabs.
      const primaryWindow = getPrimaryWindow();
      const availableTools = getTools();
      const hasEffectiveBrowserTool = availableTools.some((tool) => tool.source === 'browser');
      const browserAuthorityCurrent = (): boolean => {
        const currentPrimaryWindow = getPrimaryWindow();
        return (
          browserManagerAtAuthorization !== null &&
          getExistingBrowserManager() === browserManagerAtAuthorization &&
          browserAuthorityGeneration !== null &&
          browserManagerAtAuthorization.isHostRendererAuthorityCurrent(browserAuthorityGeneration) &&
          !!currentPrimaryWindow &&
          !currentPrimaryWindow.isDestroyed() &&
          event.sender === currentPrimaryWindow.webContents &&
          event.senderFrame === currentPrimaryWindow.webContents.mainFrame
        );
      };
      const allowBrowserTools =
        browserInitiated &&
        hasEffectiveBrowserTool &&
        !pendingStart?.browserToolsRevoked &&
        !!primaryWindow &&
        !primaryWindow.isDestroyed() &&
        event.sender === primaryWindow.webContents &&
        event.senderFrame === primaryWindow.webContents.mainFrame &&
        browserAuthorityCurrent();
      if (pendingStart?.generation === myGeneration) pendingStart.allowsBrowserTools = allowBrowserTools;
      const tools = allowBrowserTools ? availableTools : availableTools.filter((tool) => tool.source !== 'browser');
      let createdSession: RealtimeSession;
      createdSession = new RealtimeSession(getConfig, tools, () => handleRealtimeSessionTerminal(createdSession));
      session = createdSession;
      if (pendingStart?.generation === myGeneration) pendingStart.session = session;
      if (browserManagerAtAuthorization && isCurrentPrimaryMainFrame(event, getPrimaryWindow)) {
        // Every modality replacement must reclaim a retained text continuation,
        // even when this trusted primary-renderer call cannot receive Browser
        // tools. Web/secondary callers have no authority to cancel a primary
        // text continuation or destroy its temporary authenticated tabs.
        await browserManagerAtAuthorization.cancelAssistantContinuations(conversationId);
        await waitForAssistantTabCleanup(conversationId);
        await browserManagerAtAuthorization.waitForAssistantTabCleanup(conversationId);
        if (isStale()) {
          console.info('[Realtime IPC] start superseded during Browser cleanup — aborting stale start');
          try {
            session.close();
          } catch {
            /* best-effort */
          }
          return { error: 'Session start superseded' };
        }
        if (allowBrowserTools) {
          if (!browserAuthorityCurrent() || pendingStart?.browserToolsRevoked) {
            if (pendingStart?.generation === myGeneration) pendingStart.allowsBrowserTools = false;
            session.updateTools(getTools().filter((tool) => tool.source !== 'browser'));
          } else {
            // Browser runs from the text and Realtime runtimes must not coexist:
            // each runtime maintains independent page assumptions and would
            // otherwise interleave actions against the same authenticated tabs.
            browserManagerAtAuthorization.beginAssistantRun(conversationId, session.browserOwnerId, 'realtime');
            browserRunRegistered = true;
          }
        }
      }
      await session.start(conversationId, memoryContext);

      // Re-check after the (async) connect: if superseded meanwhile, tear down
      // the session we just built instead of installing it as active.
      if (isStale()) {
        console.info('[Realtime IPC] start superseded during session.start — closing stale session');
        try {
          session.close();
        } catch {
          /* best-effort */
        }
        if (browserRunRegistered) {
          void scheduleAssistantTabCleanup(conversationId, session.browserOwnerId);
          browserRunRegistered = false;
        }
        return { error: 'Session start superseded' };
      }
      if (session.status !== 'connected') throw new Error('Realtime session closed while starting.');
      // Browser authority depends on the exact primary renderer that initiated
      // the call still being alive. Re-check at installation so a renderer
      // close/reload during the async connection cannot leave authenticated
      // Browser tools attached to the surviving realtime socket.
      const browserToolsStillAuthorized =
        allowBrowserTools &&
        browserRunRegistered &&
        pendingStart?.generation === myGeneration &&
        pendingStart.allowsBrowserTools &&
        !pendingStart.browserToolsRevoked &&
        browserAuthorityCurrent();
      if (!browserToolsStillAuthorized && browserRunRegistered) {
        void scheduleAssistantTabCleanup(conversationId, session.browserOwnerId);
        browserRunRegistered = false;
      }
      if (browserToolsStillAuthorized !== allowBrowserTools) {
        session.updateTools(
          browserToolsStillAuthorized ? getTools() : getTools().filter((tool) => tool.source !== 'browser'),
        );
      }
      activeSession = session;
      // Set timing/attribution at INSTALL time so a superseded start can't leave
      // stale globals, and so the recorded duration reflects connected time
      // (not the memory-context build / connect setup that preceded this point).
      sessionStartTime = new Date().toISOString();
      sessionConversationId = conversationId;
      activeSessionBrowserInitiated = browserInitiated;
      activeSessionAllowsBrowserTools = browserToolsStillAuthorized;
      return { ok: true };
    } catch (err) {
      const msg = isStale() ? 'Session start superseded' : err instanceof Error ? err.message : String(err);
      console.error('[Realtime IPC] Failed to start session:', msg);
      // Start failed — tear down whatever we built so its computer-use tracking
      // + socket don't leak and block the next start. The failed session is NOT
      // installed as `activeSession` (that assignment is after the await), and any
      // prior active session was already recorded+closed at the top of this
      // handler, so close the local `session`. The identity guard ensures a
      // concurrent newer start that DID install itself is never closed here.
      const leaked = session ?? activeSession;
      if (leaked) {
        try {
          leaked.close();
        } catch {
          /* best-effort */
        }
      }
      if (activeSession === leaked) void recordAndCloseActiveSession(false);
      else if (leaked && browserRunRegistered) {
        void scheduleAssistantTabCleanup(conversationId, leaked.browserOwnerId);
        browserRunRegistered = false;
      }
      return { error: msg };
    } finally {
      if (pendingStart?.generation === myGeneration) pendingStart = null;
    }
  });

  ipcMain.handle('realtime:end-session', async (event) => {
    // Reject before bumping startGeneration or detaching either session. A
    // secondary renderer must not be able to hang up a call that controls the
    // primary window's authenticated Browser profile.
    if (
      (activeSessionBrowserInitiated || pendingStart?.browserInitiated) &&
      !isCurrentPrimaryMainFrame(event, getPrimaryWindow)
    ) {
      return { error: 'Only the current primary renderer can end a Browser-authorized realtime session.' };
    }
    // Supersede any in-flight start (a hangup during the "ringing"/memory-context
    // phase) so it aborts instead of connecting after the user hung up.
    const pendingSession = pendingStart?.session;
    const pendingConversationId = pendingStart?.conversationId;
    startGeneration++;
    pendingStart = null;
    try {
      pendingSession?.close();
    } catch {
      /* best-effort */
    }
    if (pendingSession && pendingConversationId) {
      void scheduleAssistantTabCleanup(pendingConversationId, pendingSession.browserOwnerId);
    }
    await recordAndCloseActiveSession();
    return { ok: true };
  });

  // Fire-and-forget audio sending (use ipcMain.on, not handle). Guard the payload
  // (renderer is trusted, but a malformed/oversized frame shouldn't throw out of
  // an event handler with no catch) and never let sendAudio's failure propagate.
  ipcMain.on('realtime:send-audio', (event, pcmBase64: string) => {
    if (typeof pcmBase64 !== 'string' || pcmBase64.length === 0) return;
    if (activeSessionBrowserInitiated) {
      const primaryWindow = getPrimaryWindow();
      if (
        !primaryWindow ||
        primaryWindow.isDestroyed() ||
        event.sender !== primaryWindow.webContents ||
        event.senderFrame !== primaryWindow.webContents.mainFrame
      ) {
        // A web/secondary renderer may have its own microphone UI, but it must
        // not inject speech into a desktop-authorized call whose tools can act
        // on authenticated native Browser tabs.
        return;
      }
    }
    try {
      activeSession?.sendAudio(pcmBase64);
    } catch (err) {
      console.warn('[Realtime IPC] send-audio failed (dropping frame):', err instanceof Error ? err.message : err);
    }
  });

  ipcMain.handle('realtime:get-status', () => {
    return {
      status: activeSession?.status ?? 'idle',
    };
  });
}
