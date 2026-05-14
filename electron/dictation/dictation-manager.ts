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

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, globalShortcut, ipcMain } from 'electron';
import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { generateText } from 'ai';
import type { AppConfig } from '../config/schema.js';
import { createLanguageModelFromConfig } from '../agent/language-model.js';
import { resolveModelCatalog } from '../agent/model-catalog.js';
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
import { getDictationTargetPid, recaptureDictationTargetFocus } from './focus-preserver.js';
import {
  getPartialTypingStrategyForConfig,
  hasEnabledPartialTypingStrategy,
  resolveActivePartialTypingMode,
  type PartialTypingConfig,
  type PartialTypingMode,
  type PartialTypingStrategy,
} from './partial-typing.js';
import {
  createAxDictationSpanFromSelection,
  selectionMatchesDictationEnd,
  selectionMatchesDictationStart,
  type AxDictationSpan,
} from './ax-span.js';
import {
  isAcceptableCleanupResponse,
  isSafeKeyboardPatchText,
  normalizeCleanupResponse,
} from './dictation-safety.js';

const AX_DEBUG_ENABLED = process.env.KAI_DICTATION_AX_DEBUG === '1';
function axDebug(msg: string): void {
  if (AX_DEBUG_ENABLED) console.info(`[Dictation AX] ${msg}`);
}
import { parseHotkeyCodes } from './hotkey-codes.js';

export type DictationState = 'idle' | 'starting' | 'active' | 'stopping';

interface DictationConfig {
  enabled: boolean;
  hotkey: string;
  mode: 'toggle' | 'hold';
  inputDeviceId?: string | null;
  language?: string;
  vadSilenceDurationMs?: number;
  finalCleanupEnabled?: boolean;
  livePartials?: boolean;
  partialTyping?: PartialTypingConfig;
}

type TypingMode = 'ax' | 'kb' | 'idle';
type PersistConfigValue = (path: string, value: unknown) => void;
type DictationSoundKind = 'start' | 'end';

let state: DictationState = 'idle';
let config: DictationConfig | null = null;
let fullConfig: AppConfig | null = null;
let persistConfigValue: PersistConfigValue | null = null;

// STT state (own instance for dictation, separate from in-app live-stt)
let recognizer: sdk.SpeechRecognizer | null = null;
let pushStream: sdk.PushAudioInputStream | null = null;

// Mic capture state
let recorderWindow: BrowserWindow | null = null;
let micDrainInterval: ReturnType<typeof setInterval> | null = null;
let levelPollInterval: ReturnType<typeof setInterval> | null = null;
let micSampleRateHz = 16000;

// Session timing
let sessionStartTime: number = 0;
let sessionGeneration: number = 0;

// Partial typing state (for live partials mode)
let partialTypedText: string = '';
let partialTypingStrategyUsed: PartialTypingStrategy | null = null;
let partialTypingModeUsed: PartialTypingMode | null = null;
const queuedPartialGate = new DictationQueuedPartialGate();
let axDictationSpan: AxDictationSpan | null = null;
let keyboardPatchStateUnverified = false;
let keyboardPatchUnverifiedTargetText: string | null = null;

// When AX fails mid-utterance, suppress further AX attempts until the next clean final
let axSuppressedUntilNextFinal: boolean = false;

// Typing mode broadcast (deduplicated)
let lastBroadcastedMode: TypingMode = 'idle';

// Throttle AX re-capture: don't retry if we failed recently
let lastAxCaptureAttempt: number = 0;
const AX_RECAPTURE_COOLDOWN_MS = 3000;
const DEFAULT_VAD_SILENCE_DURATION_MS = 850;
const MIN_VAD_SILENCE_DURATION_MS = 300;
const MAX_VAD_SILENCE_DURATION_MS = 5000;
const AZURE_STT_SAMPLE_RATE_HZ = 16000;
const FINAL_CLEANUP_TIMEOUT_MS = 12_000;
const POST_FINAL_AX_RECAPTURE_DELAY_MS = 120;
const KEYBOARD_PATCH_VERIFY_DELAY_MS = 35;
const MAX_SAFE_BACKSPACES = 120;
const HOTKEY_SUSPEND_TTL_MS = 20_000;
const SYSTEM_SOUND_DIR = '/System/Library/Sounds';
const DICTATION_SOUND_BY_KIND: Record<DictationSoundKind, string> = {
  start: 'Blow',
  end: 'Bottle',
};

const FINAL_CLEANUP_PROMPT = [
  'Clean up dictation transcripts.',
  'Fix likely speech recognition mistakes, punctuation, capitalization, and formatting.',
  'Remove filler words and disfluencies when they do not add meaning.',
  'When the user clearly self-corrects or backtracks, keep the corrected intent.',
  'Use surrounding text only as context.',
  'Dictionary entries are canonical spellings, names, file paths, and code symbols; when the transcript likely refers to one, copy the dictionary entry exactly, including casing and punctuation.',
  "Preserve the user's meaning, wording, and flow unless a small cleanup makes the transcript more coherent.",
  'Do not answer the user or add new content.',
  'Return only the cleaned transcript.',
].join(' ');

// Hold mode state
let holdMonitor: LocalMacosTakeoverMonitorHandle | null = null;
let holdSafetyTimeout: ReturnType<typeof setTimeout> | null = null;
let holdReleaseRequested = false;
let hotkeySuspended = false;
let hotkeySuspensionTimer: ReturnType<typeof setTimeout> | null = null;
let hotkeyRegistered = false;
let hotkeyRegistrationError: string | null = null;
let ipcHandlersRegistered = false;
let sttCancellationStopRequested = false;

