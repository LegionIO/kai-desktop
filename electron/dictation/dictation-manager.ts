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
  type DictationPatchOperation,
  type DictationPatchPhase,
} from './text-patch-planner.js';
import { DictationQueuedPartialGate } from './typing-revision-gate.js';

export type DictationState = 'idle' | 'starting' | 'active' | 'stopping';

interface DictationConfig {
  enabled: boolean;
  hotkey: string;
  mode: 'toggle' | 'hold';
  inputDeviceId?: string | null;
  language?: string;
  livePartials?: boolean;
}

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
const queuedPartialGate = new DictationQueuedPartialGate();

// Hold mode state
let holdMonitor: LocalMacosTakeoverMonitorHandle | null = null;
let holdSafetyTimeout: ReturnType<typeof setTimeout> | null = null;

/** macOS virtual key codes for modifier keys */
const MODIFIER_KEYCODES: Record<string, number> = {
  command: 55,
  cmd: 55,
  shift: 56,
  // right shift = 60, but globalShortcut doesn't differentiate
  option: 58,
  alt: 58,
  control: 59,
  ctrl: 59,
};

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
    elapsed: state === 'active' ? Math.floor((Date.now() - sessionStartTime) / 1000) : 0,
  };
}

// ─── Private ─────────────────────────────────────────────────────────────────

function registerHotkey(hotkey: string): void {
  try {
    const success = globalShortcut.register(hotkey, () => {
      if (config?.mode === 'hold') {
        // Hold mode: key-down starts dictation, key-up stops it.
        // globalShortcut only fires on key-down, so we start here
        // and use a native monitor to detect modifier release.
        if (state === 'idle') {
          void startDictation().then(() => {
            if (state === 'active') {
              startHoldMonitor(hotkey);
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
    // 1. Show overlay
    await showDictationOverlay();

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
  sessionGeneration += 1;
  broadcastState();

  await cleanupSession();

  state = 'idle';
  broadcastState();
  hideDictationOverlay();
  console.info('[Dictation] Stopped');
}

async function cleanupSession(): Promise<void> {
  stopAudioPolling();
  stopHoldMonitor();
  await stopStt();
  await stopMicCapture();
  partialTypedText = '';
  queuedPartialGate.invalidateQueuedPartials();
}

// ─── Hold Mode Monitor ──────────────────────────────────────────────────────

/**
 * Parse an Electron accelerator string (e.g. "Command+Shift+D") into the set
 * of macOS virtual key codes for its modifier keys.
 */
function parseHotkeyModifierCodes(hotkey: string): Set<number> {
  const codes = new Set<number>();
  const parts = hotkey.split('+').map(p => p.trim().toLowerCase());
  // Last part is the primary key; everything before is a modifier
  for (const part of parts.slice(0, -1)) {
    // Handle "commandorcontrol" → both command and control
    const normalized = part.replace('commandorcontrol', 'command');
    const code = MODIFIER_KEYCODES[normalized];
    if (code !== undefined) codes.add(code);
  }
  return codes;
}

/**
 * Start monitoring for key release to stop dictation in hold mode.
 * Uses the existing native CGEventTap monitor that emits flagsChanged events
 * with keyCode when modifier keys are pressed or released.
 */
function startHoldMonitor(hotkey: string): void {
  stopHoldMonitor(); // Clean up any existing monitor

  const modifierCodes = parseHotkeyModifierCodes(hotkey);
  if (modifierCodes.size === 0) {
    // No modifiers to watch — can't detect release, fall back to toggle behavior
    console.warn('[Dictation] Hold mode: no modifier keys in hotkey, cannot detect release');
    return;
  }

  console.info('[Dictation] Hold mode: watching for modifier release (keyCodes: %s)', [...modifierCodes].join(','));

  holdMonitor = startLocalMacosTakeoverMonitor({
    onEvent: (event) => {
      // flagsChanged fires when any modifier key is pressed or released.
      // If the keyCode matches one of our hotkey modifiers, the user released it.
      if (event.eventType === 'flagsChanged' && event.keyCode !== undefined) {
        if (modifierCodes.has(event.keyCode)) {
          console.info('[Dictation] Hold mode: modifier released (keyCode=%d), stopping', event.keyCode);
          void stopDictation();
        }
      }
    },
    onError: (message) => {
      console.warn('[Dictation] Hold monitor error:', message);
      // If monitor fails, stop dictation to prevent stuck state
      if (state === 'active') {
        void stopDictation();
      }
    },
  });

  // Safety timeout: auto-stop if held for too long (prevents stuck dictation)
  holdSafetyTimeout = setTimeout(() => {
    console.warn('[Dictation] Hold mode: safety timeout reached, stopping');
    void stopDictation();
  }, HOLD_SAFETY_TIMEOUT_MS);
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

async function stopMicCapture(): Promise<void> {
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    try {
      await recorderWindow.webContents.executeJavaScript('window._mic.stopLiveStream()');
    } catch { /* ignore */ }
  }
}

async function drainMicChunks(): Promise<string[]> {
  if (!recorderWindow || recorderWindow.isDestroyed()) return [];
  try {
    return await recorderWindow.webContents.executeJavaScript('window._mic.drainLiveChunks()');
  } catch {
    return [];
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
    if (!pushStream) return;
    const chunks = await drainMicChunks();
    for (const chunk of chunks) {
      try {
        const buf = Buffer.from(chunk, 'base64');
        pushStream.write(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      } catch { /* ignore */ }
    }
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
  return state === 'active' && generation === sessionGeneration;
}

function enqueueTyping(generation: number, fn: () => Promise<void>): void {
  typingQueue = typingQueue.then(async () => {
    if (!isCurrentTypingSession(generation)) return;
    await fn();
  }).catch((err) => {
    console.error('[Dictation] Typing queue error:', err);
  });
}

function handlePartial(text: string): void {
  if (state !== 'active') return;
  sendToOverlay('dictation:partial', text);

  if (!config?.livePartials) return;

  const generation = sessionGeneration;
  const partialRevision = queuedPartialGate.nextPartialRevision();
  enqueueTyping(generation, async () => {
    if (!queuedPartialGate.isCurrent(partialRevision)) return;

    const applied = await applyDictationPatch(partialTypedText, text, 'partial');
    if (!isCurrentTypingSession(generation)) return;
    if (!applied) return;

    partialTypedText = text;
  });
}

function handleFinal(text: string): void {
  if (state !== 'active') return;
  sendToOverlay('dictation:final', text);

  const generation = sessionGeneration;
  queuedPartialGate.invalidateQueuedPartials();
  enqueueTyping(generation, async () => {
    let applied = true;
    if (config?.livePartials && partialTypedText.length > 0) {
      const finalWithSpace = text + ' ';
      applied = await applyDictationPatch(partialTypedText, finalWithSpace, 'final');
    } else {
      if (!isCurrentTypingSession(generation)) return;
      applied = await typeText(text + ' ');
    }
    if (!isCurrentTypingSession(generation)) return;
    if (!applied) return;
    partialTypedText = '';
  });
}

async function applyDictationPatch(
  currentText: string,
  targetText: string,
  phase: DictationPatchPhase,
): Promise<boolean> {
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
    if (this.processor) { this.processor.disconnect(); this.processor = null; }
    if (this.context) { this.context.close().catch(() => {}); this.context = null; }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    this.chunks = [];
    this.level = 0;
  },
};
</script></body></html>`;
