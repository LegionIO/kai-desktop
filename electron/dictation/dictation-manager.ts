/**
 * Dictation Anywhere — Main process orchestrator.
 *
 * Manages the global hotkey, mic capture, STT, overlay window,
 * and text insertion lifecycle for system-wide dictation.
 *
 * Architecture:
 * - Global hotkey (Electron globalShortcut) triggers start/stop
 * - Mic capture via hidden BrowserWindow (reuses mic-recorder pattern)
 * - STT via Azure Speech SDK (own instance, separate from in-app live-stt)
 * - Text insertion via LocalMacosHelper postText command (CGEvents)
 * - Overlay window shows waveform + state near menu bar
 */

import { BrowserWindow, globalShortcut, ipcMain } from 'electron';
import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import type { AppConfig } from '../config/schema.js';
import { runLocalMacMouseCommand } from '../computer-use/permissions.js';
import {
  startLocalMacosTakeoverMonitor,
  type LocalMacosTakeoverMonitorHandle,
} from '../computer-use/harnesses/local-macos.js';
import {
  showDictationOverlay,
  hideDictationOverlay,
  destroyDictationOverlay,
  sendToOverlay,
} from './dictation-overlay.js';
import {
  planDictationTextPatch,
  splitGraphemes,
  type DictationPatchOperation,
  type DictationPatchPhase,
} from './text-patch-planner.js';
import { DictationQueuedPartialGate } from './typing-revision-gate.js';
import { getDictationTargetPid } from './focus-preserver.js';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const AX_DEBUG_LOG = join(import.meta.dirname, '../../debug-logs/dictation-ax.log');
function axDebug(msg: string): void {
  try { appendFileSync(AX_DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* ignore */ }
}
import { parseHotkeyCodes } from './hotkey-codes.js';

export type DictationState = 'idle' | 'starting' | 'active' | 'stopping';

interface DictationConfig {
  enabled: boolean;
  hotkey: string;
  mode: 'toggle' | 'hold';
  inputDeviceId?: string | null;
  language?: string;
  livePartials?: boolean;
  partialTyping?: Partial<Record<PartialTypingMode, PartialTypingStrategy>>;
}

type PartialTypingMode = 'ax' | 'kb';
type PartialTypingStrategy = 'disabled' | 'full-replacement' | 'ax-verified' | 'tail-only' | 'full-patch';

const PARTIAL_STRATEGIES_BY_MODE: Record<PartialTypingMode, ReadonlySet<PartialTypingStrategy>> = {
  ax: new Set(['disabled', 'full-replacement', 'ax-verified']),
  kb: new Set(['disabled', 'ax-verified', 'tail-only', 'full-patch']),
};

type AxDictationSpan = {
  location: number;
  typedUtf16Length: number;
  pid: number | null;
};

type TypingMode = 'ax' | 'kb' | 'idle';

let state: DictationState = 'idle';
let config: DictationConfig | null = null;
let fullConfig: AppConfig | null = null;

// STT state (own instance for dictation, separate from in-app live-stt)
let recognizer: sdk.SpeechRecognizer | null = null;
let pushStream: sdk.PushAudioInputStream | null = null;

// Mic capture state
let recorderWindow: BrowserWindow | null = null;
let micDrainInterval: ReturnType<typeof setInterval> | null = null;
let levelPollInterval: ReturnType<typeof setInterval> | null = null;

// Session timing
let sessionStartTime: number = 0;
let sessionGeneration: number = 0;

// Partial typing state (for live partials mode)
let partialTypedText: string = '';
let partialTypingStrategyUsed: PartialTypingStrategy | null = null;
const queuedPartialGate = new DictationQueuedPartialGate();
let axDictationSpan: AxDictationSpan | null = null;

// When AX fails mid-utterance, suppress further AX attempts until the next clean final
let axSuppressedUntilNextFinal: boolean = false;

// Typing mode broadcast (deduplicated)
let lastBroadcastedMode: TypingMode = 'idle';

// Throttle AX re-capture: don't retry if we failed recently
let lastAxCaptureAttempt: number = 0;
const AX_RECAPTURE_COOLDOWN_MS = 3000;

// Hold mode state
let holdMonitor: LocalMacosTakeoverMonitorHandle | null = null;
let holdSafetyTimeout: ReturnType<typeof setTimeout> | null = null;
let holdReleaseRequested = false;

/** Maximum hold duration before auto-stop (5 minutes) */
const HOLD_SAFETY_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Initialize the dictation manager. Call once after app is ready.
 */
export function initDictation(appConfig: AppConfig): void {
  fullConfig = appConfig;
  config = appConfig.dictation as DictationConfig | undefined ?? null;
  if (config?.enabled && config.hotkey) {
    registerHotkey(config.hotkey);
  }
  registerIpcHandlers();
}

/**
 * Update config (called when user changes settings).
 */
export function updateDictationConfig(appConfig: AppConfig): void {
  const newConfig = appConfig.dictation as DictationConfig | undefined ?? null;
  const oldHotkey = config?.hotkey;
  const oldEnabled = config?.enabled;

  fullConfig = appConfig;
  config = newConfig;

  // Re-register hotkey if it changed
  if (oldHotkey !== newConfig?.hotkey || oldEnabled !== newConfig?.enabled) {
    if (oldHotkey) {
      try { globalShortcut.unregister(oldHotkey); } catch { /* ignore */ }
    }
    if (newConfig?.enabled && newConfig.hotkey) {
      registerHotkey(newConfig.hotkey);
    }
  }
}

/**
 * Cleanup on app quit.
 */
export function cleanupDictation(): void {
  stopDictation();
  if (config?.hotkey) {
    try { globalShortcut.unregister(config.hotkey); } catch { /* ignore */ }
  }
  destroyDictationOverlay();
}

/**
 * Toggle dictation on/off.
 */
export async function toggleDictation(): Promise<void> {
  if (state === 'active' || state === 'starting') {
    await stopDictation();
  } else if (state === 'idle') {
    await startDictation();
  }
}

/**
 * Get current dictation state.
 */
export function getDictationState(): { state: DictationState; elapsed: number } {
  return {
    state,
    elapsed: state === 'active' || state === 'stopping' ? Math.floor((Date.now() - sessionStartTime) / 1000) : 0,
  };
}

// ─── Private ─────────────────────────────────────────────────────────────────

function registerHotkey(hotkey: string): void {
  try {
    const success = globalShortcut.register(hotkey, () => {
      if (config?.mode === 'hold') {
        // Hold mode: key-down starts dictation, key-up stops it.
        // globalShortcut only fires on key-down, so we start here
        // and use a native monitor to detect release.
        if (state === 'idle') {
          holdReleaseRequested = false;
          startHoldMonitor(hotkey);
          void startDictation().then(() => {
            if (holdReleaseRequested && state === 'active') {
              console.info('[Dictation] Hold mode: release happened during startup, stopping');
              void stopDictation();
            } else if (state !== 'active') {
              stopHoldMonitor();
            }
          });
        }
      } else {
        // Toggle mode: press to start, press again to stop.
        void toggleDictation();
      }
    });
    if (success) {
      console.info('[Dictation] Global hotkey registered: %s (mode=%s)', hotkey, config?.mode ?? 'toggle');
    } else {
      console.warn('[Dictation] Failed to register hotkey: %s (already in use?)', hotkey);
    }
  } catch (err) {
    console.warn('[Dictation] Hotkey registration error:', err);
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('dictation:toggle', async () => {
    await toggleDictation();
    return getDictationState();
  });

  ipcMain.handle('dictation:stop', async () => {
    await stopDictation();
    return getDictationState();
  });

  ipcMain.handle('dictation:get-state', () => {
    return getDictationState();
  });

  ipcMain.handle('dictation:get-typing-mode', () => {
    return lastBroadcastedMode;
  });

  ipcMain.handle('dictation:set-device', async (_event, deviceId: string) => {
    if (config) {
      config.inputDeviceId = deviceId;
    }
    // If actively dictating, restart mic with new device
    if (state === 'active') {
      await stopMicCapture();
      await startMicCapture(deviceId);
    }
    return { ok: true };
  });
}

async function startDictation(): Promise<void> {
  if (state !== 'idle' || !config?.enabled) return;

  state = 'starting';
  sessionGeneration += 1;
  broadcastState();
  sessionStartTime = Date.now();

  try {
    axDebug(`--- SESSION START ---`);

    // 1. Show overlay (this also captures + restores focus to the target app)
    await showDictationOverlay();

    // Wait for focus restoration to settle before querying AX
    await new Promise(resolve => setTimeout(resolve, 350));

    axDictationSpan = await captureFocusedTextSelectionForAxRewrite();
    axDebug(`startDictation: initial capture result=${axDictationSpan ? `loc=${axDictationSpan.location}` : 'null'}`);

    // Broadcast typing mode after overlay is visible so it receives the message
    broadcastTypingMode(axDictationSpan ? 'ax' : 'kb');

    // 2. Start mic capture
    await startMicCapture(config.inputDeviceId ?? undefined);

    // 3. Start STT
    await startStt();

    // 4. Start polling mic audio and levels
    startAudioPolling();

    state = 'active';
    broadcastState();
    console.info('[Dictation] Started');
  } catch (err) {
    console.error('[Dictation] Start failed:', err);
    state = 'idle';
    sessionGeneration += 1;
    broadcastState();
    await cleanupSession();
    broadcastError(err instanceof Error ? err.message : String(err));
  }
}

async function stopDictation(): Promise<void> {
  if (state === 'idle' || state === 'stopping') return;

  state = 'stopping';
  broadcastState();

  await finishSession();

  state = 'idle';
  sessionGeneration += 1;
  broadcastState();
  hideDictationOverlay();
  console.info('[Dictation] Stopped');
}

async function finishSession(): Promise<void> {
  stopAudioPolling();
  stopHoldMonitor();
  await drainRemainingAudioToStt();
  const finalChunks = await stopMicCapture();
  writeAudioChunksToStt(finalChunks);
  await stopStt();
  await waitForTypingQueueToSettle();
  resetSessionState();
}

async function cleanupSession(): Promise<void> {
  stopAudioPolling();
  stopHoldMonitor();
  await stopStt();
  await stopMicCapture();
  resetSessionState();
}

function resetSessionState(): void {
  partialTypedText = '';
  partialTypingStrategyUsed = null;
  queuedPartialGate.invalidateQueuedPartials();
  axDictationSpan = null;
  axSuppressedUntilNextFinal = false;
  lastBroadcastedMode = 'idle';
  lastAxCaptureAttempt = 0;
}

// ─── Hold Mode Monitor ──────────────────────────────────────────────────────

/**
 * Start monitoring for key release to stop dictation in hold mode.
 * Uses the existing native CGEventTap monitor. Regular primary keys emit keyUp,
 * while modifier keys emit flagsChanged.
 */
function startHoldMonitor(hotkey: string): void {
  stopHoldMonitor(); // Clean up any existing monitor

  const { modifierCodes, primaryCodes } = parseHotkeyCodes(hotkey);
  if (modifierCodes.size === 0 && primaryCodes.size === 0) {
    console.warn('[Dictation] Hold mode: no recognized keys in hotkey, cannot detect release');
    return;
  }

  console.info(
    '[Dictation] Hold mode: watching for release (modifiers=%s, primary=%s)',
    [...modifierCodes].join(',') || 'none',
    [...primaryCodes].join(',') || 'none',
  );

  holdMonitor = startLocalMacosTakeoverMonitor({
    onEvent: (event) => {
      if (event.keyCode === undefined) return;

      if (event.eventType === 'keyUp' && primaryCodes.has(event.keyCode)) {
        requestHoldStop(`primary key released (keyCode=${event.keyCode})`);
        return;
      }

      if (event.eventType === 'flagsChanged' && modifierCodes.has(event.keyCode)) {
        requestHoldStop(`modifier released (keyCode=${event.keyCode})`);
      }
    },
    onError: (message) => {
      console.warn('[Dictation] Hold monitor error:', message);
      // If monitor fails, stop dictation to prevent stuck state
      requestHoldStop('hold monitor failed');
    },
  });

  // Safety timeout: auto-stop if held for too long (prevents stuck dictation)
  holdSafetyTimeout = setTimeout(() => {
    console.warn('[Dictation] Hold mode: safety timeout reached, stopping');
    void stopDictation();
  }, HOLD_SAFETY_TIMEOUT_MS);
}

function requestHoldStop(reason: string): void {
  if (holdReleaseRequested) return;

  holdReleaseRequested = true;
  console.info('[Dictation] Hold mode: %s, stopping', reason);
  if (state === 'active') {
    void stopDictation();
  } else if (state === 'idle') {
    stopHoldMonitor();
  }
}

/**
 * Stop the hold mode monitor and clear safety timeout.
 */
function stopHoldMonitor(): void {
  if (holdMonitor) {
    holdMonitor.stop();
    holdMonitor = null;
  }
  if (holdSafetyTimeout) {
    clearTimeout(holdSafetyTimeout);
    holdSafetyTimeout = null;
  }
}

// ─── Mic Capture ─────────────────────────────────────────────────────────────

async function ensureRecorderWindow(): Promise<BrowserWindow> {
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    return recorderWindow;
  }

  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');

  const dir = join(tmpdir(), __BRAND_APP_SLUG + '-dictation-mic');
  mkdirSync(dir, { recursive: true });
  const htmlPath = join(dir, 'recorder.html');
  writeFileSync(htmlPath, DICTATION_RECORDER_HTML, 'utf-8');

  recorderWindow = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  // Grant media permissions
  recorderWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media' || (permission as string) === 'microphone' || (permission as string) === 'audioCapture') {
      callback(true);
    } else {
      callback(false);
    }
  });

  await recorderWindow.loadFile(htmlPath);
  return recorderWindow;
}

