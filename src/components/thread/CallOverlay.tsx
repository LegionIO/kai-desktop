import { useState, useEffect, useRef, useCallback, type FC } from 'react';
import { useRealtime } from '@/providers/RealtimeProvider';
import { useConfig } from '@/providers/ConfigProvider';
import { DeviceRow } from './DeviceRow';
import { app } from '@/lib/ipc-client';
import { listOutputDevices } from '@/lib/audio/realtime-playback';
import { PhoneOffIcon, MicIcon, MicOffIcon, Volume2Icon, ChevronUpIcon } from 'lucide-react';

/* ── Helpers ── */

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

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
            backgroundColor: i < filled ? '#22c55e' : 'rgba(128,128,128,0.25)',
          }}
        />
      ))}
    </div>
  );
}

/* ── Status Dot ── */

function StatusDot({ status }: { status: string }) {
  if (status === 'connected') {
    return (
      <span className="relative flex h-2.5 w-2.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
      </span>
    );
  }
  if (status === 'preparing') {
    return (
      <span className="relative flex h-2.5 w-2.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
      </span>
    );
  }
  if (status === 'connecting') {
    return (
      <span className="relative flex h-2.5 w-2.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-yellow-400 opacity-75" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-yellow-500" />
      </span>
    );
  }
  return <span className="inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />;
}

/* ── Device Picker Popover ── */

