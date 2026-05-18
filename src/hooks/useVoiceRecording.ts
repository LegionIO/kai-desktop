/**
 * useVoiceRecording — Manages the full recording lifecycle.
 *
 * Encapsulates mic capture, background speech collection, elapsed timer,
 * audio level polling, and audio feedback tones. Thread.tsx consumes the
 * returned state to drive RecordingOverlay and RecordingButton.
 *
 * Transcription strategy:
 * - Web bridge (browser): uses BackgroundSpeechCollector (Web Speech API)
 * - Electron + OpenAI streaming STT: IPC stt:stream-start/stop with live partials
 *   (streaming-stt.ts owns mic lifecycle — no separate startRecording needed)
 * - Electron + batch: IPC mic recording → WAV → batchTranscribe (Azure/Whisper)
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
  streamStart: (options?: { deviceId?: string; language?: string }) => Promise<{ ok?: boolean; error?: string }>;
  streamStop: () => Promise<{ text: string; error?: string }>;
  streamCancel: () => Promise<{ ok?: boolean }>;
  onPartial: (callback: (text: string) => void) => () => void;
  onFinal: (callback: (text: string) => void) => () => void;
  onSttError: (callback: (error: string) => void) => () => void;
};

export interface UseVoiceRecordingResult {
  recordingState: RecordingState;
  elapsedSec: number;
  inputLevel: number;
  isMuted: boolean;
  partialTranscript: string;
  isStreaming: boolean;
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
  const [partialTranscript, setPartialTranscript] = useState('');

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const levelTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const collectorRef = useRef<BackgroundSpeechCollector | null>(null);
  const webMonitorUnsubRef = useRef<(() => void) | null>(null);
  const partialUnsubRef = useRef<(() => void) | null>(null);
  const finalUnsubRef = useRef<(() => void) | null>(null);
  const errorUnsubRef = useRef<(() => void) | null>(null);
  const isStreamingRef = useRef(false);
  const isBatchRecordingRef = useRef(false);
  const startingRef = useRef(false); // Synchronous guard against double-start

  const isWebBridge = Boolean(
    (window as unknown as Record<string, unknown>).app &&
    (window.app as Record<string, unknown>).__isWebBridge,
  );

  const audioConfig = (config as Record<string, unknown> | null)?.audio as {
    provider?: string;
    azure?: { subscriptionKey?: string; region?: string; endpoint?: string; sttLanguage?: string };
    recording?: { enabled?: boolean; language?: string; inputDeviceId?: string };
    stt?: { provider?: string; openai?: { baseUrl?: string; apiKey?: string; model?: string }; livePartials?: boolean };
  } | undefined;
  const recordingConfig = audioConfig?.recording;
  const selectedDeviceId = recordingConfig?.inputDeviceId;
  const language = recordingConfig?.language ?? audioConfig?.azure?.sttLanguage ?? 'en-US';

  // Determine if streaming STT is available
  const useStreamingStt = audioConfig?.stt?.provider === 'openai' && Boolean(audioConfig?.stt?.openai?.apiKey);
  const livePartials = audioConfig?.stt?.livePartials !== false; // default true

  // ── Helpers ─────────────────────────────────────────────────────

  const getMic = useCallback((): MicApi | undefined => {
    return (window as unknown as { app?: { mic?: MicApi } }).app?.mic;
  }, []);

  const cleanupTimers = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (levelTimerRef.current) { clearInterval(levelTimerRef.current); levelTimerRef.current = null; }
    webMonitorUnsubRef.current?.();
    webMonitorUnsubRef.current = null;
    partialUnsubRef.current?.();
    partialUnsubRef.current = null;
    finalUnsubRef.current?.();
    finalUnsubRef.current = null;
    errorUnsubRef.current?.();
    errorUnsubRef.current = null;
  }, []);

  // ── Start Recording ──────────────────────────────────────────────

  const startRecording = useCallback(async () => {
    if (recordingState !== 'idle') return;
    if (startingRef.current) return; // Prevent double-start before state updates
    startingRef.current = true;

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
      startingRef.current = false;
      return;
    }

    // Electron: use IPC mic for WAV capture + level monitoring
    const mic = getMic();
    if (!mic) {
      debugLog('mic API not available');
      cleanupTimers();
      setRecordingState('idle');
      startingRef.current = false;
      return;
    }

    // ── Streaming STT path (OpenAI Realtime) ──
    // streaming-stt.ts owns mic lifecycle: it calls startLiveStream/stopLiveStream internally.
    // We only call streamStart/streamStop and subscribe to partial/final events.
    if (useStreamingStt) {
      debugLog(`starting streaming STT, device=${deviceId}, language=${language}`);
      isStreamingRef.current = true;
      setPartialTranscript('');

      // Subscribe to partial/final transcript events
      if (livePartials) {
        partialUnsubRef.current = mic.onPartial((text) => {
          setPartialTranscript(text);
        });
      }
      finalUnsubRef.current = mic.onFinal((text) => {
        setPartialTranscript(text);
      });

      // Subscribe to error events to reset UI if backend dies
      errorUnsubRef.current = mic.onSttError(() => {
        debugLog('STT error received, resetting UI');
        cleanupTimers();
        isStreamingRef.current = false;
        setRecordingState('idle');
        setElapsedSec(0);
        setInputLevel(0);
        setPartialTranscript('');
        startingRef.current = false;
        // Release the audio level monitor to prevent resource leak
        mic.stopMonitor().catch(() => { /* ignore */ });
      });

      // Start the streaming session (handles mic start internally)
      try {
        const streamResult = await mic.streamStart({
          deviceId: selectedDeviceId ?? undefined,
          language,
        });
        if (streamResult.error) {
          debugLog(`stream start error: ${streamResult.error}`);
          cleanupTimers();
          isStreamingRef.current = false;
          setRecordingState('idle');
          startingRef.current = false;
          return;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        debugLog(`stream start exception: ${message}`);
        cleanupTimers();
        isStreamingRef.current = false;
        setRecordingState('idle');
        startingRef.current = false;
        return;
      }

      // Level monitoring (separate from mic capture — uses the monitor API)
      // Guard: if canceled during the await above, don't set up level polling
      if (!isStreamingRef.current) {
        startingRef.current = false;
        return;
      }
      try { await mic.startMonitor([deviceId]); } catch { /* ignore */ }
      if (!isStreamingRef.current) {
        // Canceled during startMonitor await — clean up
        mic.stopMonitor().catch(() => { /* ignore */ });
        startingRef.current = false;
        return;
      }
      levelTimerRef.current = setInterval(() => {
        mic.getLevel().then((levels) => {
          setInputLevel(levels[deviceId] ?? 0);
        }).catch(() => setInputLevel(0));
      }, 66);

      debugLog('streaming STT started');
      startingRef.current = false;
      return;
    }

    // ── Batch recording path (existing) ──
    try {
      // Start recording before monitoring so the meter can attach to the
      // already-open mic stream on first-run device warmup.
      const result = await mic.startRecording(selectedDeviceId ?? undefined);

      if (result.error) {
        debugLog(`start error: ${result.error}`);
        cleanupTimers();
        setRecordingState('idle');
        startingRef.current = false;
        return;
      }

      try {
        await mic.startMonitor([deviceId]);
      } catch (monitorErr) {
        const message = monitorErr instanceof Error ? monitorErr.message : String(monitorErr);
        debugLog(`monitor start error: ${message}`);
      }

      debugLog(`recording started, device=${deviceId}, language=${language}`);
      isBatchRecordingRef.current = true;

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
    startingRef.current = false;
  }, [recordingState, selectedDeviceId, language, isWebBridge, useStreamingStt, livePartials, cleanupTimers, getMic]);

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
      setPartialTranscript('');
      return transcript;
    }

    // Electron: stop recording
    const mic = getMic();
    if (!mic) {
      setRecordingState('idle');
      setElapsedSec(0);
      setInputLevel(0);
      setIsMuted(false);
      setPartialTranscript('');
      return '';
    }

    // ── Streaming STT stop path ──
    // streaming-stt.ts handles: final drain → commit → wait for transcription → stop mic
    if (isStreamingRef.current) {
      setRecordingState('transcribing');
      isStreamingRef.current = false;

      try {
        mic.stopMonitor().catch(() => { /* ignore */ });

        debugLog('stopping stream...');
        const result = await mic.streamStop();

        if (result.error) {
          debugLog(`stream stop error: ${result.error}`);
        } else {
          debugLog(`stream stop: chars=${result.text.length}`);
        }

        const transcript = result.text ?? '';
        setRecordingState('idle');
        setElapsedSec(0);
        setInputLevel(0);
        setIsMuted(false);
        setPartialTranscript('');
        return transcript;
      } catch (err) {
        console.error('[useVoiceRecording] Stream stop failed:', err);
        setRecordingState('idle');
        setElapsedSec(0);
        setInputLevel(0);
        setIsMuted(false);
        setPartialTranscript('');
        return '';
      }
    }

    // ── Batch stop path (existing) ──
    setRecordingState('transcribing');
    isBatchRecordingRef.current = false;

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
        if (isStreamingRef.current) {
          // Use streamCancel — tears down immediately without committing audio
          mic.streamCancel().catch(() => { /* ignore */ });
          isStreamingRef.current = false;
        } else {
          mic.cancelRecording().catch(() => { /* ignore */ });
        }
        mic.stopMonitor().catch(() => { /* ignore */ });
      }
    }

    setRecordingState('idle');
    setElapsedSec(0);
    setInputLevel(0);
    setIsMuted(false);
    setPartialTranscript('');
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

      const mic = (window as unknown as { app?: { mic?: MicApi } }).app?.mic;
      if (isStreamingRef.current) {
        // Cancel active streaming session on unmount to prevent leak
        if (mic) {
          mic.streamCancel().catch(() => { /* ignore */ });
          mic.stopMonitor().catch(() => { /* ignore */ });
        }
        isStreamingRef.current = false;
      } else if (isBatchRecordingRef.current) {
        // Cancel active batch recording on unmount
        if (mic) {
          mic.cancelRecording().catch(() => { /* ignore */ });
          mic.stopMonitor().catch(() => { /* ignore */ });
        }
        isBatchRecordingRef.current = false;
      } else if (mic) {
        // Stop monitor if nothing else is active
        mic.stopMonitor().catch(() => { /* ignore */ });
      }
    };
  }, [cleanupTimers]);

  return {
    recordingState,
    elapsedSec,
    inputLevel: isMuted ? 0 : inputLevel,
    isMuted,
    partialTranscript,
    isStreaming: isStreamingRef.current,
    toggleMute,
    startRecording: () => void startRecording(),
    stopAndTranscribe,
    cancelRecording,
  };
}
