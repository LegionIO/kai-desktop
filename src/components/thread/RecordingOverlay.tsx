/**
 * RecordingOverlay — Full-width recording overlay that replaces the
 * composer while the user is voice-recording a message.
 *
 * Mirrors the visual structure of CallOverlay:
 *   Row 1: Status dot + "Recording" label + input level bars + elapsed timer
 *   Row 2: Input device selector
 *   Row 3: Cancel button + Send button
 */

import { useState, useEffect, useRef, useCallback, type FC } from 'react';
import { useConfig } from '@/providers/ConfigProvider';
import { app } from '@/lib/ipc-client';
import { WebAudioMonitor } from '@/lib/audio/web-audio-monitor';
import { MicIcon, XIcon, SendHorizontalIcon } from 'lucide-react';
import { formatDuration, LevelBars, StatusDot, DevicePicker } from './overlay-shared';

export interface RecordingOverlayProps {
  elapsedSec: number;
  inputLevel: number;
  onCancel: () => void;
  onSend: () => void;
}

export const RecordingOverlay: FC<RecordingOverlayProps> = ({
  elapsedSec,
  inputLevel,
  onCancel,
  onSend,
}) => {
  const { config, updateConfig } = useConfig();
  const isWebBridge = Boolean(
    (window as unknown as Record<string, unknown>).app &&
    (window.app as Record<string, unknown>).__isWebBridge,
  );

  const [inputDevices, setInputDevices] = useState<Array<{ deviceId: string; label: string }>>([]);
  const audioConfig = (config as Record<string, unknown> | null)?.audio as {
    recording?: { inputDeviceId?: string };
  } | undefined;
  const selectedInputDeviceId = audioConfig?.recording?.inputDeviceId;

  const [inputPickerOpen, setInputPickerOpen] = useState(false);
  const [monitoredInputLevels, setMonitoredInputLevels] = useState<Record<string, number>>({});
  const inputLevelTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const webMonitorUnsubRef = useRef<(() => void) | null>(null);

  // When the input picker is open, monitor all input devices for per-device levels.
  // When closed, use the single active-device level from the hook.
  const inputLevels = inputPickerOpen
    ? monitoredInputLevels
    : { [selectedInputDeviceId ?? 'default']: inputLevel };

  useEffect(() => {
    if (!inputPickerOpen) {
      if (!isWebBridge) app.mic?.stopMonitor?.();
      if (inputLevelTimerRef.current) { clearInterval(inputLevelTimerRef.current); inputLevelTimerRef.current = null; }
      webMonitorUnsubRef.current?.();
      webMonitorUnsubRef.current = null;
      setMonitoredInputLevels({});
      return;
    }

    if (isWebBridge) {
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
  }, [isWebBridge]);

  const handleSelectInput = useCallback(
    (deviceId: string | undefined) => updateConfig('audio.recording.inputDeviceId', deviceId),
    [updateConfig],
  );

  return (
    <div className="relative z-20 mx-auto w-full max-w-3xl px-4 pb-4 pt-4 md:pb-5 md:pt-5">
      <div className="mx-auto w-full">
        <div className="flex flex-col gap-2.5 rounded-2xl border border-border/70 bg-card/78 px-4 py-[18.75px] app-composer-shadow">
          {/* Row 1: Status + device selector + level + timer */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-1">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <StatusDot status="recording" />
                <span className="text-xs font-medium text-red-500">
                  Recording
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
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-1.5" title="Input level">
                <MicIcon className="h-3 w-3 text-muted-foreground" />
                <LevelBars level={inputLevel} color="#ef4444" />
              </div>
              <span className="tabular-nums text-xs font-medium text-muted-foreground">
                {formatDuration(elapsedSec)}
              </span>
            </div>
          </div>

          {/* Row 2: Cancel + Send */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-1">
            <span className="text-xs font-medium text-muted-foreground animate-pulse">
              Listening...
            </span>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onCancel}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-muted/60 text-muted-foreground transition-colors hover:bg-muted"
                title="Cancel recording"
              >
                <XIcon className="h-4 w-4" />
              </button>

              <button
                type="button"
                onClick={onSend}
                className="flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-primary-foreground transition-colors hover:bg-primary/90"
                title="Send message"
              >
                <SendHorizontalIcon className="h-4 w-4" />
                <span className="text-xs font-medium">Send</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
