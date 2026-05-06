/**
 * overlay-shared — Shared helpers for CallOverlay and RecordingOverlay.
 *
 * Contains the visual primitives (StatusDot, LevelBars, DevicePicker)
 * and helpers (formatDuration) used by both overlays.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { DeviceRow } from './DeviceRow';
import { ChevronUpIcon } from 'lucide-react';

/* ── Helpers ── */

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

/* ── Level Bars ── */

export function LevelBars({
  level,
  count = 5,
  color = '#22c55e',
}: {
  level: number;
  count?: number;
  color?: string;
}) {
  const filled = Math.round(level * count);
  return (
    <div className="flex items-end gap-[2px]">
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="w-[3px] rounded-full transition-all duration-75"
          style={{
            height: `${6 + i * 2}px`,
            backgroundColor: i < filled ? color : 'rgba(128,128,128,0.25)',
          }}
        />
      ))}
    </div>
  );
}

/* ── Status Dot ── */

export type StatusDotVariant = 'connected' | 'preparing' | 'connecting' | 'recording' | 'error';

const DOT_COLORS: Record<StatusDotVariant, { ping: string; dot: string }> = {
  connected:  { ping: 'bg-emerald-400', dot: 'bg-emerald-500' },
  preparing:  { ping: 'bg-primary',     dot: 'bg-primary' },
  connecting: { ping: 'bg-yellow-400',  dot: 'bg-yellow-500' },
  recording:  { ping: 'bg-red-400',     dot: 'bg-red-500' },
  error:      { ping: '',               dot: 'bg-red-500' },
};

export function StatusDot({ status }: { status: StatusDotVariant | string }) {
  const variant = DOT_COLORS[status as StatusDotVariant];
  if (!variant || status === 'error') {
    return <span className="inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />;
  }
  return (
    <span className="relative flex h-2.5 w-2.5">
      <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${variant.ping} opacity-75`} />
      <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${variant.dot}`} />
    </span>
  );
}

/* ── Device Picker Popover ── */

export function DevicePicker({
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
