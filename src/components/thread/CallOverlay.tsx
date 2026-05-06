import { useState, useEffect, useRef, useCallback, type FC } from 'react';
import { useRealtime } from '@/providers/RealtimeProvider';
import { useConfig } from '@/providers/ConfigProvider';
import { app } from '@/lib/ipc-client';
import { listOutputDevices } from '@/lib/audio/realtime-playback';
import { WebAudioMonitor } from '@/lib/audio/web-audio-monitor';
import { PhoneOffIcon, MicIcon, MicOffIcon, Volume2Icon } from 'lucide-react';
import { formatDuration, LevelBars, StatusDot, DevicePicker } from './overlay-shared';

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
  const webMonitorUnsubRef = useRef<(() => void) | null>(null);

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
      webMonitorUnsubRef.current?.();
      webMonitorUnsubRef.current = null;
      setMonitoredInputLevels({});
      return;
    }

    if (isWebBridge) {
      // Browser: use shared WebAudioMonitor for level monitoring
      const monitor = WebAudioMonitor.getInstance();
      const ids = inputDevices.map((d) => d.deviceId);
      webMonitorUnsubRef.current = monitor.subscribeAll(ids);
      inputLevelTimerRef.current = setInterval(() => {
        setMonitoredInputLevels(monitor.getLevels());
      }, 66);
      return () => {
        if (inputLevelTimerRef.current) { clearInterval(inputLevelTimerRef.current); inputLevelTimerRef.current = null; }
        webMonitorUnsubRef.current?.();
        webMonitorUnsubRef.current = null;
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
      WebAudioMonitor.getInstance().listInputDevices()
        .then(setInputDevices)
        .catch(() => setInputDevices([]));
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
    <div className="relative z-20 mx-auto w-full max-w-3xl px-4 pb-4 pt-4 md:pb-5 md:pt-5">
      <div className="mx-auto w-full">
        <div className="flex flex-col gap-2.5 rounded-2xl border border-border/70 bg-card/78 px-4 py-[18.75px] app-composer-shadow">
          {/* Row 1: Status, audio levels, device selectors, timer */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-1">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <StatusDot status={callState.status} />
                <span className="text-xs font-medium capitalize text-muted-foreground">
                  {callState.status === 'connected' ? 'Connected' : callState.status === 'preparing' ? 'Ringing...' : callState.status === 'connecting' ? 'Connecting...' : callState.status}
                </span>
              </div>
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

          {/* Row 2: Speaking status + Mute + End Call */}
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