/** Maximum hold duration before auto-stop (5 minutes) */
const HOLD_SAFETY_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Initialize the dictation manager. Call once after app is ready.
 */
export function initDictation(appConfig: AppConfig, setConfig?: PersistConfigValue): void {
  fullConfig = appConfig;
  persistConfigValue = setConfig ?? persistConfigValue;
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
      hotkeyRegistered = false;
    }
    if (!hotkeySuspended && newConfig?.enabled && newConfig.hotkey) {
      registerHotkey(newConfig.hotkey);
    } else {
      hotkeyRegistrationError = null;
      broadcastState();
    }
  }
}

/**
 * Cleanup on app quit.
 */
export function cleanupDictation(): void {
  void stopDictation().finally(() => {
    destroyRecorderWindow();
  });
  clearHotkeySuspensionTimer();
  if (config?.hotkey) {
    try { globalShortcut.unregister(config.hotkey); } catch { /* ignore */ }
    hotkeyRegistered = false;
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
export function getDictationState(): {
  state: DictationState;
  elapsed: number;
  hotkeyRegistered: boolean;
  hotkeyError: string | null;
} {
  return {
    state,
    elapsed: state === 'active' || state === 'stopping' ? Math.floor((Date.now() - sessionStartTime) / 1000) : 0,
    hotkeyRegistered,
    hotkeyError: hotkeyRegistrationError,
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
      hotkeyRegistered = true;
      hotkeyRegistrationError = null;
      console.info('[Dictation] Global hotkey registered: %s (mode=%s)', hotkey, config?.mode ?? 'toggle');
    } else {
      hotkeyRegistered = false;
      hotkeyRegistrationError = 'This global hotkey is already in use or could not be registered.';
      console.warn('[Dictation] Failed to register hotkey: %s (already in use?)', hotkey);
      broadcastError(hotkeyRegistrationError);
    }
  } catch (err) {
    hotkeyRegistered = false;
    hotkeyRegistrationError = 'This global hotkey could not be registered.';
    console.warn('[Dictation] Hotkey registration error:', err);
    broadcastError(hotkeyRegistrationError);
  }
  broadcastState();
}

function registerIpcHandlers(): void {
  if (ipcHandlersRegistered) return;
  ipcHandlersRegistered = true;

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
    persistConfigValue?.('dictation.inputDeviceId', deviceId || null);
    // If actively dictating, restart mic with new device
    if (state === 'active') {
      await stopMicCapture();
      await startMicCapture(deviceId);
    }
    return { ok: true };
  });

  ipcMain.handle('dictation:suspend-hotkey', () => {
    suspendDictationHotkey();
    return { ok: true };
  });

  ipcMain.handle('dictation:resume-hotkey', () => {
    resumeDictationHotkey();
    return { ok: true };
  });
}

function clearHotkeySuspensionTimer(): void {
  if (hotkeySuspensionTimer) {
    clearTimeout(hotkeySuspensionTimer);
    hotkeySuspensionTimer = null;
  }
}

function suspendDictationHotkey(): void {
  hotkeySuspended = true;
  clearHotkeySuspensionTimer();
  if (config?.hotkey) {
    try { globalShortcut.unregister(config.hotkey); } catch { /* ignore */ }
    hotkeyRegistered = false;
    broadcastState();
  }
  hotkeySuspensionTimer = setTimeout(() => {
    console.warn('[Dictation] Hotkey suspension timed out; restoring hotkey');
    resumeDictationHotkey();
  }, HOTKEY_SUSPEND_TTL_MS);
}

function resumeDictationHotkey(): void {
  hotkeySuspended = false;
  clearHotkeySuspensionTimer();
  if (config?.enabled && config.hotkey) {
    try { globalShortcut.unregister(config.hotkey); } catch { /* ignore */ }
    hotkeyRegistered = false;
    registerHotkey(config.hotkey);
  }
}

