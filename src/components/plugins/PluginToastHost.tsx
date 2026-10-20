import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FC, type PointerEvent } from 'react';
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  GripHorizontalIcon,
  InfoIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { usePlugins, type PluginNavigationTarget } from '@/providers/PluginProvider';

const POSITION_KEY = 'kai.plugin-toast-position';
const EDGE_GAP = 16;
const DEFAULT_POSITION = { right: EDGE_GAP, bottom: EDGE_GAP };
type Position = typeof DEFAULT_POSITION;

function readPosition(): Position {
  try {
    const saved = JSON.parse(window.localStorage.getItem(POSITION_KEY) ?? 'null');
    if (saved && Number.isFinite(saved.right) && Number.isFinite(saved.bottom)) {
      return { right: saved.right, bottom: saved.bottom };
    }
  } catch {
    // Storage may be unavailable, or contain an older/invalid value.
  }
  return DEFAULT_POSITION;
}

const levelClasses = {
  info: 'border-blue-500/20 bg-blue-500/10 text-blue-800 dark:text-blue-300',
  success: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300',
  warning: 'border-amber-500/20 bg-amber-500/10 text-amber-800 dark:text-amber-300',
  error: 'border-red-500/20 bg-red-500/10 text-red-800 dark:text-red-300',
} as const;

const levelIcons = {
  info: InfoIcon,
  success: CheckCircle2Icon,
  warning: TriangleAlertIcon,
  error: AlertCircleIcon,
} as const;

export const PluginToastHost: FC = () => {
  const { uiState, injectNavigationRequest } = usePlugins();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [position, setPosition] = useState(readPosition);
  const [dragging, setDragging] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; position: Position } | null>(null);

  const notifications =
    uiState?.notifications?.filter((n) => {
      if (!n.visible) return false;
      const key = `${n.pluginName}:${n.id}`;
      return !dismissed.has(key);
    }) ?? [];
  const hasNotifications = notifications.length > 0;

  const clampPosition = useCallback((next: Position): Position => {
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect) return next;
    return {
      right: Math.max(EDGE_GAP, Math.min(next.right, window.innerWidth - rect.width - EDGE_GAP)),
      bottom: Math.max(EDGE_GAP, Math.min(next.bottom, window.innerHeight - rect.height - EDGE_GAP)),
    };
  }, []);

  // Re-clamp when the window or the stack changes size, including new progress text.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const keepInView = () =>
      setPosition((current) => {
        const next = clampPosition(current);
        return next.right === current.right && next.bottom === current.bottom ? current : next;
      });
    keepInView();
    const observer = new ResizeObserver(keepInView);
    observer.observe(host);
    window.addEventListener('resize', keepInView);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', keepInView);
    };
  }, [hasNotifications, clampPosition]);

  useEffect(() => {
    if (dragging) return;
    try {
      window.localStorage.setItem(POSITION_KEY, JSON.stringify(position));
    } catch {
      // Moving notifications should still work without persistent storage.
    }
  }, [position, dragging]);

  useEffect(() => {
    if (!hasNotifications) {
      dragRef.current = null;
      setDragging(false);
    }
  }, [hasNotifications]);

  const endDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  if (notifications.length === 0) return null;

  const handleClick = (notification: (typeof notifications)[0]) => {
    // Only dismiss on click if the notification has autoDismiss (i.e. it's a one-shot notification).
    // Persistent progress notifications (no autoDismissMs) stay visible — clicking just navigates.
    if (notification.autoDismissMs) {
      const key = `${notification.pluginName}:${notification.id}`;
      setDismissed((prev) => new Set(prev).add(key));
    }
    if (!notification.target) return;
    injectNavigationRequest(notification.pluginName, notification.target as PluginNavigationTarget);
  };

  return (
    <div
      ref={hostRef}
      role="region"
      aria-label="Plugin notifications"
      className="pointer-events-none fixed z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-sm flex-col gap-2"
      style={position}
    >
      <div className="flex shrink-0 justify-end">
        <div className="pointer-events-auto titlebar-no-drag flex items-center rounded-lg border border-border/60 bg-popover/95 p-0.5 text-muted-foreground shadow-sm">
          <button
            type="button"
            aria-label="Move notifications"
            title="Drag to move notifications. Use arrow keys to move, or Home to reset."
            className={`flex touch-none select-none items-center gap-1.5 rounded-md px-2 py-1 text-[11px] hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
            onPointerDown={(event) => {
              if (event.button !== 0 || !event.isPrimary || dragRef.current) return;
              event.preventDefault();
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, position };
              setDragging(true);
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              setPosition(
                clampPosition({
                  right: drag.position.right - (event.clientX - drag.x),
                  bottom: drag.position.bottom - (event.clientY - drag.y),
                }),
              );
            }}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 40 : 10;
              const movement: Record<string, Position> = {
                ArrowLeft: { right: step, bottom: 0 },
                ArrowRight: { right: -step, bottom: 0 },
                ArrowUp: { right: 0, bottom: step },
                ArrowDown: { right: 0, bottom: -step },
              };
              if (event.key === 'Home') {
                event.preventDefault();
                setPosition(DEFAULT_POSITION);
              } else if (movement[event.key]) {
                event.preventDefault();
                const delta = movement[event.key];
                setPosition((current) =>
                  clampPosition({ right: current.right + delta.right, bottom: current.bottom + delta.bottom }),
                );
              }
            }}
          >
            <GripHorizontalIcon className="h-3.5 w-3.5" aria-hidden="true" />
            Move
          </button>
          <button
            type="button"
            aria-label="Reset notification position"
            title="Reset notification position"
            className="rounded-md p-1.5 hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => setPosition(DEFAULT_POSITION)}
          >
            <RotateCcwIcon className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
        {notifications
          .slice(-4)
          .reverse()
          .map((notification) => {
            const level = notification.level ?? 'info';
            const Icon = levelIcons[level];
            const hasTarget = Boolean(notification.target);
            return (
              <div
                key={`${notification.pluginName}-${notification.id}`}
                className={`pointer-events-auto shrink-0 rounded-2xl border px-4 py-3 shadow-2xl backdrop-blur ${levelClasses[level]} ${hasTarget ? 'cursor-pointer hover:brightness-95 transition-all' : ''}`}
                onClick={hasTarget ? () => handleClick(notification) : undefined}
              >
                <div className="flex items-start gap-3">
                  <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{notification.title}</div>
                    {notification.body && <p className="mt-1 break-words text-xs opacity-90">{notification.body}</p>}
                    <p className="mt-1 text-[11px] opacity-70">{notification.pluginName}</p>
                  </div>
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
};
