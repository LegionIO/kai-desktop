/**
 * CallButton — Voice call button with split-button microphone settings.
 *
 * Renders as a split-button that expands on hover to reveal a chevron
 * opening the microphone/input-device picker popover.
 *
 * Uses the RealtimeProvider context. Safe to use outside a conversation
 * context — the default RealtimeProvider value provides a noop `startCall`.
 */

import { useState, useCallback, useEffect, useRef, type FC } from 'react';
import { PhoneIcon, MicIcon, ChevronUpIcon } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { useRealtime } from '@/providers/RealtimeProvider';
import { useConfig } from '@/providers/ConfigProvider';
import { usePopoverAlign } from '@/hooks/usePopoverAlign';
import { useSplitButtonHover } from '@/hooks/useSplitButtonHover';
import { WebAudioMonitor } from '@/lib/audio/web-audio-monitor';
import { DeviceRow } from './DeviceRow';
import { app } from '@/lib/ipc-client';
import type { AudioProvider } from '@/lib/audio/speech-adapters';

export const CallButton: FC = () => {
  const { startCall } = useRealtime();
  const { config, updateConfig } = useConfig();

  // ── Device picker state ───────────────────────────────────────────
  const [pickerOpen, setPickerOpen] = useState(false);
  const [devices, setDevices] = useState<Array<{ deviceId: string; label: string }>>([]);
  const [levels, setLevels] = useState<Record<string, number>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const popover = usePopoverAlign();
  const levelTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const webMonitorUnsubRef = useRef<(() => void) | null>(null);

  const audioConfig = (config as Record<string, unknown> | null)?.audio as {
    provider?: AudioProvider;
    recording?: { enabled?: boolean; inputDeviceId?: string };
  } | undefined;
  const isWebBridge = Boolean((window as unknown as Record<string, unknown>).app && (window.app as Record<string, unknown>).__isWebBridge);
  const selectedDeviceId = audioConfig?.recording?.inputDeviceId;

  const { expanded, containerProps } = useSplitButtonHover({ popoverOpen: pickerOpen });

  // ── Voice call handler ────────────────────────────────────────────
  const handleClick = useCallback(async () => {
    try {
      const id = await app.conversations.getActiveId() as string | null;
      if (id) {
        await startCall(id);
      }
    } catch (err) {
      console.error('[CallButton] Failed to start call:', err);
    }
  }, [startCall]);

  // ── Close picker on outside click ─────────────────────────────────
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    window.addEventListener('pointerdown', handler);
    return () => window.removeEventListener('pointerdown', handler);
  }, [pickerOpen]);

  // ── Load devices and start level monitoring when picker opens ─────
  useEffect(() => {
    if (!pickerOpen) {
      if (!isWebBridge) window.app?.mic?.stopMonitor();
      if (levelTimerRef.current) { clearInterval(levelTimerRef.current); levelTimerRef.current = null; }
      webMonitorUnsubRef.current?.();
      webMonitorUnsubRef.current = null;
      setLevels({});
      return;
    }

    if (isWebBridge) {
      // Browser: use shared WebAudioMonitor for level monitoring
      let cancelled = false;
      const monitor = WebAudioMonitor.getInstance();
      (async () => {
        try {
          const inputs = await monitor.listInputDevices();
          if (cancelled) return;
          setDevices(inputs);
          const ids = inputs.map((d) => d.deviceId);
          webMonitorUnsubRef.current = monitor.subscribeAll(ids);
          levelTimerRef.current = setInterval(() => {
            setLevels(monitor.getLevels());
          }, 66);
        } catch {
          setDevices([]);
        }
      })();
      return () => {
        cancelled = true;
        if (levelTimerRef.current) { clearInterval(levelTimerRef.current); levelTimerRef.current = null; }
        webMonitorUnsubRef.current?.();
        webMonitorUnsubRef.current = null;
      };
    }

    const mic = window.app?.mic;
    if (!mic) return;

    mic.listDevices().then((devs) => {
      setDevices(devs);
      const ids = ['default', ...devs.filter(d => d.deviceId !== 'default').map(d => d.deviceId)];
      mic.startMonitor(ids).then(() => {
        levelTimerRef.current = setInterval(() => {
          mic.getLevel().then(setLevels).catch(() => setLevels({}));
        }, 66);
      });
    }).catch(() => setDevices([]));

    return () => {
      if (!isWebBridge) mic.stopMonitor();
      if (levelTimerRef.current) { clearInterval(levelTimerRef.current); levelTimerRef.current = null; }
    };
  }, [pickerOpen, isWebBridge]);

  const selectDevice = useCallback((deviceId: string | undefined) => {
    updateConfig('audio.recording.inputDeviceId', deviceId);
  }, [updateConfig]);

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div ref={rootRef} {...containerProps} className="relative flex items-center">
      {/* Joined button group: chevron + phone */}
      <div className="flex items-center overflow-hidden rounded-lg border transition-colors border-border/50 bg-muted/40">
        {/* Left segment: chevron (expand on hover) */}
        <div className={`overflow-hidden transition-[max-width,opacity] duration-200 ease-out ${
          expanded ? 'max-w-[2.5rem] opacity-100' : 'max-w-0 opacity-0'
        }`}>
          <Tooltip content="Voice settings" side="top" sideOffset={8}>
            <button
              type="button"
              onClick={() => setPickerOpen(!pickerOpen)}
              className="flex h-10 w-10 shrink-0 items-center justify-center transition-colors hover:bg-muted/50 text-muted-foreground"
            >
              <ChevronUpIcon className={`h-3.5 w-3.5 transition-transform ${pickerOpen ? '' : 'rotate-180'}`} />
            </button>
          </Tooltip>
        </div>

        {/* Right segment: phone button */}
        <Tooltip content="Voice call" side="top" sideOffset={8}>
          <button
            type="button"
            onClick={handleClick}
            className="flex h-10 w-10 shrink-0 items-center justify-center transition-colors text-muted-foreground hover:bg-muted/50"
          >
            <PhoneIcon className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>

      {/* Device picker popover */}
      {pickerOpen && (
        <div ref={popover.ref} style={popover.style} className="absolute bottom-full right-0 z-50 mb-2 w-[300px] max-w-[calc(100vw-2rem)] rounded-2xl border border-border/70 bg-popover/95 p-1.5 shadow-[0_16px_40px_rgba(5,4,15,0.28)] backdrop-blur-xl">
          {/* Input device header with level indicator */}
          <div className="flex items-center gap-2 px-3 pt-2 pb-1">
            <MicIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide shrink-0">Input Device</span>
            <div className="flex-1 h-1.5 rounded-full bg-muted/50 overflow-hidden">
              {(() => {
                const pct = Math.min(100, Math.round((levels[selectedDeviceId ?? 'default'] ?? 0) * 500));
                const barColor = pct > 60 ? '#22c55e' : pct > 20 ? '#eab308' : '#6b7280';
                return (
                  <div
                    className="h-full rounded-full transition-all duration-75"
                    style={{ width: `${pct}%`, backgroundColor: barColor }}
                  />
                );
              })()}
            </div>
          </div>

          <div className="max-h-[280px] overflow-y-auto space-y-0.5">
            <DeviceRow
              label="System Default"
              selected={!selectedDeviceId}
              level={levels['default'] ?? 0}
              onClick={() => selectDevice(undefined)}
            />

            {devices.filter(d => d.deviceId !== 'default').map((d) => (
              <DeviceRow
                key={d.deviceId}
                label={d.label}
                selected={selectedDeviceId === d.deviceId}
                level={levels[d.deviceId] ?? 0}
                onClick={() => selectDevice(d.deviceId)}
              />
            ))}

            {devices.length === 0 && (
              <div className="px-3 py-3 text-[10px] text-muted-foreground text-center">
                No input devices found
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
