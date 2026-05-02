/**
 * useVoiceRecording — Manages the full recording lifecycle.
 *
 * Encapsulates mic capture, background speech collection, elapsed timer,
 * audio level polling, and audio feedback tones. Thread.tsx consumes the
 * returned state to drive RecordingOverlay and RecordingButton.
 *
 * Transcription strategy:
 * - Web bridge (browser): uses BackgroundSpeechCollector (Web Speech API)
 * - Electron + Azure configured: IPC mic recording → WAV → batchTranscribe
 * - Electron + native provider: IPC mic recording → WAV → batchTranscribe
 *   still requires Azure credentials; falls back to empty transcript if
 *   no Azure key is set (Web Speech API doesn't work in Electron).
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useConfig } from '@/providers/ConfigProvider';
import { createBackgroundSpeechCollector, type BackgroundSpeechCollector } from '@/lib/audio/background-speech-collector';
import { WebAudioMonitor } from '@/lib/audio/web-audio-monitor';

type RecordingState = 'idle' | 'recording' | 'transcribing';

function debugLog(msg: string) {
  try {
    const w = window as unknown as { app?: { debug?: { log: (file: string, message: string) => void } } };
    w.app?.debug?.log('recording', `[useVoiceRecording] ${msg}`);
  } catch { /* ignore */ }
}

/** Short audio feedback tone via Web Audio API */
function playTone(frequency: number, endFrequency: number, duration = 0.12) {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency, ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(endFrequency, ctx.currentTime + duration);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
    setTimeout(() => ctx.close(), (duration + 0.1) * 1000);
  } catch { /* audio not available */ }
}

type MicApi = {
  startRecording: (deviceId?: string) => Promise<{ ok?: boolean; error?: string }>;
  stopRecording: () => Promise<{ wavBase64?: string; durationSec?: number; error?: string }>;
  cancelRecording: () => Promise<{ ok?: boolean }>;
  startMonitor: (deviceIds?: string[]) => Promise<unknown>;
  getLevel: () => Promise<Record<string, number>>;
  stopMonitor: () => Promise<unknown>;
  batchTranscribe: (options: {
    wavBase64?: string;
    language: string;
  }) => Promise<{ text: string; error?: string }>;
};

export interface UseVoiceRecordingResult {
  recordingState: RecordingState;
  elapsedSec: number;
  inputLevel: number;
  isMuted: boolean;
  toggleMute: () => void;
  startRecording: () => void;
  stopAndTranscribe: () => Promise<string>;
  cancelRecording: () => void;
}