async function startMicCapture(deviceId?: string): Promise<void> {
  const win = await ensureRecorderWindow();
  const escaped = deviceId ? JSON.stringify(deviceId) : 'null';
  await win.webContents.executeJavaScript(`window._mic.startLiveStream(${escaped})`);
}

async function stopMicCapture(): Promise<string[]> {
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    try {
      const chunks = await recorderWindow.webContents.executeJavaScript('window._mic.stopLiveStream()');
      return Array.isArray(chunks) ? chunks : [];
    } catch { /* ignore */ }
  }
  return [];
}

async function drainMicChunks(): Promise<string[]> {
  if (!recorderWindow || recorderWindow.isDestroyed()) return [];
  try {
    return await recorderWindow.webContents.executeJavaScript('window._mic.drainLiveChunks()');
  } catch {
    return [];
  }
}

async function drainRemainingAudioToStt(): Promise<void> {
  writeAudioChunksToStt(await drainMicChunks());
}

function writeAudioChunksToStt(chunks: string[]): void {
  if (!pushStream) return;
  for (const chunk of chunks) {
    try {
      const buf = Buffer.from(chunk, 'base64');
      pushStream.write(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    } catch { /* ignore */ }
  }
}

async function getMicLevel(): Promise<number> {
  if (!recorderWindow || recorderWindow.isDestroyed()) return 0;
  try {
    return await recorderWindow.webContents.executeJavaScript('window._mic.getLevel()');
  } catch {
    return 0;
  }
}

// ─── STT ─────────────────────────────────────────────────────────────────────

async function startStt(): Promise<void> {
  if (!fullConfig) throw new Error('No config available');

  const audio = fullConfig.audio as {
    azure?: { region?: string; subscriptionKey?: string; sttLanguage?: string; sttEndpoint?: string; endpoint?: string };
    recording?: { language?: string };
  };
  const azure = audio?.azure;

  // Get Azure credentials from audio.azure config (primary storage location)
  const subscriptionKey = azure?.subscriptionKey ?? getAzureSttKeyFallback();
  const region = azure?.region ?? 'eastus';
  const language = config?.language ?? audio?.recording?.language ?? azure?.sttLanguage ?? 'en-US';
  const sttEndpoint = azure?.sttEndpoint ?? azure?.endpoint;

  if (!subscriptionKey) {
    throw new Error('No Azure Speech subscription key configured. Configure it in Audio & Voice settings.');
  }

  // Create speech config
  let speechConfig: sdk.SpeechConfig;
  if (sttEndpoint) {
    const endpointUrl = new URL(sttEndpoint.replace(/\/+$/, ''));
    const host = endpointUrl.hostname.toLowerCase();
    const isAzureEndpoint = host.endsWith('.microsoft.com') ||
                            host.endsWith('.azure.com') ||
                            host.endsWith('.azure.cn') ||
                            host.endsWith('.azure.us');
    if (isAzureEndpoint) {
      speechConfig = sdk.SpeechConfig.fromEndpoint(endpointUrl, subscriptionKey);
    } else {
      const hostUrl = new URL(endpointUrl.origin);
      speechConfig = sdk.SpeechConfig.fromHost(hostUrl, subscriptionKey);
    }
  } else {
    speechConfig = sdk.SpeechConfig.fromSubscription(subscriptionKey, region);
  }
  speechConfig.speechRecognitionLanguage = language;

  console.info('[Dictation] STT config: region=%s, language=%s, endpoint=%s, key=%s...%s',
    region, language, sttEndpoint ?? '(none)',
    subscriptionKey.slice(0, 4), subscriptionKey.slice(-4));

  // Push stream (16kHz, 16-bit, mono)
  const format = sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
  pushStream = sdk.AudioInputStream.createPushStream(format);
  const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);

  // Create recognizer
  recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

  recognizer.recognizing = (_sender, e) => {
    if (e.result.text) {
      handlePartial(e.result.text);
    }
  };

  recognizer.recognized = (_sender, e) => {
    if (e.result.reason === sdk.ResultReason.RecognizedSpeech && e.result.text) {
      handleFinal(e.result.text);
    }
  };

  recognizer.canceled = (_sender, e) => {
    if (e.reason === sdk.CancellationReason.Error) {
      console.error('[Dictation] STT canceled:', e.errorDetails);
      broadcastError(e.errorDetails ?? 'Recognition error');
    }
  };

  // Start continuous recognition
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('STT start timed out after 15s'));
    }, 15000);

    recognizer!.startContinuousRecognitionAsync(
      () => { clearTimeout(timeout); resolve(); },
      (err) => { clearTimeout(timeout); reject(new Error(err)); },
    );
  });
}

