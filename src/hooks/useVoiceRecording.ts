/**
 * useVoiceRecording — Manages the full recording lifecycle.
 *
 * Encapsulates mic capture, background speech collection, elapsed timer,
 * audio level polling, and audio feedback tones. Thread.tsx consumes the
 * returned state to drive RecordingOverlay and RecordingButton.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useConfig } from '@/providers/ConfigProvider';
import { createBackgroundSpeechCollector, type BackgroundSpeechCollector } from '@/lib/audio/background-speech-collector';
import { WebAudioMonitor } from '@/lib/audio/web-audio-monitor';

type RecordingState = 'idle' | 'recording';

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

export interface UseVoiceRecordingResult {
  recordingState: RecordingState;
  elapsedSec: number;
  inputLevel: number;
  isMuted: boolean;
  toggleMute: () => void;
  startRecording: () => void;
  stopAndTranscribe: () => string;
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
    recording?: { enabled?: boolean; language?: string; inputDeviceId?: string };
  } | undefined;
  const recordingConfig = audioConfig?.recording;
  const selectedDeviceId = recordingConfig?.inputDeviceId;
  const language = recordingConfig?.language ?? 'en-US';

  // ── Cleanup helpers ──────────────────────────────────────────────

  const cleanupTimers = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (levelTimerRef.current) {
      clearInterval(levelTimerRef.current);
      levelTimerRef.current = null;
    }
    webMonitorUnsubRef.current?.();
    webMonitorUnsubRef.current = null;
  }, []);

  const stopMic = useCallback(() => {
    const mic = (window as unknown as { app?: { mic?: Record<string, unknown> } }).app?.mic as {
      stopRecording: () => Promise<unknown>;
      stopMonitor: () => Promise<unknown>;
    } | undefined;
    if (mic) {
      mic.stopRecording().catch(() => { /* ignore */ });
      mic.stopMonitor().catch(() => { /* ignore */ });
    }
  }, []);

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

    // For web bridge, we don't need the IPC mic — use WebAudioMonitor for levels
    if (isWebBridge) {
      debugLog(`web bridge recording, device=${deviceId}, language=${language}`);

      // Start background speech collector
      const collector = createBackgroundSpeechCollector(language);
      collectorRef.current = collector;
      collector.start();

      // Audio level polling via WebAudioMonitor
      const monitor = WebAudioMonitor.getInstance();
      webMonitorUnsubRef.current = monitor.subscribeAll([deviceId]);
      levelTimerRef.current = setInterval(() => {
        const levels = monitor.getLevels();
        setInputLevel(levels[deviceId] ?? 0);
      }, 66);

      return;
    }

    // Electron path: use IPC mic API
    const mic = (window as unknown as { app?: { mic?: Record<string, unknown> } }).app?.mic as {
      startRecording: (deviceId?: string) => Promise<{ ok?: boolean; error?: string }>;
      startMonitor: (deviceIds?: string[]) => Promise<unknown>;
      getLevel: () => Promise<Record<string, number>>;
    } | undefined;

    if (!mic) {
      debugLog('mic API not available');
      cleanupTimers();
      setRecordingState('idle');
      return;
    }

    try {
      // Start mic recording and monitoring in parallel
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

      // Start background speech collector
      debugLog(`creating speech collector language=${language}`);
      const collector = createBackgroundSpeechCollector(language);
      collectorRef.current = collector;
      collector.start();

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
  }, [recordingState, selectedDeviceId, language, isWebBridge, cleanupTimers]);

  // ── Stop & Transcribe ────────────────────────────────────────────

  const stopAndTranscribe = useCallback((): string => {
    if (recordingState !== 'recording') return '';

    cleanupTimers();
    stopMic();
    playTone(480, 320); // falling tone

    let transcript = '';
    if (collectorRef.current) {
      debugLog('stopping collector...');
      transcript = collectorRef.current.stop();
      collectorRef.current = null;
      debugLog(`collector returned: chars=${transcript.length}`);
    }

    setRecordingState('idle');
    setElapsedSec(0);
    setInputLevel(0);
    setIsMuted(false);

    return transcript;
  }, [recordingState, cleanupTimers, stopMic]);

  // ── Cancel Recording ─────────────────────────────────────────────

  const cancelRecording = useCallback(() => {
    if (recordingState !== 'recording') return;

    cleanupTimers();
    stopMic();
    playTone(480, 320); // falling tone

    collectorRef.current?.destroy();
    collectorRef.current = null;

    setRecordingState('idle');
    setElapsedSec(0);
    setInputLevel(0);
    setIsMuted(false);
  }, [recordingState, cleanupTimers, stopMic]);

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
