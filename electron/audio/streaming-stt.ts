/**
 * Streaming STT via OpenAI Realtime API.
 *
 * Provides IPC handlers for starting/stopping a streaming transcription session
 * that combines mic capture with real-time WebSocket STT. Used by the composer
 * voice recording for near-instant transcription results.
 *
 * Architecture:
 * - stt:stream-start → starts live mic PCM stream + opens OpenAI Realtime WS
 * - Audio chunks polled from mic window (drainLiveChunks) and forwarded to WS
 * - Partial/final transcripts broadcast via stt:partial / stt:final events
 * - stt:stream-stop → final drain + stops WS (commits audio), returns transcript
 * - stt:stream-cancel → tears down immediately without committing audio
 *
 * The mic window's startLiveStream() produces 16kHz PCM16 base64 chunks which
 * are forwarded to the OpenAI Realtime session (expects 24kHz by default, but
 * we configure 16kHz in the session.update to match the mic capture rate).
 */

import { BrowserWindow, type IpcMain } from 'electron';
import type { AppConfig } from '../config/schema.js';
import { OpenAIRealtimeSttSession, resolveOpenAISttConfig } from './openai-realtime-stt.js';
import { broadcastToWebClients } from '../web-server/web-clients.js';
import { recordUsageEvent } from '../ipc/usage.js';

let streamSession: OpenAIRealtimeSttSession | null = null;
let streamPollingInterval: ReturnType<typeof setInterval> | null = null;
let streamDrainInFlight = false;
let streamDrainPromise: Promise<void> | null = null;
let streamStartTime = 0;
let streamStarting = false; // Guard against concurrent start/cancel races

/**
 * Broadcast an event to all renderer windows and web clients.
 */
function broadcast(channel: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }
  broadcastToWebClients(channel, data);
}

/**
 * Idempotent cleanup: stops polling, destroys session, stops mic.
 * Safe to call multiple times.
 */
function cleanupStream(getMicWindow: () => BrowserWindow | null): void {
  stopStreamPolling();

  if (streamSession) {
    streamSession.cancel();
    streamSession = null;
  }

  streamStartTime = 0;
  streamStarting = false;

  const micWin = getMicWindow();
  if (micWin && !micWin.isDestroyed()) {
    micWin.webContents.executeJavaScript('window._mic.stopLiveStream()').catch(() => { /* ignore */ });
  }
}