async function stopStt(): Promise<void> {
  if (pushStream) {
    try { pushStream.close(); } catch { /* ignore */ }
    pushStream = null;
  }

  if (recognizer) {
    try {
      await new Promise<void>((resolve) => {
        recognizer!.stopContinuousRecognitionAsync(
          () => resolve(),
          () => resolve(),
        );
      });
    } catch { /* ignore */ }
    try { recognizer.close(); } catch { /* ignore */ }
    recognizer = null;
  }
}

function getAzureSttKeyFallback(): string {
  // Fallback: look for Azure key in models.providers or realtime config
  if (!fullConfig) return '';

  const providers = (fullConfig.models as { providers?: Record<string, { apiKey?: string; type?: string }> }).providers ?? {};
  for (const [_name, provider] of Object.entries(providers)) {
    if (provider.type === 'azure' || provider.type === 'azure-openai') {
      if (provider.apiKey) return provider.apiKey;
    }
  }

  // Check realtime config
  const realtime = fullConfig.realtime as { azure?: { apiKey?: string } };
  if (realtime?.azure?.apiKey) return realtime.azure.apiKey;

  return '';
}

// ─── Audio Polling ───────────────────────────────────────────────────────────

function startAudioPolling(): void {
  // Poll mic for audio chunks every 50ms and feed to STT
  micDrainInterval = setInterval(async () => {
    writeAudioChunksToStt(await drainMicChunks());
  }, 50);

  // Poll mic level every 66ms (~15fps) for overlay waveform
  levelPollInterval = setInterval(async () => {
    const level = await getMicLevel();
    sendToOverlay('dictation:level', level);
  }, 66);
}

