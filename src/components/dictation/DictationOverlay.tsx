/**
 * DictationOverlay — Floating bubble rendered in the dictation overlay BrowserWindow.
 *
 * Shows recording state, waveform level bars, elapsed time, and a stop button.
 * Expands on click to show device picker and live transcript preview.
 */

import { useState, useEffect, useRef, useCallback, type FC } from 'react';
import { MicIcon, SquareIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { app } from '@/lib/ipc-client';

export const DictationOverlay: FC = () => {
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [dictState, setDictState] = useState<string>('active');
  const [partialText, setPartialText] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [devices, setDevices] = useState<Array<{ deviceId: string; label: string }>>([]);
  const [selectedDevice, setSelectedDevice] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [typingMode, setTypingMode] = useState<string>('idle');
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // The normal app shell paints body with bg-background. In this transparent
  // overlay window that becomes a square backdrop unless we clear it.
  useEffect(() => {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    document.body.style.backgroundColor = 'transparent';
    document.body.style.backgroundImage = 'none';
    document.getElementById('root')?.style.setProperty('background', 'transparent');
  }, []);

  // Subscribe to dictation events
  useEffect(() => {
    const unsubState = app.dictation.onStateChange((state) => {
      setDictState(state.state);
      setElapsed(state.elapsed);
    });
    const unsubLevel = app.dictation.onLevel((lvl) => {
      setLevel(lvl);
    });
    const unsubPartial = app.dictation.onPartial((text) => {
      setPartialText(text);
    });
    const unsubFinal = app.dictation.onFinal(() => {
      setPartialText('');
    });
    const unsubError = app.dictation.onError((msg) => {
      setError(msg);
      setTimeout(() => setError(null), 5000);
    });
    const unsubMode = app.dictation.onTypingMode((mode) => {
      setTypingMode(mode);
    });

    // Fetch initial typing mode (may have been broadcast before we mounted)
    app.dictation.getTypingMode().then((mode) => setTypingMode(mode)).catch(() => {});

    return () => {
      unsubState();
      unsubLevel();
      unsubPartial();
      unsubFinal();
      unsubError();
      unsubMode();
    };
  }, []);

  // Elapsed timer
  useEffect(() => {
    if (dictState === 'active') {
      elapsedRef.current = setInterval(() => {
        setElapsed((prev) => prev + 1);
      }, 1000);
    } else {
      if (elapsedRef.current) clearInterval(elapsedRef.current);
    }
    return () => {
      if (elapsedRef.current) clearInterval(elapsedRef.current);
    };
  }, [dictState]);

  // Load devices when expanded
  useEffect(() => {
    if (expanded) {
      app.mic.listDevices().then(setDevices).catch(() => {});
    }
  }, [expanded]);

  const handleStop = useCallback(() => {
    void app.dictation.stop();
  }, []);

  const handleDeviceSelect = useCallback((deviceId: string) => {
    setSelectedDevice(deviceId);
    void app.dictation.setDevice(deviceId);
  }, []);

  const formatTime = (secs: number): string => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const handleExpand = useCallback((next: boolean) => {
    setExpanded(next);
    // Resize overlay window to fit expanded content
    app.dictation.resizeOverlay(next ? 280 : 52);
  }, []);

  // Mouse enter/leave toggles click-through on the overlay window
  const handleMouseEnter = useCallback(() => {
    app.dictation.setOverlayInteractive(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    app.dictation.setOverlayInteractive(false);
  }, []);

  const handleClickCapture = useCallback(() => {
    setTimeout(() => app.dictation.restoreOverlayFocus(), 0);
  }, []);

  return (
    <div
      className="h-screen w-screen select-none"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClickCapture={handleClickCapture}
    >
      <div
        className="flex flex-col rounded-2xl border border-white/10 bg-black/80 backdrop-blur-xl shadow-2xl overflow-hidden"
      >
        {/* Main bar */}
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          {/* Recording dot */}
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
          </span>

          {/* Typing mode indicator */}
          {typingMode !== 'idle' && (
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
              typingMode === 'ax'
                ? 'bg-emerald-500/20 text-emerald-300'
                : 'bg-amber-500/20 text-amber-300'
            }`}>
              {typingMode === 'ax' ? 'AX' : 'KB'}
            </span>
          )}

          {/* Level bars */}
          <LevelBars level={level} />

          {/* Elapsed time */}
          <span className="text-[11px] font-mono text-white/70 tabular-nums min-w-[32px]">
            {formatTime(elapsed)}
          </span>

          {/* Expand/collapse */}
          <button
            type="button"
            onClick={() => handleExpand(!expanded)}
            className="ml-auto rounded-lg p-1 text-white/60 hover:text-white hover:bg-white/10 transition-colors"
          >
            {expanded ? (
              <ChevronUpIcon className="h-3.5 w-3.5" />
            ) : (
              <ChevronDownIcon className="h-3.5 w-3.5" />
            )}
          </button>

          {/* Stop button */}
          <button
            type="button"
            onClick={handleStop}
            className="flex items-center gap-1.5 rounded-lg bg-red-500/20 px-2 py-1 text-[10px] font-medium text-red-300 hover:bg-red-500/30 transition-colors"
          >
            <SquareIcon className="h-2.5 w-2.5 fill-current" />
            Stop
          </button>
        </div>

        {/* Error message */}
        {error && (
          <div className="px-3 py-1.5 text-[10px] text-red-300 bg-red-500/10 border-t border-white/5">
            {error}
          </div>
        )}

        {/* Expanded section */}
        {expanded && (
          <div className="border-t border-white/10">
            {/* Device picker */}
            <div className="px-3 py-2 space-y-1">
              <div className="text-[10px] font-medium text-white/50 uppercase tracking-wider">
                Input Device
              </div>
              <div className="space-y-0.5 max-h-[120px] overflow-y-auto">
                {devices.map((device) => (
                  <button
                    key={device.deviceId}
                    type="button"
                    onClick={() => handleDeviceSelect(device.deviceId)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[11px] transition-colors ${
                      selectedDevice === device.deviceId
                        ? 'bg-white/15 text-white font-medium'
                        : 'text-white/70 hover:bg-white/10'
                    }`}
                  >
                    <MicIcon className="h-3 w-3 shrink-0" />
                    <span className="truncate flex-1 text-left">{device.label || 'Unknown'}</span>
                  </button>
                ))}
                {devices.length === 0 && (
                  <div className="text-[10px] text-white/40 py-2 text-center">
                    No devices found
                  </div>
                )}
              </div>
            </div>

            {/* Partial transcript preview */}
            {partialText && (
              <div className="px-3 py-2 border-t border-white/5">
                <p className="text-[11px] text-white/60 italic leading-relaxed max-h-[80px] overflow-y-auto break-words">
                  &ldquo;{partialText}&rdquo;
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

/* ── Inline LevelBars (self-contained, no import needed for overlay) ── */

function LevelBars({ level, count = 5 }: { level: number; count?: number }) {
  const filled = Math.round(level * count);
  return (
    <div className="flex items-end gap-[2px]">
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="w-[3px] rounded-full transition-all duration-75"
          style={{
            height: `${6 + i * 2}px`,
            backgroundColor: i < filled ? '#22c55e' : 'rgba(255,255,255,0.15)',
          }}
        />
      ))}
    </div>
  );
}
