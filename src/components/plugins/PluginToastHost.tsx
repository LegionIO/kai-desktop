import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FC,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import {
  AlertCircleIcon,
  BellIcon,
  CheckCircle2Icon,
  InfoIcon,
  MinusIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { usePlugins, type PluginNavigationTarget } from '@/providers/PluginProvider';

const POSITION_KEY = 'kai.plugin-toast-position';
const EDGE_GAP = 16;
const DRAG_THRESHOLD = 4;
const DEFAULT_POSITION = { right: EDGE_GAP, bottom: EDGE_GAP };
const MOVE_HINT = 'Drag to move notifications. Use arrow keys to move, or Home to reset.';
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
  const [minimized, setMinimized] = useState(false);
  const [dragging, setDragging] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const primaryControlRef = useRef<HTMLButtonElement>(null);
  const focusAfterToggleRef = useRef(false);
  const suppressClickRef = useRef(false);
  const dragRef = useRef<{
    pointerId: number;
    element: HTMLButtonElement;
    x: number;
    y: number;
    position: Position;
  } | null>(null);

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
  }, [hasNotifications, minimized, clampPosition]);

  useLayoutEffect(() => {
    if (!focusAfterToggleRef.current) return;
    primaryControlRef.current?.focus({ preventScroll: true });
    focusAfterToggleRef.current = false;
  }, [minimized]);

  useLayoutEffect(() => {
    // A toast can expire or leave the visible four while its pointer is captured.
    // React cannot deliver capture-loss events from an already removed button.
    if (dragRef.current && !dragRef.current.element.isConnected) {
      dragRef.current = null;
      suppressClickRef.current = false;
      setDragging(false);
    }
  });

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
      suppressClickRef.current = false;
      setDragging(false);
      setMinimized(false);
    }
  }, [hasNotifications]);

  const startDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !event.isPrimary || dragRef.current) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    suppressClickRef.current = false;
    dragRef.current = {
      pointerId: event.pointerId,
      element: event.currentTarget,
      x: event.clientX,
      y: event.clientY,
      position,
    };
  };

  const moveDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    // Preserve normal toast clicks (and bubble expansion) when the pointer only jitters.
    if (!suppressClickRef.current && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    suppressClickRef.current = true;
    setDragging(true);
    setPosition(clampPosition({ right: drag.position.right - dx, bottom: drag.position.bottom - dy }));
  };

  const endDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const moveWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
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
  };

  const dragHandlers = {
    onPointerDown: startDrag,
    onPointerMove: moveDrag,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onLostPointerCapture: endDrag,
    onKeyDown: moveWithKeyboard,
  };

  const toggleMinimized = () => {
    focusAfterToggleRef.current = true;
    setMinimized((current) => !current);
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
      className={`pointer-events-none titlebar-no-drag fixed z-50 flex max-h-[calc(100dvh-2rem)] flex-col ${minimized ? 'w-11' : 'w-[calc(100vw-2rem)] max-w-sm'}`}
      style={position}
      onPointerDownCapture={() => {
        if (!dragRef.current) suppressClickRef.current = false;
      }}
      onClickCapture={(event) => {
        // Pointer capture still generates a click after a drag. Consume it without
        // navigating, dismissing a one-shot notification, or expanding the bubble.
        // Keyboard activation (detail === 0) must remain available after capture loss.
        const suppress = suppressClickRef.current && event.detail > 0;
        suppressClickRef.current = false;
        if (suppress) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {minimized ? (
        <button
          ref={primaryControlRef}
          type="button"
          aria-label={`Expand notifications (${notifications.length})`}
          aria-expanded={false}
          aria-description={MOVE_HINT}
          title={`Show ${notifications.length} notification${notifications.length === 1 ? '' : 's'}. ${MOVE_HINT}`}
          className={`pointer-events-auto relative flex h-11 w-11 shrink-0 touch-none select-none items-center justify-center rounded-full border border-border/70 bg-popover/95 text-foreground shadow-xl backdrop-blur-xl transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${dragging ? 'cursor-grabbing' : 'cursor-grab active:cursor-grabbing'}`}
          {...dragHandlers}
          onClick={toggleMinimized}
        >
          <BellIcon className="h-5 w-5" aria-hidden="true" />
          <span
            aria-hidden="true"
            className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold tabular-nums text-primary-foreground ring-2 ring-popover"
          >
            {notifications.length > 99 ? '99+' : notifications.length}
          </span>
        </button>
      ) : (
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          {notifications
            .slice(-4)
            .reverse()
            .map((notification, index) => {
              const level = notification.level ?? 'info';
              const Icon = levelIcons[level];
              const hasTarget = Boolean(notification.target);
              return (
                <div
                  key={`${notification.pluginName}-${notification.id}`}
                  role="group"
                  aria-label={notification.title}
                  className={`pointer-events-auto flex shrink-0 items-start gap-2 rounded-2xl border px-4 py-3 shadow-2xl backdrop-blur ${levelClasses[level]}`}
                >
                  <button
                    ref={index === 0 ? primaryControlRef : undefined}
                    type="button"
                    aria-label={`${hasTarget ? 'Open' : 'Move'} notification: ${notification.title}`}
                    aria-description={MOVE_HINT}
                    title={MOVE_HINT}
                    className={`flex min-w-0 flex-1 touch-none select-none items-start gap-3 rounded-md text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${dragging ? 'cursor-grabbing' : 'cursor-grab active:cursor-grabbing'}`}
                    {...dragHandlers}
                    onClick={hasTarget ? () => handleClick(notification) : undefined}
                  >
                    <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{notification.title}</span>
                      {notification.body && (
                        <span className="mt-1 block break-words text-xs opacity-90">{notification.body}</span>
                      )}
                      <span className="mt-1 block text-[11px] opacity-70">{notification.pluginName}</span>
                    </span>
                  </button>
                  <div className="-mr-1 -mt-1 flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      aria-label="Reset notification position"
                      title="Reset notification position"
                      className="rounded-md p-1.5 opacity-70 transition-colors hover:bg-current/10 hover:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                      onClick={() => setPosition(DEFAULT_POSITION)}
                    >
                      <RotateCcwIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label="Minimize notifications"
                      title="Minimize notifications"
                      aria-expanded={true}
                      className="rounded-md p-1.5 opacity-70 transition-colors hover:bg-current/10 hover:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                      onClick={toggleMinimized}
                    >
                      <MinusIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
};