function stopAudioPolling(): void {
  if (micDrainInterval) { clearInterval(micDrainInterval); micDrainInterval = null; }
  if (levelPollInterval) { clearInterval(levelPollInterval); levelPollInterval = null; }
}

// ─── Text Handling ──────────────────────────────────────────────────────────

/**
 * Serializes all typing operations to prevent race conditions.
 * Each operation (backspace + retype) must complete before the next starts.
 */
let typingQueue: Promise<void> = Promise.resolve();

function isCurrentTypingSession(generation: number): boolean {
  return (state === 'active' || state === 'stopping') && generation === sessionGeneration;
}

function enqueueTyping(generation: number, fn: () => Promise<void>): void {
  typingQueue = typingQueue.then(async () => {
    if (!isCurrentTypingSession(generation)) return;
    await fn();
  }).catch((err) => {
    console.error('[Dictation] Typing queue error:', err);
  });
}

async function waitForTypingQueueToSettle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const pending = typingQueue;
    await pending;
    await new Promise(resolve => setTimeout(resolve, 0));
    if (typingQueue === pending) return;
  }
  await typingQueue;
}

function handlePartial(text: string): void {
  if (state !== 'active') return;
  sendToOverlay('dictation:partial', text);

  const strategy = getPartialTypingStrategy(getActivePartialTypingMode());
  if (strategy === 'disabled') return;

  const generation = sessionGeneration;
  const partialRevision = queuedPartialGate.nextPartialRevision();
  enqueueTyping(generation, async () => {
    if (!queuedPartialGate.isCurrent(partialRevision)) return;

    const applied = await applyPartialTypingStrategy(partialTypedText, text, 'partial', strategy);
    if (!isCurrentTypingSession(generation)) return;
    if (!applied) return;

    partialTypedText = text;
    partialTypingStrategyUsed = strategy;
  });
}