function resolveSystemSoundPath(name: string): string | null {
  if (process.platform !== 'darwin') return null;
  for (const extension of ['aiff', 'caf', 'wav']) {
    const candidate = join(SYSTEM_SOUND_DIR, `${name}.${extension}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function playDictationSound(kind: DictationSoundKind): void {
  const soundPath = resolveSystemSoundPath(DICTATION_SOUND_BY_KIND[kind]);
  if (!soundPath) return;
  try {
    const child = spawn('afplay', [soundPath], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Dictation should continue even if the local alert sound cannot play.
  }
}

async function startDictation(): Promise<void> {
  if (state !== 'idle' || !config?.enabled) return;

  state = 'starting';
  sessionGeneration += 1;
  const generation = sessionGeneration;
  broadcastState();
  sessionStartTime = Date.now();

  try {
    axDebug(`--- SESSION START ---`);

    // 1. Show overlay (this also captures + restores focus to the target app)
    await showDictationOverlay();
    if (!isStartingSession(generation)) return;

    // Wait for focus restoration to settle before querying AX
    await delay(350);
    if (!isStartingSession(generation)) return;

    await assertLocalMacosAccessibilityTrusted();
    if (!isStartingSession(generation)) return;

    if (process.platform === 'darwin' && getDictationTargetPid() == null) {
      throw new Error('Dictation could not identify the target app. Grant Automation permission for focus tracking, then try again.');
    }

    axDictationSpan = await captureFocusedTextSelectionForAxRewrite();
    if (!isStartingSession(generation)) return;
    axDebug(`startDictation: initial capture result=${axDictationSpan ? `loc=${axDictationSpan.location}` : 'null'}`);
    if (!axDictationSpan) {
      throw new Error('Dictation could not verify the target text cursor or selection. Click into a standard text field and try again.');
    }

    // Broadcast typing mode after overlay is visible so it receives the message
    broadcastTypingMode(getActivePartialTypingMode());

    // 2. Start mic capture
    await startMicCapture(config.inputDeviceId ?? undefined);
    if (!isStartingSession(generation)) {
      await stopMicCapture();
      return;
    }

    // 3. Start STT
    await startStt();
    if (!isStartingSession(generation)) {
      await stopStt();
      await stopMicCapture();
      return;
    }

    // 4. Start polling mic audio and levels
    startAudioPolling();
    if (!isStartingSession(generation)) {
      stopAudioPolling();
      await stopStt();
      await stopMicCapture();
      return;
    }

    state = 'active';
    broadcastState();
    playDictationSound('start');
    console.info('[Dictation] Started');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Dictation] Start failed:', err);
    state = 'idle';
    sessionGeneration += 1;
    broadcastState();
    await cleanupSession();
    broadcastError(message);
    hideDictationOverlay();
  }
}

function isStartingSession(generation: number): boolean {
  return state === 'starting' && generation === sessionGeneration;
}

async function stopDictation(): Promise<void> {
  if (state === 'idle' || state === 'stopping') return;

  state = 'stopping';
  broadcastState();
  playDictationSound('end');

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
  destroyRecorderWindow();
  resetSessionState();
}

async function cleanupSession(): Promise<void> {
  stopAudioPolling();
  stopHoldMonitor();
  await stopStt();
  await stopMicCapture();
  destroyRecorderWindow();
  resetSessionState();
}

function resetSessionState(): void {
  partialTypedText = '';
  partialTypingStrategyUsed = null;
  partialTypingModeUsed = null;
  keyboardPatchStateUnverified = false;
  keyboardPatchUnverifiedTargetText = null;
  micSampleRateHz = AZURE_STT_SAMPLE_RATE_HZ;
  queuedPartialGate.invalidateQueuedPartials();
  axDictationSpan = null;
  axSuppressedUntilNextFinal = false;
  lastBroadcastedMode = 'idle';
  lastAxCaptureAttempt = 0;
  sttCancellationStopRequested = false;
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
      broadcastError('Hold mode could not monitor key release. Check macOS Input Monitoring permission.');
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

  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const recorderDir = mkdtempSync(join(tmpdir(), __BRAND_APP_SLUG + '-dictation-mic-'));
  const htmlPath = join(recorderDir, 'recorder.html');
  writeFileSync(htmlPath, DICTATION_RECORDER_HTML, { encoding: 'utf-8', mode: 0o600 });

  try {
    recorderWindow = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        partition: `${__BRAND_APP_SLUG}-dictation-recorder`,
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
  } finally {
    rmSync(recorderDir, { recursive: true, force: true });
  }
  return recorderWindow;
}

async function startMicCapture(deviceId?: string): Promise<void> {
  const win = await ensureRecorderWindow();
  const escaped = deviceId ? JSON.stringify(deviceId) : 'null';
  const result = await win.webContents.executeJavaScript(`window._mic.startLiveStream(${escaped})`);
  if (!result || result.ok !== true) {
    throw new Error(result?.error ?? 'Unable to start microphone capture');
  }
  micSampleRateHz = normalizeMicSampleRate(result.sampleRate);
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

function destroyRecorderWindow(): void {
  if (!recorderWindow) return;
  try {
    if (!recorderWindow.isDestroyed()) {
      recorderWindow.close();
    }
  } catch {
    // Ignore teardown failures; the app may already be quitting.
  }
  recorderWindow = null;
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

function normalizeMicSampleRate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return AZURE_STT_SAMPLE_RATE_HZ;
  const rounded = Math.round(value);
  if (rounded < 8000 || rounded > 96000) return AZURE_STT_SAMPLE_RATE_HZ;
  return rounded;
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
  const vadSilenceDurationMs = normalizeVadSilenceDurationMs(config?.vadSilenceDurationMs);
  speechConfig.setProperty(
    sdk.PropertyId.Speech_SegmentationSilenceTimeoutMs,
    String(vadSilenceDurationMs),
  );

  const sampleRateHz = normalizeMicSampleRate(micSampleRateHz);
  console.info('[Dictation] STT config: region=%s, language=%s, vadSilenceMs=%d, endpoint=%s, sampleRateHz=%d, keyConfigured=%s',
    region, language, vadSilenceDurationMs, sttEndpoint ?? '(none)', sampleRateHz, Boolean(subscriptionKey));

  // Push stream (actual AudioContext sample rate, 16-bit, mono)
  const format = sdk.AudioStreamFormat.getWaveFormatPCM(sampleRateHz, 16, 1);
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
      console.error('[Dictation] STT canceled: reason=%s errorCode=%s hasDetails=%s',
        sdk.CancellationReason[e.reason],
        sdk.CancellationErrorCode[e.errorCode],
        Boolean(e.errorDetails));
      handleSttCancellationError();
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

function handleSttCancellationError(): void {
  if (sttCancellationStopRequested) return;
  sttCancellationStopRequested = true;
  broadcastError('Speech recognition failed. Check Audio & Voice settings, microphone access, and network connectivity.');
  if (state === 'active' || state === 'starting') {
    void stopDictation();
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

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function handlePartial(text: string): void {
  if (state !== 'active') return;
  sendToOverlay('dictation:partial', text);

  if (!hasEnabledPartialTypingStrategy(config)) return;

  const generation = sessionGeneration;
  const partialRevision = queuedPartialGate.nextPartialRevision();
  enqueueTyping(generation, async () => {
    if (!queuedPartialGate.isCurrent(partialRevision)) return;
    if (keyboardPatchStateUnverified) return;

    if (!axSuppressedUntilNextFinal) {
      await retargetCurrentTypingAnchorBeforeFirstMutation(partialTypedText);
    }

    const mode = getActivePartialTypingMode();
    const strategy = getPartialTypingStrategy(mode);
    if (strategy === 'disabled') return;

    const applied = await applyPartialTypingStrategy(partialTypedText, text, 'partial', strategy, mode);
    if (!isCurrentTypingSession(generation)) return;
    if (!applied) {
      handlePartialTypingFailure(mode, strategy);
      return;
    }

    partialTypedText = text;
    partialTypingStrategyUsed = strategy;
    partialTypingModeUsed = mode;
  });
}

function handleFinal(text: string): void {
  if (state !== 'active' && state !== 'stopping') return;
  sendToOverlay('dictation:final', text);

  const generation = sessionGeneration;
  queuedPartialGate.invalidateQueuedPartials();
  enqueueTyping(generation, async () => {
    const finalText = await maybeCleanupFinalTranscript(text);
    if (!isCurrentTypingSession(generation)) return;

    if (keyboardPatchStateUnverified) {
      axDebug('final found unverified keyboard patch state; attempting recovery');
      if (!await recoverUnverifiedKeyboardPatchState()) {
        axDebug('final skipped because keyboard patch state could not be recovered');
        resetPartialTypingProgress();
        axSuppressedUntilNextFinal = false;
        clearUnverifiedKeyboardPatchState();
        broadcastFinalTypingFailure();
        return;
      }
    }

    const finalWithSpace = finalText + ' ';
    let applied = true;
    if (partialTypedText.length > 0 && partialTypingStrategyUsed && partialTypingModeUsed) {
      applied = await applyPartialTypingStrategy(
        partialTypedText,
        finalWithSpace,
        'final',
        partialTypingStrategyUsed,
        partialTypingModeUsed,
      );
      if (!applied) {
        axDebug(`final strategy failed; refusing fallback strategy=${partialTypingStrategyUsed} mode=${partialTypingModeUsed}`);
      }
    } else {
      if (!isCurrentTypingSession(generation)) return;
      applied = await insertFinalTranscriptWithoutLivePartial(finalWithSpace);
    }
    if (!isCurrentTypingSession(generation)) return;
    if (!applied) {
      if (keyboardPatchStateUnverified && await recoverUnverifiedKeyboardPatchState()) {
        applied = true;
      }
    }
    if (!applied) {
      clearUnverifiedKeyboardPatchState();
      resetPartialTypingProgress();
      axSuppressedUntilNextFinal = false;
      broadcastFinalTypingFailure();
      return;
    }
    partialTypedText = '';
    partialTypingStrategyUsed = null;
    partialTypingModeUsed = null;
    clearUnverifiedKeyboardPatchState();
    axDictationSpan = null;
    axSuppressedUntilNextFinal = false;

    if (state !== 'active') return;
    await delay(POST_FINAL_AX_RECAPTURE_DELAY_MS);
    if (!isCurrentTypingSession(generation) || state !== 'active') return;
    // Re-acquire AX span for the next utterance (cursor is now at new position)
    axDictationSpan = await captureFocusedTextSelectionForAxRewrite();
    broadcastTypingMode(getBroadcastTypingMode());
  });
}

function resetPartialTypingProgress(): void {
  partialTypedText = '';
  partialTypingStrategyUsed = null;
  partialTypingModeUsed = null;
  axDictationSpan = null;
  axSuppressedUntilNextFinal = true;
  broadcastTypingMode(getBroadcastTypingMode());
}

function handlePartialTypingFailure(mode: PartialTypingMode, strategy: PartialTypingStrategy): void {
  axDebug(`partial strategy failed mode=${mode} strategy=${strategy}`);
  if (mode === 'kb' && strategy === 'full-patch' && keyboardPatchStateUnverified) {
    partialTypingStrategyUsed = strategy;
    partialTypingModeUsed = mode;
    axDebug('partial typing paused until final can recover unverified keyboard patch state');
  }
}

async function insertFinalTranscriptWithoutLivePartial(finalText: string): Promise<boolean> {
  if (!await retargetCurrentTypingAnchor()) {
    axDebug('final without live partials skipped because no verified AX anchor is available');
    return false;
  }

  if (await replaceDictatedTextViaAxWithCapture('', finalText, 'final')) {
    return true;
  }

  axDebug('final without live partials skipped blind keyboard fallback after AX anchor failure');
  return false;
}

async function retargetCurrentTypingAnchor(): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return Boolean(axDictationSpan) && !axSuppressedUntilNextFinal;
  }

  if (!await recaptureDictationTargetFocus()) {
    axDictationSpan = null;
    axSuppressedUntilNextFinal = false;
    broadcastTypingMode(getBroadcastTypingMode());
    return false;
  }

  const span = await captureFocusedTextSelectionForAxRewrite();
  if (!span) {
    axDictationSpan = null;
    axSuppressedUntilNextFinal = false;
    broadcastTypingMode(getBroadcastTypingMode());
    return false;
  }

  axDictationSpan = span;
  axSuppressedUntilNextFinal = false;
  broadcastTypingMode(getBroadcastTypingMode());
  return true;
}

function canRetargetBeforeFirstMutation(currentText: string): boolean {
  return currentText.length === 0
    && partialTypedText.length === 0
    && !partialTypingStrategyUsed
    && !partialTypingModeUsed
    && !keyboardPatchStateUnverified;
}

async function retargetCurrentTypingAnchorBeforeFirstMutation(currentText: string): Promise<boolean> {
  if (!canRetargetBeforeFirstMutation(currentText)) return false;
  axDebug('attempting to retarget typing anchor before first live partial mutation');
  return retargetCurrentTypingAnchor();
}

function broadcastFinalTypingFailure(): void {
  broadcastError('Dictation could not safely type the final transcript because the target app, cursor, or selection could not be verified.');
}

function normalizeVadSilenceDurationMs(value: number | undefined): number {
  const raw = typeof value === 'number' && Number.isFinite(value)
    ? value
    : DEFAULT_VAD_SILENCE_DURATION_MS;
  return Math.max(
    MIN_VAD_SILENCE_DURATION_MS,
    Math.min(MAX_VAD_SILENCE_DURATION_MS, Math.round(raw)),
  );
}

async function maybeCleanupFinalTranscript(text: string): Promise<string> {
  if (!config?.finalCleanupEnabled || !fullConfig) return text;

  const raw = text.trim();
  if (!raw) return text;

  try {
    const modelEntry = resolveModelCatalog(fullConfig).defaultEntry;
    if (!modelEntry) return text;

    const model = await createLanguageModelFromConfig(modelEntry.modelConfig);
    const result = await withTimeout(
      generateText({
        model,
        system: FINAL_CLEANUP_PROMPT,
        prompt: [
          'Surrounding text: unavailable',
          'Dictionary entries: none',
          '',
          'Raw transcript:',
          raw,
        ].join('\n'),
        temperature: 0,
        maxRetries: 1,
        maxOutputTokens: Math.max(128, Math.min(800, Math.ceil(raw.length / 2))),
        timeout: { totalMs: FINAL_CLEANUP_TIMEOUT_MS },
      }),
      FINAL_CLEANUP_TIMEOUT_MS + 500,
      'Final transcript cleanup',
    );

    const cleaned = normalizeCleanupResponse(result.text);
    if (!isAcceptableCleanupResponse(raw, cleaned)) return text;
    return cleaned;
  } catch (err) {
    console.warn('[Dictation] Final transcript cleanup failed; using raw final:', err);
    return text;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function getActivePartialTypingMode(): PartialTypingMode {
  return resolveActivePartialTypingMode(config, Boolean(axDictationSpan), axSuppressedUntilNextFinal);
}

function getBroadcastTypingMode(): TypingMode {
  if (!axDictationSpan || axSuppressedUntilNextFinal) return 'idle';
  return getActivePartialTypingMode();
}

function getPartialTypingStrategy(mode: PartialTypingMode): PartialTypingStrategy {
  return getPartialTypingStrategyForConfig(config, mode);
}

async function applyPartialTypingStrategy(
  currentText: string,
  targetText: string,
  phase: DictationPatchPhase,
  strategy: PartialTypingStrategy,
  mode: PartialTypingMode,
): Promise<boolean> {
  switch (strategy) {
    case 'disabled':
      return false;
    case 'full-replacement':
      if (mode !== 'ax') return false;
      return replaceDictatedTextViaAxWithCapture(currentText, targetText, phase);
    case 'ax-verified':
      return replaceDictatedTextViaVerifiedKbWithCapture(currentText, targetText, phase);
    case 'tail-only':
      return applyTailOnlyDictationPatch(currentText, targetText, phase);
    case 'full-patch':
      if (mode !== 'kb') return false;
      return applyVerifiedKeyboardDictationPatch(currentText, targetText, phase);
  }
}

async function ensureAxDictationSpan(currentText: string): Promise<boolean> {
  if (axSuppressedUntilNextFinal) return false;
  if (axDictationSpan) return true;
  if (currentText.length > 0) return false;
  if (await retargetCurrentTypingAnchorBeforeFirstMutation(currentText)) return true;
  if (Date.now() - lastAxCaptureAttempt <= AX_RECAPTURE_COOLDOWN_MS) return false;

  lastAxCaptureAttempt = Date.now();
  axDictationSpan = await captureFocusedTextSelectionForAxRewrite();
  broadcastTypingMode(getBroadcastTypingMode());
  return Boolean(axDictationSpan);
}

async function verifyDictationSpanStartingStateForMutation(
  currentText: string,
  options?: { requireTextMatch?: boolean },
): Promise<boolean> {
  if (await verifyDictationSpanStartingState(currentText, options)) return true;
  if (!await retargetCurrentTypingAnchorBeforeFirstMutation(currentText)) return false;
  return verifyDictationSpanStartingState(currentText, options);
}

function deferFirstPartialAfterVerificationFailure(
  phase: DictationPatchPhase,
  currentText: string,
  reason: string,
): boolean {
  if (phase !== 'partial' || !canRetargetBeforeFirstMutation(currentText)) return false;
  axDebug(`${reason}; deferring first partial and retrying on the next revision`);
  axDictationSpan = null;
  broadcastTypingMode(getBroadcastTypingMode());
  return true;
}

async function replaceDictatedTextViaAxWithCapture(
  currentText: string,
  targetText: string,
  phase: DictationPatchPhase = 'partial',
): Promise<boolean> {
  if (!await ensureAxDictationSpan(currentText)) return false;
  if (!await verifyDictationSpanStartingStateForMutation(currentText)) {
    if (deferFirstPartialAfterVerificationFailure(phase, currentText, 'dictation span changed before AX replacement')) {
      return false;
    }
    suppressAxForCurrentUtterance('dictation span changed before AX replacement');
    return false;
  }
  return replaceDictatedTextViaAx(targetText);
}

async function replaceDictatedTextViaVerifiedKbWithCapture(
  currentText: string,
  targetText: string,
  phase: DictationPatchPhase = 'partial',
): Promise<boolean> {
  if (!await ensureAxDictationSpan(currentText)) return false;
  if (!await verifyDictationSpanStartingStateForMutation(currentText)) {
    if (deferFirstPartialAfterVerificationFailure(phase, currentText, 'dictation span changed before AX-verified replacement')) {
      return false;
    }
    suppressAxForCurrentUtterance('dictation span changed before AX-verified replacement');
    return false;
  }
  return replaceDictatedTextViaVerifiedKb(targetText);
}

async function applyTailOnlyDictationPatch(
  currentText: string,
  targetText: string,
  phase: DictationPatchPhase = 'partial',
): Promise<boolean> {
  if (!await ensureAxDictationSpan(currentText)) return false;
  if (!await verifyDictationSpanStartingStateForMutation(currentText, { requireTextMatch: currentText.length > 0 })) {
    if (deferFirstPartialAfterVerificationFailure(phase, currentText, 'dictation span changed before tail-only replacement')) {
      return false;
    }
    suppressAxForCurrentUtterance('dictation span changed before tail-only replacement');
    return false;
  }

  let mutationAttempted = false;
  if (targetText.startsWith(currentText)) {
    const appendText = targetText.slice(currentText.length);
    mutationAttempted = appendText.length > 0;
    if (!await typeText(appendText)) {
      if (mutationAttempted) markKeyboardPatchStateUnverified(targetText);
      return false;
    }
  } else {
    const backspaceCount = splitGraphemes(currentText).length;
    if (backspaceCount > MAX_SAFE_BACKSPACES) {
      axDebug(`tail-only skipped excessive backspace count=${backspaceCount}`);
      return false;
    }
    mutationAttempted = backspaceCount > 0 || targetText.length > 0;
    if (backspaceCount > 0 && !await typeBackspaces(backspaceCount)) {
      markKeyboardPatchStateUnverified(targetText);
      return false;
    }
    if (targetText && !await typeText(targetText)) {
      markKeyboardPatchStateUnverified(targetText);
      return false;
    }
  }

  if (!mutationAttempted) return true;
  await delay(KEYBOARD_PATCH_VERIFY_DELAY_MS);
  if (!await verifyKeyboardPatchEndingState(targetText)) {
    axDebug(`tail-only ending verification failed targetLen=${targetText.length}`);
    markKeyboardPatchStateUnverified(targetText);
    return false;
  }

  clearUnverifiedKeyboardPatchState();
  updateAxDictationSpanLength(targetText);
  return true;
}

async function applyVerifiedKeyboardDictationPatch(
  currentText: string,
  targetText: string,
  phase: DictationPatchPhase,
): Promise<boolean> {
  if (!isSafeKeyboardPatchText(currentText) || !isSafeKeyboardPatchText(targetText)) {
    axDebug(`applyPatch: skipped non-ascii keyboard patch (phase=${phase})`);
    return false;
  }

  if (!await ensureAxDictationSpan(currentText)) return false;
  if (!await verifyDictationSpanStartingStateForMutation(currentText, { requireTextMatch: true })) {
    axDebug(`applyPatch: skipped unverified keyboard patch start (phase=${phase})`);
    if (deferFirstPartialAfterVerificationFailure(phase, currentText, 'dictation span changed before full-patch replacement')) {
      return false;
    }
    suppressAxForCurrentUtterance('dictation span changed before full-patch replacement');
    return false;
  }

  axDebug(`applyPatch: using verified KB patch (phase=${phase} currentLen=${currentText.length} targetLen=${targetText.length})`);
  const plan = planDictationTextPatch(currentText, targetText, phase);

  let applied = false;
  let mutationAttempted = false;
  switch (plan.kind) {
    case 'none':
      return true;
    case 'append':
      mutationAttempted = true;
      applied = await typeText(plan.text);
      break;
    case 'patch':
      mutationAttempted = plan.operations.length > 0;
      applied = await applyTextPatch(plan.operations);
      break;
    case 'tailRewrite': {
      mutationAttempted = plan.backspaceCount > 0 || Boolean(plan.text);
      if (plan.backspaceCount > MAX_SAFE_BACKSPACES) {
        axDebug(`applyPatch: skipped excessive tail rewrite backspace count=${plan.backspaceCount}`);
        return false;
      }
      if (plan.backspaceCount > 0 && !await typeBackspaces(plan.backspaceCount)) {
        markKeyboardPatchStateUnverified(targetText);
        return false;
      }
      if (plan.text && !await typeText(plan.text)) {
        markKeyboardPatchStateUnverified(targetText);
        return false;
      }
      applied = true;
      break;
    }
  }

  if (!applied) {
    if (mutationAttempted) markKeyboardPatchStateUnverified(targetText);
    return false;
  }
  await delay(KEYBOARD_PATCH_VERIFY_DELAY_MS);
  if (!await verifyKeyboardPatchEndingState(targetText)) {
    axDebug(`applyPatch: ending verification failed (phase=${phase} targetLen=${targetText.length})`);
    markKeyboardPatchStateUnverified(targetText);
    return false;
  }

  clearUnverifiedKeyboardPatchState();
  updateAxDictationSpanLength(targetText);
  return true;
}

async function captureFocusedTextSelectionForAxRewrite(): Promise<AxDictationSpan | null> {
  if (process.platform !== 'darwin') return null;
  const pid = getDictationTargetPid();
  axDebug(`capture: targetPid=${pid}`);
  if (pid == null) {
    axDebug('capture FAILED: no dictation target PID');
    return null;
  }
  try {
    const selection = await readFocusedTextSelection(pid);
    axDebug(`capture result=${JSON.stringify(selection)}`);
    const span = createAxDictationSpanFromSelection(
      selection?.location,
      selection?.length,
      pid,
      selection?.elementSignature,
    );
    if (!span) {
      axDebug(`capture FAILED: invalid location=${selection?.location} length=${selection?.length} element=${selection?.elementSignature ?? 'none'}`);
      return null;
    }
    axDebug(`capture OK: location=${span.location} length=${span.typedUtf16Length} pid=${pid} element=${span.elementSignature}`);
    return span;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    axDebug(`capture EXCEPTION: ${msg}`);
    return null;
  }
}

async function assertLocalMacosAccessibilityTrusted(): Promise<void> {
  if (process.platform !== 'darwin') return;
  try {
    const permissions = await runLocalMacMouseCommand(['permissions']);
    if (permissions.accessibilityTrusted === false) {
      throw new Error('Dictation requires macOS Accessibility permission before it can type safely.');
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('Accessibility permission')) throw err;
    throw new Error('Dictation could not verify macOS Accessibility permission before typing.');
  }
}

type FocusedTextSelection = {
  location: number;
  length: number;
  elementSignature: string;
};

type FocusedTextRangeState = FocusedTextSelection & {
  rangeText: string;
  textUtf16Length?: number;
};

async function readFocusedTextSelection(pid: number | null): Promise<FocusedTextSelection | null> {
  const args = pid != null
    ? ['focusedTextSelection', String(pid)]
    : ['focusedTextSelection'];
  const result = await runLocalMacMouseCommand(args);
  const location = result.selectedTextRangeLocation;
  const length = result.selectedTextRangeLength;
  const elementSignature = result.elementSignature;
  if (
    typeof location !== 'number'
    || typeof length !== 'number'
    || typeof elementSignature !== 'string'
    || !Number.isFinite(location)
    || !Number.isFinite(length)
    || !Number.isInteger(location)
    || !Number.isInteger(length)
    || location < 0
    || length < 0
    || elementSignature.trim().length === 0
  ) {
    return null;
  }
  return { location, length, elementSignature };
}

async function readFocusedTextRangeState(
  pid: number | null,
  rangeLocation: number,
  rangeLength: number,
): Promise<FocusedTextRangeState | null> {
  const args = [
    'focusedTextRangeState',
    String(rangeLocation),
    String(rangeLength),
  ];
  if (pid != null) args.push(String(pid));

  const result = await runLocalMacMouseCommand(args);
  const location = result.selectedTextRangeLocation;
  const length = result.selectedTextRangeLength;
  const rangeText = result.rangeText;
  const textUtf16Length = result.textUtf16Length;
  const elementSignature = result.elementSignature;
  if (
    typeof location !== 'number'
    || typeof length !== 'number'
    || typeof rangeText !== 'string'
    || typeof elementSignature !== 'string'
    || !Number.isFinite(location)
    || !Number.isFinite(length)
    || !Number.isInteger(location)
    || !Number.isInteger(length)
    || location < 0
    || length < 0
    || elementSignature.trim().length === 0
  ) {
    return null;
  }

  return {
    location,
    length,
    elementSignature,
    rangeText,
    textUtf16Length: typeof textUtf16Length === 'number'
      && Number.isFinite(textUtf16Length)
      && Number.isInteger(textUtf16Length)
      && textUtf16Length >= 0
      ? textUtf16Length
      : undefined,
  };
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
    args.push(axDictationSpan.pid != null ? String(axDictationSpan.pid) : '');
    args.push(encodeElementSignature(axDictationSpan.elementSignature));
    const result = await runLocalMacMouseCommand(args);
    updateAxDictationSpanLength(targetText, result.textUtf16Length);
    axDebug(`replaceViaAx OK: method=${result.method ?? 'unknown'} newTypedLen=${axDictationSpan.typedUtf16Length}`);
    return true;
  } catch (err) {
    suppressAxForCurrentUtterance(`AX atomic replacement failed: ${err}`);
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
    args.push(axDictationSpan.pid != null ? String(axDictationSpan.pid) : '');
    args.push(encodeElementSignature(axDictationSpan.elementSignature));
    const result = await runLocalMacMouseCommand(args);
    updateAxDictationSpanLength(targetText, result.textUtf16Length);
    axDebug(`replaceViaVerifiedKb OK: method=${result.method ?? 'unknown'} newTypedLen=${axDictationSpan.typedUtf16Length}`);
    return true;
  } catch (err) {
    suppressAxForCurrentUtterance(`AX-verified keyboard replacement failed: ${err}`);
    axDebug(`replaceViaVerifiedKb FAILED (suppressing until next final): ${err}`);
    console.info('[Dictation] AX-verified keyboard replacement failed:', err);
    return false;
  }
}

function updateAxDictationSpanLength(text: string, utf16Length?: unknown): void {
  if (!axDictationSpan) return;
  axDictationSpan.typedUtf16Length = typeof utf16Length === 'number'
    && Number.isFinite(utf16Length)
    && Number.isInteger(utf16Length)
    && utf16Length >= 0
    ? utf16Length
    : text.length;
}

function suppressAxForCurrentUtterance(reason: string): void {
  axDictationSpan = null;
  axSuppressedUntilNextFinal = true;
  broadcastTypingMode(getBroadcastTypingMode());
  axDebug(`AX suppressed until next final: ${reason}`);
}

function markKeyboardPatchStateUnverified(targetText: string): void {
  keyboardPatchStateUnverified = true;
  keyboardPatchUnverifiedTargetText = targetText;
}

function clearUnverifiedKeyboardPatchState(): void {
  keyboardPatchStateUnverified = false;
  keyboardPatchUnverifiedTargetText = null;
}

async function recoverUnverifiedKeyboardPatchState(): Promise<boolean> {
  const span = axDictationSpan;
  if (!span) return false;

  const candidates = [
    keyboardPatchUnverifiedTargetText,
    partialTypedText,
  ].filter((text): text is string => typeof text === 'string');

  for (const candidate of [...new Set(candidates)]) {
    if (await verifyKeyboardPatchEndingState(candidate)) {
      partialTypedText = candidate;
      updateAxDictationSpanLength(candidate);
      clearUnverifiedKeyboardPatchState();
      axDebug(`recovered unverified keyboard patch state len=${candidate.length}`);
      return true;
    }
  }

  return false;
}

async function verifyDictationSpanStartingState(
  currentText: string,
  options?: { requireTextMatch?: boolean },
): Promise<boolean> {
  const span = axDictationSpan;
  if (!span || axSuppressedUntilNextFinal) return false;

  try {
    if (options?.requireTextMatch && currentText.length > 0) {
      const state = await readFocusedTextRangeState(span.pid, span.location, currentText.length);
      return Boolean(
        state
        && selectionMatchesDictationStart(span, state, currentText.length)
        && state.rangeText === currentText,
      );
    }

    const selection = await readFocusedTextSelection(span.pid);
    return Boolean(selection && selectionMatchesDictationStart(span, selection, currentText.length));
  } catch (err) {
    axDebug(`verifyDictationSpanStartingState FAILED: ${err}`);
    return false;
  }
}

async function verifyKeyboardPatchEndingState(targetText: string): Promise<boolean> {
  const span = axDictationSpan;
  if (!span) return false;

  try {
    const state = await readFocusedTextRangeState(span.pid, span.location, targetText.length);
    return Boolean(
      state
      && selectionMatchesDictationEnd(span, state, targetText.length)
      && state.rangeText === targetText,
    );
  } catch (err) {
    axDebug(`verifyKeyboardPatchEndingState FAILED: ${err}`);
    return false;
  }
}

// ─── Text Insertion via CGEvents ─────────────────────────────────────────────

async function typeText(text: string): Promise<boolean> {
  if (!text) return true;
  const encoded = Buffer.from(text, 'utf-8').toString('base64');
  try {
    const args = ['postText', encoded];
    if (!appendKeyboardTargetPid(args)) return false;
    await runLocalMacMouseCommand(args);
    return true;
  } catch (err) {
    console.error('[Dictation] typeText failed:', err);
    return false;
  }
}

async function typeBackspaces(count: number): Promise<boolean> {
  if (count <= 0) return true;
  if (count > MAX_SAFE_BACKSPACES) {
    console.warn('[Dictation] Refusing excessive backspace count:', count);
    return false;
  }
  try {
    const args = ['deleteBack', String(count)];
    if (!appendKeyboardTargetPid(args)) return false;
    await runLocalMacMouseCommand(args);
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
    const args = ['applyTextPatch', encoded];
    if (!appendKeyboardTargetPid(args)) return false;
    await runLocalMacMouseCommand(args);
    return true;
  } catch (err) {
    console.error('[Dictation] applyTextPatch failed:', err);
    return false;
  }
}

function appendKeyboardTargetPid(args: string[]): boolean {
  const span = axDictationSpan;
  if (process.platform === 'darwin' && !span?.elementSignature) {
    axDebug('keyboard mutation skipped because no verified AX element signature is available');
    return false;
  }
  const pid = span?.pid ?? getDictationTargetPid();
  if (pid == null && process.platform === 'darwin') {
    axDebug('keyboard mutation skipped because no target PID is available');
    return false;
  }
  if (pid != null) {
    args.push(String(pid));
  } else if (span?.elementSignature) {
    args.push('');
  }
  if (span?.elementSignature) args.push(encodeElementSignature(span.elementSignature));
  return true;
}

function encodeElementSignature(signature: string): string {
  return Buffer.from(signature, 'utf-8').toString('base64');
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
      const resampleTo16k = (input, inputSampleRate) => {
        if (inputSampleRate === 16000) return input;
        const ratio = inputSampleRate / 16000;
        const outputLength = Math.max(1, Math.round(input.length / ratio));
        const output = new Float32Array(outputLength);
        for (let i = 0; i < outputLength; i++) {
          const sourceIndex = i * ratio;
          const before = Math.floor(sourceIndex);
          const after = Math.min(before + 1, input.length - 1);
          const fraction = sourceIndex - before;
          output[i] = input[before] * (1 - fraction) + input[after] * fraction;
        }
        return output;
      };
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
        const pcmInput = resampleTo16k(float32, this.context.sampleRate);
        const pcm16 = new Int16Array(pcmInput.length);
        for (let i = 0; i < pcmInput.length; i++) {
          const s = Math.max(-1, Math.min(1, pcmInput[i]));
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
      return { ok: true, sampleRate: 16000 };
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