export function registerStreamingSttHandlers(
  ipc: IpcMain,
  getConfig: () => AppConfig,
  getMicWindow: () => BrowserWindow | null,
): void {

  ipc.handle('stt:stream-start', async (_event, options?: {
    deviceId?: string;
    language?: string;
  }) => {
    if (streamSession || streamStarting) {
      return { error: 'Stream already active' };
    }

    const config = getConfig();
    const sttConfig = resolveOpenAISttConfig(config as Record<string, unknown>, 'composer');
    if (!sttConfig) {
      return { error: 'No OpenAI Realtime STT credentials configured' };
    }

    const language = options?.language ?? 'en-US';
    const deviceId = options?.deviceId;

    console.info('[StreamingSTT] Starting: model=%s, language=%s, device=%s',
      sttConfig.model, language, deviceId ?? 'default');

    // Ensure mic window is available
    const micWin = getMicWindow();
    if (!micWin || micWin.isDestroyed()) {
      return { error: 'Mic recorder window not available' };
    }

    // Set starting flag to prevent concurrent start/cancel races
    streamStarting = true;

    try {
      // Start the live PCM stream on the mic window FIRST (so audio flows before WS connects)
      const escapedDeviceId = deviceId ? JSON.stringify(deviceId) : 'null';
      const micResult = await micWin.webContents.executeJavaScript(
        `window._mic.startLiveStream(${escapedDeviceId})`
      ) as { ok?: boolean; error?: string };

      // Check if canceled during mic startup
      if (!streamStarting) {
        try { await micWin.webContents.executeJavaScript('window._mic.stopLiveStream()'); } catch { /* ignore */ }
        return { error: 'Canceled during startup' };
      }

      if (micResult.error) {
        console.error('[StreamingSTT] Mic start failed: %s', micResult.error);
        streamStarting = false;
        return { error: `Mic start failed: ${micResult.error}` };
      }

      // Create and start the OpenAI Realtime STT session
      streamSession = new OpenAIRealtimeSttSession(
        { ...sttConfig, sampleRate: 16000, language },
        {
          onPartial: (text) => { broadcast('stt:partial', text); },
          onFinal: (text) => { broadcast('stt:final', text); },
          onError: (error) => {
            console.error('[StreamingSTT] Error: %s', error);
            broadcast('stt:error', error);
            // Runtime errors should trigger cleanup to prevent resource leak
            cleanupStream(getMicWindow);
          },
        },
      );

      await streamSession.start();

      // Check if canceled during WS connect
      if (!streamStarting) {
        streamSession?.destroy();
        streamSession = null;
        try { await micWin.webContents.executeJavaScript('window._mic.stopLiveStream()'); } catch { /* ignore */ }
        return { error: 'Canceled during startup' };
      }

      streamStartTime = Date.now();
      streamStarting = false;

      // Start polling mic chunks and forwarding to the WS session
      startStreamPolling(getMicWindow);

      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[StreamingSTT] Start failed: %s', msg);

      // Clean up: stop mic stream and destroy session
      try {
        await micWin.webContents.executeJavaScript('window._mic.stopLiveStream()');
      } catch { /* ignore */ }

      streamSession?.destroy();
      streamSession = null;
      streamStarting = false;
      return { error: msg };
    }
  });

  ipc.handle('stt:stream-stop', async () => {
    if (!streamSession) {
      // If still starting, cancel the start
      if (streamStarting) {
        streamStarting = false;
      }
      return { text: '', error: 'No active stream' };
    }

    stopStreamPolling();

    const micWin = getMicWindow();

    // Capture session ref early to protect against concurrent nulling during awaits
    const session = streamSession;

    try {
      // Wait for any in-flight drain to complete before doing the final drain
      if (streamDrainPromise) {
        try { await streamDrainPromise; } catch { /* ignore */ }
      }

      // Final drain: flush any buffered audio chunks before committing
      if (micWin && !micWin.isDestroyed()) {
        try {
          const finalChunks = await micWin.webContents.executeJavaScript(
            'window._mic.drainLiveChunks()'
          ) as string[];
          if (finalChunks && finalChunks.length > 0 && session) {
            for (const chunk of finalChunks) {
              session.pushAudio(chunk);
            }
          }
        } catch { /* ignore final drain errors */ }
      }

      // Stop mic immediately (user sees mic release) before waiting for transcription
      if (micWin && !micWin.isDestroyed()) {
        try {
          await micWin.webContents.executeJavaScript('window._mic.stopLiveStream()');
        } catch { /* ignore */ }
      }

      // Stop the STT session (commits audio buffer, waits for final transcription)
      const transcript = await session.stop();
      const durationSec = (Date.now() - streamStartTime) / 1000;

      if (durationSec > 0) {
        recordUsageEvent({ modality: 'stt', durationSec });
      }

      console.info('[StreamingSTT] Stopped: transcript=%d chars, duration=%.1fs',
        transcript.length, durationSec);

      session.destroy();
      streamSession = null;
      streamStartTime = 0;

      return { text: transcript };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[StreamingSTT] Stop error: %s', msg);
      streamSession?.destroy();
      streamSession = null;
      streamStartTime = 0;

      // Stop the live mic stream on error too
      if (micWin && !micWin.isDestroyed()) {
        try {
          await micWin.webContents.executeJavaScript('window._mic.stopLiveStream()');
        } catch { /* ignore */ }
      }

      return { text: '', error: msg };
    }
  });

  ipc.handle('stt:stream-cancel', async () => {
    // Cancel startup if still in progress
    if (streamStarting) {
      streamStarting = false;
      // The start() function checks this flag after each await and will clean up
    }

    if (!streamSession) {
      return { ok: true };
    }

    stopStreamPolling();

    // Cancel: tears down immediately without committing audio
    streamSession.cancel();
    streamSession = null;
    streamStartTime = 0;

    // Stop the live mic stream
    const micWin = getMicWindow();
    if (micWin && !micWin.isDestroyed()) {
      try {
        await micWin.webContents.executeJavaScript('window._mic.stopLiveStream()');
      } catch { /* ignore */ }
    }

    console.info('[StreamingSTT] Canceled');
    return { ok: true };
  });
}

function startStreamPolling(getMicWindow: () => BrowserWindow | null): void {
  streamDrainInFlight = false;
  streamDrainPromise = null;
  streamPollingInterval = setInterval(() => {
    if (streamDrainInFlight || !streamSession) return;
    streamDrainInFlight = true;

    // Capture current session reference before the async drain so we don't
    // push stale audio into a different (new) session if a stop/start race occurs.
    const capturedSession = streamSession;

    const micWin = getMicWindow();
    if (!micWin || micWin.isDestroyed()) {
      streamDrainInFlight = false;
      return;
    }

    streamDrainPromise = micWin.webContents.executeJavaScript('window._mic.drainLiveChunks()')
      .then((chunks: string[]) => {
        if (chunks && chunks.length > 0 && capturedSession === streamSession && streamSession) {
          for (const chunk of chunks) {
            streamSession.pushAudio(chunk);
          }
        }
      })
      .catch(() => { /* ignore drain errors */ })
      .finally(() => { streamDrainInFlight = false; });
  }, 50);
}

function stopStreamPolling(): void {
  if (streamPollingInterval) {
    clearInterval(streamPollingInterval);
    streamPollingInterval = null;
  }
  streamDrainInFlight = false;
}