function handleFinal(text: string): void {
  if (state !== 'active' && state !== 'stopping') return;
  sendToOverlay('dictation:final', text);

  const generation = sessionGeneration;
  queuedPartialGate.invalidateQueuedPartials();
  enqueueTyping(generation, async () => {
    let applied = true;
    if (partialTypedText.length > 0 && partialTypingStrategyUsed) {
      const finalWithSpace = text + ' ';
      applied = await applyPartialTypingStrategy(partialTypedText, finalWithSpace, 'final', partialTypingStrategyUsed);
    } else {
      if (!isCurrentTypingSession(generation)) return;
      applied = await typeText(text + ' ');
    }
    if (!isCurrentTypingSession(generation)) return;
    if (!applied) return;
    partialTypedText = '';
    partialTypingStrategyUsed = null;
    axDictationSpan = null;
    axSuppressedUntilNextFinal = false;

    if (state !== 'active') return;
    // Re-acquire AX span for the next utterance (cursor is now at new position)
    axDictationSpan = await captureFocusedTextSelectionForAxRewrite();
    broadcastTypingMode(axDictationSpan ? 'ax' : 'kb');
  });
}

function getActivePartialTypingMode(): PartialTypingMode {
  return axDictationSpan && !axSuppressedUntilNextFinal ? 'ax' : 'kb';
}

