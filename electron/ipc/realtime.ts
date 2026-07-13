/**
 * IPC handlers for the Realtime Audio session.
 * Bridges the renderer process to the RealtimeSession in the main process.
 */

import { join } from 'path';
import type { IpcMain } from 'electron';
import { RealtimeSession } from '../realtime/realtime-session.js';
import { buildRealtimeMemoryContext } from '../realtime/realtime-context.js';
import type { AppConfig } from '../config/schema.js';
import type { ToolDefinition } from '../tools/types.js';
import { recordUsageEvent } from './usage.js';

let activeSession: RealtimeSession | null = null;
let sessionStartTime: string | null = null;
let sessionConversationId: string | null = null;
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

export function updateActiveRealtimeSessionTools(tools: ToolDefinition[]): void {
  activeSession?.updateTools(tools);
}

/**
 * Record usage for the active session (best-effort) then close + clear it.
 * Shared by end-session (hangup) and start-session (superseding a live call) so
 * neither path can (a) skip usage for a session it tears down, nor (b) leak the
 * session if usage recording throws. Usage recording is wrapped so a disk-write
 * failure never blocks the socket/computer-use cleanup in close().
 */
function recordAndCloseActiveSession(): void {
  const session = activeSession;
  const startedAt = sessionStartTime;
  const convId = sessionConversationId;
  // Detach + clear FIRST so close() failures or a re-entrant call can't act on a
  // half-torn-down session.
  activeSession = null;
  sessionStartTime = null;
  sessionConversationId = null;

  if (!session) return;

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
    session.close();
  } catch {
    /* best-effort */
  }
}

export function registerRealtimeHandlers(
  ipcMain: IpcMain,
  getConfig: () => AppConfig,
  getTools: () => ToolDefinition[],
  appHome: string,
): void {
  const dbPath = join(appHome, 'data', 'memory.db');

  ipcMain.handle('realtime:start-session', async (_event, conversationId: string) => {
    // Claim this start. Any older in-flight start is now stale; a later start or
    // an end-session will bump this again and supersede US.
    const myGeneration = ++startGeneration;
    const isStale = () => myGeneration !== startGeneration;
    // Hoisted so the catch can tear down a session that threw during start()
    // (at that point it isn't installed as `activeSession` yet).
    let session: RealtimeSession | null = null;
    try {
      console.info(`[Realtime IPC] start-session called for conversationId="${conversationId}"`);

      // End any existing session — record its usage before tearing it down so a
      // start-while-active (e.g. switching calls) doesn't drop the prior call's
      // duration.
      if (activeSession) {
        recordAndCloseActiveSession();
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

      const tools = getTools();
      session = new RealtimeSession(getConfig, tools);
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
        return { error: 'Session start superseded' };
      }
      activeSession = session;
      // Set timing/attribution at INSTALL time so a superseded start can't leave
      // stale globals, and so the recorded duration reflects connected time
      // (not the memory-context build / connect setup that preceded this point).
      sessionStartTime = new Date().toISOString();
      sessionConversationId = conversationId;
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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
      if (activeSession === leaked) activeSession = null;
      return { error: msg };
    }
  });

  ipcMain.handle('realtime:end-session', async () => {
    // Supersede any in-flight start (a hangup during the "ringing"/memory-context
    // phase) so it aborts instead of connecting after the user hung up.
    startGeneration++;
    recordAndCloseActiveSession();
    return { ok: true };
  });

  // Fire-and-forget audio sending (use ipcMain.on, not handle)
  ipcMain.on('realtime:send-audio', (_event, pcmBase64: string) => {
    activeSession?.sendAudio(pcmBase64);
  });

  ipcMain.handle('realtime:get-status', () => {
    return {
      status: activeSession?.status ?? 'idle',
    };
  });
}
