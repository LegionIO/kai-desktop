/**
 * DictationButton — Click-to-toggle voice dictation.
 *
 * A simple bordered button that starts/stops speech recognition on click.
 * Uses useComposerRuntime({ optional: true }) so it works both inside
 * assistant-ui thread context (chat) and outside it (task creation).
 *
 * When used outside assistant-ui, pass `getText` and `setText` props to
 * wire up to the host input's state.
 */

import { useState, useCallback, useEffect, useRef, type FC } from 'react';
import { useComposerRuntime } from '@assistant-ui/react';
import { useConfig } from '@/providers/ConfigProvider';
import {
  isDictationSupportedForProvider,
  createUnifiedDictationAdapter,
  type DictationSession,
  type AudioProvider,
} from '@/lib/audio/speech-adapters';
import { Tooltip } from '@/components/ui/Tooltip';
import { MicIcon } from 'lucide-react';

export interface DictationButtonProps {
  onListeningChange?: (listening: boolean) => void;
  startRef?: React.RefObject<(() => void) | null>;
  stopRef?: React.RefObject<(() => void) | null>;
  getText?: () => string;
  setText?: (text: string) => void;
}

export const DictationButton: FC<DictationButtonProps> = ({ onListeningChange, startRef, stopRef, getText: externalGetText, setText: externalSetText }) => {
  const composerRuntime = useComposerRuntime({ optional: true });
  const getTextFn = useCallback(() => externalGetText ? externalGetText() : (composerRuntime?.getState().text ?? ''), [externalGetText, composerRuntime]);
  const setTextFn = useCallback((text: string) => externalSetText ? externalSetText(text) : composerRuntime?.setText(text), [externalSetText, composerRuntime]);
  const { config } = useConfig();
  const [isListening, _setIsListening] = useState(false);
  const [isActivating, setIsActivating] = useState(false);
  const setIsListening = useCallback((v: boolean) => {
    _setIsListening(v);
    if (v) setIsActivating(false);
    onListeningChange?.(v);
  }, [onListeningChange]);

  // Short audio feedback tones via Web Audio API
  const playTone = useCallback((frequency: number, endFrequency: number, duration = 0.12) => {
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
  }, []);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<DictationSession | null>(null);

  const audioConfig = (config as Record<string, unknown> | null)?.audio as {
    provider?: AudioProvider;
    azure?: { endpoint?: string; region?: string; subscriptionKey?: string; sttLanguage?: string };
    dictation?: { enabled?: boolean; language?: string; continuous?: boolean; inputDeviceId?: string };
  } | undefined;
  const isWebBridge = Boolean((window as unknown as Record<string, unknown>).app && (window.app as Record<string, unknown>).__isWebBridge);
  const audioProvider: AudioProvider = isWebBridge ? 'native' : (audioConfig?.provider ?? 'native');
  const dictationConfig = audioConfig?.dictation;
  const azureConfig = audioConfig?.azure;
  const selectedDeviceId = dictationConfig?.inputDeviceId;

  const handleStop = useCallback(() => {
    if (!isListening && !isActivating) return;
    console.log('[DictationButton] Stopping...');
    sessionRef.current?.stop();
    setIsListening(false);
    setIsActivating(false);
    sessionRef.current = null;
    playTone(480, 320); // falling tone
  }, [isListening, isActivating, setIsListening, playTone]);

  const handleStart = useCallback(() => {
    setError(null);
    if (isListening || isActivating) return;

    setIsActivating(true);

    console.log('[DictationButton] Starting, provider=%s, deviceId=%s', audioProvider, selectedDeviceId ?? 'default');
    if (!isDictationSupportedForProvider(audioProvider, Boolean(azureConfig?.subscriptionKey))) {
      setIsActivating(false);
      setError('Speech recognition is not supported');
      return;
    }

    try {
      const adapter = createUnifiedDictationAdapter({
        provider: audioProvider,
        enabled: true,
        language: dictationConfig?.language ?? 'en-US',
        continuous: dictationConfig?.continuous ?? true,
        azure: audioProvider === 'azure' ? {
          endpoint: azureConfig?.endpoint,
          region: azureConfig?.region ?? 'eastus',
          subscriptionKey: azureConfig?.subscriptionKey ?? '',
          language: azureConfig?.sttLanguage ?? dictationConfig?.language ?? 'en-US',
          continuous: dictationConfig?.continuous ?? true,
          inputDeviceId: selectedDeviceId,
        } : undefined,
      });

      if (!adapter) { setIsActivating(false); setError('Failed to create dictation adapter'); return; }

      const session = adapter.listen();
      sessionRef.current = session;

      let transitioned = false;
      const fallbackTimer = setTimeout(() => {
        if (transitioned || !sessionRef.current) return;
        transitioned = true;
        setIsListening(true);
        playTone(320, 480);
      }, 500);

      session.onSpeechStart(() => {
        if (transitioned) return;
        transitioned = true;
        clearTimeout(fallbackTimer);
        setIsListening(true);
        playTone(320, 480); // rising tone
      });

      let baseText = getTextFn();

      session.onSpeech((result) => {
        const transcript = result.transcript?.trim();
        if (!transcript) return;
        console.log('[DictationButton] onSpeech: "%s" isFinal=%s', transcript, result.isFinal);
        if (result.isFinal) {
          baseText = baseText ? baseText.trimEnd() + ' ' + transcript : transcript;
          setTextFn(baseText);
        } else {
          const preview = baseText ? baseText.trimEnd() + ' ' + transcript : transcript;
          setTextFn(preview);
        }
      });

      const extSession = session as DictationSession & {
        onError?: (cb: (err: string) => void) => void;
      };
      extSession.onError?.((err) => {
        console.error('[DictationButton] onError:', err);
        clearTimeout(fallbackTimer);
        setIsListening(false);
        setIsActivating(false);
        sessionRef.current = null;
        setError(err === 'not-allowed' ? 'Microphone permission denied'
          : err === 'no-speech' ? 'No speech detected — try again'
          : err === 'network' ? 'Network connection required'
          : `Dictation error: ${err}`);
      });
    } catch (err) {
      console.error('[DictationButton] Failed:', err);
      setIsListening(false);
      setIsActivating(false);
      setError('Failed to start dictation');
    }
  }, [isListening, isActivating, audioProvider, dictationConfig, azureConfig, getTextFn, setTextFn, selectedDeviceId, setIsListening, playTone]);

  // Expose start/stop to parent via refs (for keyboard shortcut)
  useEffect(() => {
    if (startRef) (startRef as { current: (() => void) | null }).current = handleStart;
    if (stopRef) (stopRef as { current: (() => void) | null }).current = handleStop;
    return () => {
      if (startRef) (startRef as { current: (() => void) | null }).current = null;
      if (stopRef) (stopRef as { current: (() => void) | null }).current = null;
    };
  }, [startRef, stopRef, handleStart, handleStop]);

  // Poll session status for cleanup
  useEffect(() => {
    if (!isListening || !sessionRef.current) return;
    const session = sessionRef.current;
    const interval = setInterval(() => {
      if (session.status.type === 'ended') {
        setIsListening(false);
        sessionRef.current = null;
        clearInterval(interval);
      }
    }, 200);
    return () => clearInterval(interval);
  }, [isListening]);

  useEffect(() => { return () => { sessionRef.current?.cancel(); }; }, []);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(t);
  }, [error]);

  const isActive = isListening;

  return (
    <div className="relative flex items-center">
      <div className={`flex items-center overflow-hidden rounded-lg border transition-colors ${
        isActive
          ? 'border-primary/50 bg-primary/10'
          : isActivating
            ? 'border-primary/30 bg-primary/5'
            : 'border-border/50 bg-muted/40'
      }`}>
        <Tooltip
          content={
            <span className="flex items-center gap-2">
              Voice dictation
              <kbd className="inline-flex items-center gap-0.5 rounded bg-background/20 px-1.5 py-0.5 text-[10px] font-semibold"><span className="text-[13px] leading-none">&#x2318;</span>D</kbd>
            </span>
          }
          side="top"
          sideOffset={8}
        >
          <button
            type="button"
            onClick={() => {
              if (isListening || isActivating) { handleStop(); } else { handleStart(); }
            }}
            className={`flex h-10 w-10 shrink-0 items-center justify-center transition-colors ${
              isActive
                ? 'bg-primary text-primary-foreground'
                : isActivating
                  ? 'bg-primary/40 text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted/50'
            }`}
          >
            <MicIcon className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>

      {/* Error tooltip */}
      {error && (
        <div className="absolute bottom-full right-0 mb-2 whitespace-nowrap rounded-lg bg-popover border border-border/50 px-2.5 py-1.5 text-[10px] text-muted-foreground shadow-lg z-50">
          {error}
        </div>
      )}
    </div>
  );
};