function getPartialTypingStrategy(mode: PartialTypingMode): PartialTypingStrategy {
  const configured = config?.partialTyping?.[mode];
  if (configured) return normalizePartialTypingStrategy(mode, configured);

  // Backward compatibility for configs that only have the old boolean.
  if (config?.livePartials) {
    return mode === 'ax' ? 'full-replacement' : 'disabled';
  }

  return 'disabled';
}

function normalizePartialTypingStrategy(
  mode: PartialTypingMode,
  strategy: PartialTypingStrategy,
): PartialTypingStrategy {
  if (PARTIAL_STRATEGIES_BY_MODE[mode].has(strategy)) return strategy;
  return mode === 'ax' ? 'full-replacement' : 'ax-verified';
}

async function applyPartialTypingStrategy(
  currentText: string,
  targetText: string,
  phase: DictationPatchPhase,
  strategy: PartialTypingStrategy,
): Promise<boolean> {
  switch (strategy) {
    case 'disabled':
      return false;
    case 'full-replacement':
      return replaceDictatedTextViaAxWithCapture(currentText, targetText);
    case 'ax-verified':
      return replaceDictatedTextViaVerifiedKbWithCapture(currentText, targetText);
    case 'tail-only':
      return applyTailOnlyDictationPatch(currentText, targetText);
    case 'full-patch':
      return applyDictationPatch(currentText, targetText, phase);
  }
}

async function ensureAxDictationSpan(currentText: string): Promise<boolean> {
  if (axSuppressedUntilNextFinal) return false;
  if (axDictationSpan) return true;
  if (currentText.length > 0) return false;
  if (Date.now() - lastAxCaptureAttempt <= AX_RECAPTURE_COOLDOWN_MS) return false;

  lastAxCaptureAttempt = Date.now();
  axDictationSpan = await captureFocusedTextSelectionForAxRewrite();
  broadcastTypingMode(axDictationSpan ? 'ax' : 'kb');
  return Boolean(axDictationSpan);
}

async function replaceDictatedTextViaAxWithCapture(currentText: string, targetText: string): Promise<boolean> {
  if (!await ensureAxDictationSpan(currentText)) return false;
  return replaceDictatedTextViaAx(targetText);
}

async function replaceDictatedTextViaVerifiedKbWithCapture(currentText: string, targetText: string): Promise<boolean> {
  if (!await ensureAxDictationSpan(currentText)) return false;
  return replaceDictatedTextViaVerifiedKb(targetText);
}

async function applyTailOnlyDictationPatch(currentText: string, targetText: string): Promise<boolean> {
  if (targetText.startsWith(currentText)) {
    return typeText(targetText.slice(currentText.length));
  }

  const backspaceCount = splitGraphemes(currentText).length;
  if (backspaceCount > 0 && !await typeBackspaces(backspaceCount)) {
    return false;
  }
  return typeText(targetText);
}