export function useVoiceRecording(): UseVoiceRecordingResult {
  const { config } = useConfig();
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [elapsedSec, setElapsedSec] = useState(0);
  const [inputLevel, setInputLevel] = useState(0);
  const [isMuted, setIsMuted] = useState(false);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const levelTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const collectorRef = useRef<BackgroundSpeechCollector | null>(null);
  const webMonitorUnsubRef = useRef<(() => void) | null>(null);

  const isWebBridge = Boolean(
    (window as unknown as Record<string, unknown>).app &&
    (window.app as Record<string, unknown>).__isWebBridge,
  );

  const audioConfig = (config as Record<string, unknown> | null)?.audio as {
    provider?: string;
    azure?: { subscriptionKey?: string; region?: string; endpoint?: string; sttLanguage?: string };
    recording?: { enabled?: boolean; language?: string; inputDeviceId?: string };
  } | undefined;
  const recordingConfig = audioConfig?.recording;
  const selectedDeviceId = recordingConfig?.inputDeviceId;
  const language = recordingConfig?.language ?? audioConfig?.azure?.sttLanguage ?? 'en-US';

  // ── Helpers ─────────────────────────────────────────────────────

  const getMic = useCallback((): MicApi | undefined => {
    return (window as unknown as { app?: { mic?: MicApi } }).app?.mic;
  }, []);

  const cleanupTimers = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (levelTimerRef.current) { clearInterval(levelTimerRef.current); levelTimerRef.current = null; }
    webMonitorUnsubRef.current?.();
    webMonitorUnsubRef.current = null;
  }, []);

  const stopMic = useCallback(() => {
    const mic = getMic();
    if (mic) {
      mic.stopRecording().catch(() => { /* ignore */ });
      mic.stopMonitor().catch(() => { /* ignore */ });
    }
  }, [getMic]);

  // ── Start Recording ──────────────────────────────────────────────

  const startRecording = useCallback(async () => {
    if (recordingState !== 'idle') return;

    const deviceId = selectedDeviceId ?? 'default';

    // Show the overlay immediately (optimistic UI)
    setRecordingState('recording');
    setElapsedSec(0);
    playTone(320, 480);

    // Elapsed timer — start right away
    let elapsed = 0;
    timerRef.current = setInterval(() => {
      elapsed += 1;
      setElapsedSec(elapsed);
    }, 1000);

    // Web bridge: use BackgroundSpeechCollector + WebAudioMonitor
    if (isWebBridge) {
      debugLog(`web bridge recording, device=${deviceId}, language=${language}`);
      const collector = createBackgroundSpeechCollector(language);
      collectorRef.current = collector;
      collector.start();

      const monitor = WebAudioMonitor.getInstance();
      webMonitorUnsubRef.current = monitor.subscribeAll([deviceId]);
      levelTimerRef.current = setInterval(() => {
        const levels = monitor.getLevels();
        setInputLevel(levels[deviceId] ?? 0);
      }, 66);
      return;
    }

    // Electron: use IPC mic for WAV capture + level monitoring
    const mic = getMic();
    if (!mic) {
      debugLog('mic API not available');
      cleanupTimers();
      setRecordingState('idle');
      return;
    }

    try {
      // Start recording and monitoring in parallel
      const [result] = await Promise.all([
        mic.startRecording(selectedDeviceId ?? undefined),
        mic.startMonitor([deviceId]),
      ]);

      if (result.error) {
        debugLog(`start error: ${result.error}`);
        cleanupTimers();
        setRecordingState('idle');
        return;
      }

      debugLog(`recording started, device=${deviceId}, language=${language}`);

      // Audio level polling
      levelTimerRef.current = setInterval(() => {
        mic.getLevel().then((levels) => {
          setInputLevel(levels[deviceId] ?? 0);
        }).catch(() => setInputLevel(0));
      }, 66);

    } catch (err) {
      console.error('[useVoiceRecording] Start failed:', err);
      cleanupTimers();
      setRecordingState('idle');
    }
  }, [recordingState, selectedDeviceId, language, isWebBridge, cleanupTimers, getMic]);

  // ── Stop & Transcribe ────────────────────────────────────────────

  const stopAndTranscribe = useCallback(async (): Promise<string> => {
    if (recordingState !== 'recording') return '';

    cleanupTimers();
    playTone(480, 320);

    // Web bridge: use the background speech collector (synchronous)
    if (isWebBridge) {
      let transcript = '';
      if (collectorRef.current) {
        debugLog('stopping web collector...');
        transcript = collectorRef.current.stop();
        collectorRef.current = null;
        debugLog(`web collector returned: chars=${transcript.length}`);
      }
      setRecordingState('idle');
      setElapsedSec(0);
      setInputLevel(0);
      setIsMuted(false);
      return transcript;
    }

    // Electron: stop IPC recording → get WAV → transcribe
    const mic = getMic();
    if (!mic) {
      setRecordingState('idle');
      setElapsedSec(0);
      setInputLevel(0);
      setIsMuted(false);
      return '';
    }

    setRecordingState('transcribing');

    try {
      mic.stopMonitor().catch(() => { /* ignore */ });

      const result = await mic.stopRecording();
      if (result.error || !result.wavBase64) {
        debugLog(`stopRecording error: ${result.error ?? 'no audio'}`);
        setRecordingState('idle');
        setElapsedSec(0);
        setInputLevel(0);
        setIsMuted(false);
        return '';
      }

      debugLog(`got WAV: ${result.wavBase64.length} b64 chars, ${result.durationSec ?? 0}s`);

      // Transcription credentials are resolved in the main process from config
      debugLog('sending WAV for transcription...');
      const txResult = await mic.batchTranscribe({
        wavBase64: result.wavBase64,
        language,
      });

      if (txResult.error) {
        debugLog(`transcription error: ${txResult.error}`);
      } else {
        debugLog(`transcription done: chars=${txResult.text.length}`);
      }

      setRecordingState('idle');
      setElapsedSec(0);
      setInputLevel(0);
      setIsMuted(false);
      return txResult.text ?? '';

    } catch (err) {
      console.error('[useVoiceRecording] Transcription failed:', err);
      setRecordingState('idle');
      setElapsedSec(0);
      setInputLevel(0);
      setIsMuted(false);
      return '';
    }
  }, [recordingState, isWebBridge, cleanupTimers, getMic, language]);

  // ── Cancel Recording ─────────────────────────────────────────────

  const cancelRecording = useCallback(() => {
    if (recordingState !== 'recording') return;

    cleanupTimers();
    playTone(480, 320);

    if (isWebBridge) {
      collectorRef.current?.destroy();
      collectorRef.current = null;
    } else {
      const mic = getMic();
      if (mic) {
        mic.cancelRecording().catch(() => { /* ignore */ });
        mic.stopMonitor().catch(() => { /* ignore */ });
      }
    }

    setRecordingState('idle');
    setElapsedSec(0);
    setInputLevel(0);
    setIsMuted(false);
  }, [recordingState, isWebBridge, cleanupTimers, getMic]);

  // ── Toggle Mute ─────────────────────────────────────────────────

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => !prev);
  }, []);

  // ── Cleanup on unmount ───────────────────────────────────────────

  useEffect(() => {
    return () => {
      cleanupTimers();
      collectorRef.current?.destroy();
    };
  }, [cleanupTimers]);

  return {
    recordingState,
    elapsedSec,
    inputLevel: isMuted ? 0 : inputLevel,
    isMuted,
    toggleMute,
    startRecording: () => void startRecording(),
    stopAndTranscribe,
    cancelRecording,
  };
}