function DevicePicker({
  label,
  icon,
  devices,
  selectedDeviceId,
  levels,
  onSelect,
  onOpenChange,
}: {
  label: string;
  icon: React.ReactNode;
  devices: Array<{ deviceId: string; label: string }>;
  selectedDeviceId: string | undefined;
  levels: Record<string, number>;
  onSelect: (deviceId: string | undefined) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const toggleOpen = useCallback((next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  }, [onOpenChange]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) toggleOpen(false);
    };
    window.addEventListener('pointerdown', handler);
    return () => window.removeEventListener('pointerdown', handler);
  }, [open, toggleOpen]);

  const selectedLabel =
    (!selectedDeviceId
      ? 'System Default'
      : devices.find((d) => d.deviceId === selectedDeviceId)?.label) ?? 'System Default';

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => toggleOpen(!open)}
        className="flex items-center gap-1.5 rounded-xl border border-border/70 bg-card/70 px-2.5 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/50"
      >
        {icon}
        <span className="max-w-[120px] truncate">{selectedLabel}</span>
        <ChevronUpIcon className="h-2.5 w-2.5" />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 w-[300px] rounded-2xl border border-border/70 bg-popover/95 p-1.5 shadow-[0_16px_40px_rgba(5,4,15,0.28)] backdrop-blur-xl">
          <div className="px-3 py-2 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
            {label}
          </div>
          <div className="max-h-[280px] overflow-y-auto space-y-0.5">
            <DeviceRow
              label="System Default"
              selected={!selectedDeviceId}
              level={levels['default'] ?? 0}
              onClick={() => { onSelect(undefined); toggleOpen(false); }}
            />
            {devices.filter((d) => d.deviceId !== 'default').map((d) => (
              <DeviceRow
                key={d.deviceId}
                label={d.label}
                selected={selectedDeviceId === d.deviceId}
                level={levels[d.deviceId] ?? 0}
                onClick={() => { onSelect(d.deviceId); toggleOpen(false); }}
              />
            ))}
            {devices.length === 0 && (
              <div className="px-3 py-3 text-[10px] text-muted-foreground text-center">
                No devices found
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── CallOverlay ── */

export const CallOverlay: FC = () => {
  const { callState, endCall, toggleMute, isMuted, inputLevel, outputLevel } = useRealtime();
  const { config, updateConfig } = useConfig();
  const isWebBridge = Boolean((window as unknown as Record<string, unknown>).app && (window.app as Record<string, unknown>).__isWebBridge);

  const [inputDevices, setInputDevices] = useState<Array<{ deviceId: string; label: string }>>([]);
  const [outputDevices, setOutputDevices] = useState<Array<{ deviceId: string; label: string }>>([]);

  const realtimeConfig = (config as Record<string, unknown> | null)?.realtime as {
    inputDeviceId?: string;
    outputDeviceId?: string;
  } | undefined;

  const selectedInputDeviceId = realtimeConfig?.inputDeviceId;
  const selectedOutputDeviceId = realtimeConfig?.outputDeviceId;
  const [inputPickerOpen, setInputPickerOpen] = useState(false);
  const [monitoredInputLevels, setMonitoredInputLevels] = useState<Record<string, number>>({});
  const inputLevelTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const webInputMonitorRef = useRef<Array<{ stream: MediaStream; audioContext: AudioContext; analyser: AnalyserNode; data: Uint8Array<ArrayBuffer> }>>([]);

  // When the input picker is open, monitor all input devices for per-device levels.
  // When closed, fall back to the single active-device level from RealtimeProvider.
  const inputLevels = inputPickerOpen
    ? monitoredInputLevels
    : { [selectedInputDeviceId ?? 'default']: inputLevel };
  const outputLevels = { [selectedOutputDeviceId ?? 'default']: outputLevel };

  useEffect(() => {
    if (!inputPickerOpen) {
      // Cleanup
      if (!isWebBridge) app.mic?.stopMonitor?.();
      if (inputLevelTimerRef.current) { clearInterval(inputLevelTimerRef.current); inputLevelTimerRef.current = null; }
      for (const item of webInputMonitorRef.current) {
        try { item.audioContext.close(); } catch { /* ignore */ }
        item.stream.getTracks().forEach(t => t.stop());
      }
      webInputMonitorRef.current = [];
      setMonitoredInputLevels({});
      return;
    }

    if (isWebBridge) {
      // Browser: open a stream per device and monitor via Web Audio API
      let cancelled = false;
      (async () => {
        try {
          const monitors: typeof webInputMonitorRef.current = [];
          for (const device of inputDevices) {
            try {
              const stream = await navigator.mediaDevices.getUserMedia({
                audio: { deviceId: { exact: device.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
              });
              if (cancelled) { stream.getTracks().forEach(t => t.stop()); break; }
              const audioContext = new AudioContext();
              const source = audioContext.createMediaStreamSource(stream);
              const analyser = audioContext.createAnalyser();
              analyser.fftSize = 2048;
              source.connect(analyser);
              monitors.push({ stream, audioContext, analyser, data: new Uint8Array(analyser.fftSize) as Uint8Array<ArrayBuffer> });
            } catch { /* device open failed, skip */ }
          }
          if (cancelled) {
            for (const m of monitors) { try { m.audioContext.close(); } catch { /* ignore */ } m.stream.getTracks().forEach(t => t.stop()); }
            return;
          }
          webInputMonitorRef.current = monitors;

          const deviceIdToMonitor = new Map<string, typeof monitors[number]>();
          inputDevices.forEach((d, i) => { if (monitors[i]) deviceIdToMonitor.set(d.deviceId, monitors[i]); });

          inputLevelTimerRef.current = setInterval(() => {
            const lvls: Record<string, number> = {};
            for (const [id, mon] of deviceIdToMonitor) {
              mon.analyser.getByteTimeDomainData(mon.data);
              let sum = 0;
              for (let j = 0; j < mon.data.length; j++) {
                const v = (mon.data[j] - 128) / 128;
                sum += v * v;
              }
              lvls[id] = Math.sqrt(sum / mon.data.length);
            }
            if (inputDevices.length > 0 && lvls[inputDevices[0].deviceId] !== undefined) {
              lvls['default'] = lvls[inputDevices[0].deviceId];
            }
            setMonitoredInputLevels(lvls);
          }, 66);
        } catch { /* ignore */ }
      })();
      return () => {
        cancelled = true;
        if (inputLevelTimerRef.current) { clearInterval(inputLevelTimerRef.current); inputLevelTimerRef.current = null; }
        for (const item of webInputMonitorRef.current) {
          try { item.audioContext.close(); } catch { /* ignore */ }
          item.stream.getTracks().forEach(t => t.stop());
        }
        webInputMonitorRef.current = [];
      };
    } else {
      // Desktop: use IPC mic monitor for all devices
      const mic = app.mic;
      if (!mic) return;
      const ids = ['default', ...inputDevices.filter(d => d.deviceId !== 'default').map(d => d.deviceId)];
      mic.startMonitor(ids).then(() => {
        inputLevelTimerRef.current = setInterval(() => {
          mic.getLevel().then(setMonitoredInputLevels).catch(() => setMonitoredInputLevels({}));
        }, 66);
      });
      return () => {
        mic.stopMonitor();
        if (inputLevelTimerRef.current) { clearInterval(inputLevelTimerRef.current); inputLevelTimerRef.current = null; }
      };
    }
  }, [inputPickerOpen, isWebBridge, inputDevices]);

  // Load devices on mount
  useEffect(() => {
    if (isWebBridge) {
      // Browser: enumerate via native API
      (async () => {
        try {
          const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          tempStream.getTracks().forEach(t => t.stop());
          const allDevices = await navigator.mediaDevices.enumerateDevices();
          setInputDevices(
            allDevices
              .filter((d) => d.kind === 'audioinput')
              .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Microphone' })),
          );
        } catch {
          setInputDevices([]);
        }
      })();
    } else {
      app.mic?.listDevices?.().then(setInputDevices).catch(() => setInputDevices([]));
    }
    listOutputDevices().then(setOutputDevices).catch(() => setOutputDevices([]));
  }, [isWebBridge]);

  const handleSelectInput = useCallback(
    (deviceId: string | undefined) => updateConfig('realtime.inputDeviceId', deviceId),
    [updateConfig],
  );

  const handleSelectOutput = useCallback(
    (deviceId: string | undefined) => updateConfig('realtime.outputDeviceId', deviceId),
    [updateConfig],
  );

  // Speaking / listening status text
  const statusText = callState.isSpeaking
    ? 'Speaking...'
    : callState.isResponding
      ? 'AI responding...'
      : callState.isProcessing
        ? 'Processing...'
        : 'Listening...';

  const statusPulse = callState.isSpeaking || callState.isResponding || callState.isProcessing;

  return (
    <div className="relative z-20 border-t border-border/70 bg-background/88 px-3 pb-3 pt-3 backdrop-blur-md md:px-6 md:pb-6 md:pt-4">
      <div className="mx-auto w-full max-w-5xl">
        <div className="flex flex-col gap-3 rounded-[1.7rem] border border-border/70 bg-card/78 px-4 py-4 app-composer-shadow">
          {/* Row 1: Status, audio levels, timer */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-1">
            <div className="flex items-center gap-2.5">
              <StatusDot status={callState.status} />
              <span className="text-xs font-medium capitalize text-muted-foreground">
                {callState.status === 'connected' ? 'Connected' : callState.status === 'preparing' ? 'Ringing...' : callState.status === 'connecting' ? 'Connecting...' : callState.status}
              </span>
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-1.5" title="Input level">
                <MicIcon className="h-3 w-3 text-muted-foreground" />
                <LevelBars level={inputLevel} />
              </div>
              <div className="flex items-center gap-1.5" title="Output level">
                <Volume2Icon className="h-3 w-3 text-muted-foreground" />
                <LevelBars level={outputLevel} />
              </div>
              <span className="tabular-nums text-xs font-medium text-muted-foreground">
                {formatDuration(callState.duration)}
              </span>
            </div>
          </div>

          {/* Row 2: Device selectors */}
          <div className="flex items-center gap-2 px-1">
            <DevicePicker
              label="Input Device"
              icon={<MicIcon className="h-3 w-3" />}
              devices={inputDevices}
              selectedDeviceId={selectedInputDeviceId}
              levels={inputLevels}
              onSelect={handleSelectInput}
              onOpenChange={setInputPickerOpen}
            />
            <DevicePicker
              label="Output Device"
              icon={<Volume2Icon className="h-3 w-3" />}
              devices={outputDevices}
              selectedDeviceId={selectedOutputDeviceId}
              levels={outputLevels}
              onSelect={handleSelectOutput}
            />
          </div>

          {/* Row 3: Speaking status + End Call */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-1">
            <div className="flex items-center gap-2 min-w-0">
              <span
                key={statusText}
                className={`text-xs font-medium whitespace-nowrap ${statusPulse ? 'animate-pulse' : ''} ${
                  callState.isSpeaking
                    ? 'text-emerald-500'
                    : callState.isResponding
                      ? 'text-primary'
                      : callState.isProcessing
                        ? 'text-amber-500'
                        : 'text-muted-foreground'
                }`}
              >
                {statusText}
              </span>
              {callState.silenceCountdown != null && (
                <span className="text-xs font-medium text-amber-500">
                  Ending in {callState.silenceCountdown}s...
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={toggleMute}
                className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
                  isMuted
                    ? 'bg-amber-600 text-white hover:bg-amber-700'
                    : 'bg-muted/60 text-muted-foreground hover:bg-muted'
                }`}
                title={isMuted ? 'Unmute microphone' : 'Mute microphone'}
              >
                {isMuted ? <MicOffIcon className="h-4 w-4" /> : <MicIcon className="h-4 w-4" />}
              </button>

              <button
                type="button"
                onClick={() => void endCall()}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-red-600 text-white transition-colors hover:bg-red-700"
                title="End call"
              >
                <PhoneOffIcon className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Error display */}
          {callState.error && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {callState.error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