async function applyDictationPatch(
  currentText: string,
  targetText: string,
  phase: DictationPatchPhase,
): Promise<boolean> {
  // Try AX (Accessibility) atomic replacement first — it avoids visible cursor movement.
  // Uses kAXValueAttribute (full-text splice) with fallback to verified select+type.
  // If AX failed earlier in this utterance, we suppress until the next clean final
  // to avoid corrupting text by mixing AX and KB state.
  if (!axSuppressedUntilNextFinal) {
    if (!axDictationSpan && currentText.length === 0 && Date.now() - lastAxCaptureAttempt > AX_RECAPTURE_COOLDOWN_MS) {
      lastAxCaptureAttempt = Date.now();
      axDictationSpan = await captureFocusedTextSelectionForAxRewrite();
      broadcastTypingMode(axDictationSpan ? 'ax' : 'kb');
    }
    if (await replaceDictatedTextViaAx(targetText)) {
      return true;
    }
  }

  axDebug(`applyPatch: using KB fallback (phase=${phase} currentLen=${currentText.length} targetLen=${targetText.length})`);
  const plan = planDictationTextPatch(currentText, targetText, phase);

  switch (plan.kind) {
    case 'none':
      return true;
    case 'append':
      return typeText(plan.text);
    case 'patch':
      return applyTextPatch(plan.operations);
    case 'tailRewrite': {
      if (plan.backspaceCount > 0 && !await typeBackspaces(plan.backspaceCount)) {
        return false;
      }
      if (plan.text && !await typeText(plan.text)) {
        return false;
      }
      return true;
    }
  }
}

async function captureFocusedTextSelectionForAxRewrite(): Promise<AxDictationSpan | null> {
  if (process.platform !== 'darwin') return null;
  const pid = getDictationTargetPid();
  axDebug(`capture: targetPid=${pid}`);
  try {
    const args = pid != null
      ? ['focusedTextSelection', String(pid)]
      : ['focusedTextSelection'];
    const result = await runLocalMacMouseCommand(args);
    axDebug(`capture result=${JSON.stringify(result)}`);
    const location = result.selectedTextRangeLocation;
    const length = result.selectedTextRangeLength;
    if (typeof location !== 'number' || typeof length !== 'number' || location < 0 || length < 0) {
      axDebug(`capture FAILED: invalid location=${location} length=${length}`);
      return null;
    }
    axDebug(`capture OK: location=${location} length=${length} pid=${pid}`);
    return { location, typedUtf16Length: 0, pid };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    axDebug(`capture EXCEPTION: ${msg}`);
    return null;
  }
}

async function replaceDictatedTextViaAx(targetText: string): Promise<boolean> {
  if (!axDictationSpan) return false;
  const encoded = Buffer.from(targetText, 'utf-8').toString('base64');
  axDebug(`replaceViaAx: location=${axDictationSpan.location} typedLen=${axDictationSpan.typedUtf16Length} targetLen=${targetText.length} pid=${axDictationSpan.pid}`);
  try {
    // Use the atomic replacement command which tries kAXValueAttribute first,
    // then falls back to verified select+type. Both strategies validate state.
    const args = [
      'replaceTextAtomically',
      String(axDictationSpan.location),
      String(axDictationSpan.typedUtf16Length),
      encoded,
    ];
    if (axDictationSpan.pid != null) {
      args.push(String(axDictationSpan.pid));
    }
    const result = await runLocalMacMouseCommand(args);
    updateAxDictationSpanLength(targetText);
    axDebug(`replaceViaAx OK: method=${result.method ?? 'unknown'} newTypedLen=${axDictationSpan.typedUtf16Length}`);
    return true;
  } catch (err) {
    axDictationSpan = null;
    axSuppressedUntilNextFinal = true;
    broadcastTypingMode('kb');
    axDebug(`replaceViaAx FAILED (suppressing until next final): ${err}`);
    console.info('[Dictation] AX atomic replacement failed:', err);
    return false;
  }
}

async function replaceDictatedTextViaVerifiedKb(targetText: string): Promise<boolean> {
  if (!axDictationSpan) return false;
  const encoded = Buffer.from(targetText, 'utf-8').toString('base64');
  axDebug(`replaceViaVerifiedKb: location=${axDictationSpan.location} typedLen=${axDictationSpan.typedUtf16Length} targetLen=${targetText.length} pid=${axDictationSpan.pid}`);
  try {
    const args = [
      'replaceTextRangeVerified',
      String(axDictationSpan.location),
      String(axDictationSpan.typedUtf16Length),
      encoded,
    ];
    if (axDictationSpan.pid != null) {
      args.push(String(axDictationSpan.pid));
    }
    const result = await runLocalMacMouseCommand(args);
    updateAxDictationSpanLength(targetText);
    axDebug(`replaceViaVerifiedKb OK: method=${result.method ?? 'unknown'} newTypedLen=${axDictationSpan.typedUtf16Length}`);
    return true;
  } catch (err) {
    axDictationSpan = null;
    axSuppressedUntilNextFinal = true;
    broadcastTypingMode('kb');
    axDebug(`replaceViaVerifiedKb FAILED (suppressing until next final): ${err}`);
    console.info('[Dictation] AX-verified keyboard replacement failed:', err);
    return false;
  }
}

function updateAxDictationSpanLength(text: string): void {
  if (!axDictationSpan) return;
  axDictationSpan.typedUtf16Length = text.length;
}

// ─── Text Insertion via CGEvents ─────────────────────────────────────────────

async function typeText(text: string): Promise<boolean> {
  if (!text) return true;
  const encoded = Buffer.from(text, 'utf-8').toString('base64');
  try {
    await runLocalMacMouseCommand(['postText', encoded]);
    return true;
  } catch (err) {
    console.error('[Dictation] typeText failed:', err);
    return false;
  }
}

async function typeBackspaces(count: number): Promise<boolean> {
  if (count <= 0) return true;
  try {
    await runLocalMacMouseCommand(['deleteBack', String(count)]);
    return true;
  } catch (err) {
    console.error('[Dictation] typeBackspaces failed:', err);
    return false;
  }
}

async function applyTextPatch(operations: DictationPatchOperation[]): Promise<boolean> {
  if (operations.length === 0) return true;
  const encoded = Buffer.from(JSON.stringify(operations), 'utf-8').toString('base64');
  try {
    await runLocalMacMouseCommand(['applyTextPatch', encoded]);
    return true;
  } catch (err) {
    console.error('[Dictation] applyTextPatch failed:', err);
    return false;
  }
}


// ─── Broadcasting ────────────────────────────────────────────────────────────

function broadcastState(): void {
  const payload = getDictationState();
  sendToOverlay('dictation:state', payload);
  // Also broadcast to main renderer for settings UI
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try { win.webContents.send('dictation:state', payload); } catch { /* ignore */ }
    }
  }
}

function broadcastError(message: string): void {
  sendToOverlay('dictation:error', message);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try { win.webContents.send('dictation:error', message); } catch { /* ignore */ }
    }
  }
}

function broadcastTypingMode(mode: TypingMode): void {
  if (mode === lastBroadcastedMode) return;
  lastBroadcastedMode = mode;
  sendToOverlay('dictation:typing-mode', mode);
}

// ─── Recorder HTML (minimal, just for mic capture) ───────────────────────────

const DICTATION_RECORDER_HTML = `<!DOCTYPE html>
<html><head><title>Dictation Mic</title></head>
<body><script>
window._mic = {
  stream: null,
  processor: null,
  context: null,
  chunks: [],
  level: 0,

  async startLiveStream(deviceId) {
    try {
      const constraints = {
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
      };
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.context = new AudioContext({ sampleRate: 16000 });
      const source = this.context.createMediaStreamSource(this.stream);
      this.processor = this.context.createScriptProcessor(4096, 1, 1);
      this.processor.onaudioprocess = (e) => {
        const float32 = e.inputBuffer.getChannelData(0);
        // Compute level
        let max = 0;
        for (let i = 0; i < float32.length; i++) {
          const abs = Math.abs(float32[i]);
          if (abs > max) max = abs;
        }
        this.level = Math.min(1, max * 3);
        // Convert to PCM16
        const pcm16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          const s = Math.max(-1, Math.min(1, float32[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        // Base64 encode
        const bytes = new Uint8Array(pcm16.buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        this.chunks.push(btoa(binary));
      };
      source.connect(this.processor);
      this.processor.connect(this.context.destination);
      return { ok: true };
    } catch (err) {
      return { error: err.message || String(err) };
    }
  },

  drainLiveChunks() {
    const result = this.chunks;
    this.chunks = [];
    return result;
  },

  getLevel() {
    return this.level;
  },

  stopLiveStream() {
    const remaining = this.chunks;
    if (this.processor) { this.processor.disconnect(); this.processor = null; }
    if (this.context) { this.context.close().catch(() => {}); this.context = null; }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    this.chunks = [];
    this.level = 0;
    return remaining;
  },
};
</script></body></html>`;
