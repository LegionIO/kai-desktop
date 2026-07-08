import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type FC,
  type PropsWithChildren,
  type ReactNode,
} from 'react';
import { ChevronsLeftIcon, ChevronsRightIcon, XIcon, type LucideIcon } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/utils';

/* ────────────────────────────────────────────────────────────────────────── */
/*  Public tab contract                                                       */
/*  A parallel worktree will register a "Changes" diff tab via this shape.    */
/* ────────────────────────────────────────────────────────────────────────── */

export type SidePanelTab = {
  /** Stable id — also the value passed to `openPanel(id)`. */
  id: string;
  /** Tab label shown in the tab bar. */
  label: string;
  /** Optional Lucide icon rendered before the label. */
  icon?: LucideIcon;
  /** Optional badge (count / short string) rendered after the label. */
  badge?: string | number;
  /** Tab body. Rendered only while the tab is active and the panel is open. */
  render: () => ReactNode;
};

export type SidePanelState = 'closed' | 'minimized' | 'open';

type SidePanelContextValue = {
  state: SidePanelState;
  activeTabId: string | null;
  /** Open the panel. If `tabId` is provided it becomes the active tab. */
  openPanel: (tabId?: string) => void;
  closePanel: () => void;
  minimizePanel: () => void;
  setActiveTab: (tabId: string) => void;
};

const SidePanelContext = createContext<SidePanelContextValue | null>(null);

export function useSidePanel(): SidePanelContextValue {
  const ctx = useContext(SidePanelContext);
  if (!ctx) throw new Error('useSidePanel must be used within a <SidePanelProvider>');
  return ctx;
}

export function useSidePanelOptional(): SidePanelContextValue | null {
  return useContext(SidePanelContext);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Provider — owns open/minimized/closed + active tab                        */
/* ────────────────────────────────────────────────────────────────────────── */

export const SidePanelProvider: FC<PropsWithChildren> = ({ children }) => {
  const [state, setState] = useState<SidePanelState>('minimized');
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const openPanel = useCallback((tabId?: string) => {
    if (tabId) setActiveTabId(tabId);
    setState('open');
  }, []);

  const closePanel = useCallback(() => setState('closed'), []);
  const minimizePanel = useCallback(() => setState('minimized'), []);
  const setActiveTab = useCallback((tabId: string) => setActiveTabId(tabId), []);

  const value = useMemo<SidePanelContextValue>(
    () => ({ state, activeTabId, openPanel, closePanel, minimizePanel, setActiveTab }),
    [state, activeTabId, openPanel, closePanel, minimizePanel, setActiveTab],
  );

  return <SidePanelContext.Provider value={value}>{children}</SidePanelContext.Provider>;
};

/* ────────────────────────────────────────────────────────────────────────── */
/*  Host — resizable right column with tab bar                                */
/* ────────────────────────────────────────────────────────────────────────── */

const MIN_PCT = 20;
const MAX_PCT = 80;
const DEFAULT_PCT = 45;

export const SidePanelHost: FC<{ tabs: SidePanelTab[] }> = ({ tabs }) => {
  const { state, activeTabId, openPanel, minimizePanel, setActiveTab } = useSidePanel();
  const [widthPct, setWidthPct] = useState(DEFAULT_PCT);
  const dragRef = useRef<{ startX: number; startPct: number; parentWidth: number } | null>(null);

  const effectiveTabId = activeTabId && tabs.some((t) => t.id === activeTabId) ? activeTabId : (tabs[0]?.id ?? null);
  const activeTab = tabs.find((t) => t.id === effectiveTabId) ?? null;

  const handleDragStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const parent = event.currentTarget.parentElement?.parentElement;
      const parentWidth = parent?.getBoundingClientRect().width ?? window.innerWidth;
      dragRef.current = { startX: event.clientX, startPct: widthPct, parentWidth };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [widthPct],
  );

  const handleDragMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const deltaPx = drag.startX - event.clientX; // dragging left grows the panel
    const deltaPct = (deltaPx / drag.parentWidth) * 100;
    const next = Math.min(MAX_PCT, Math.max(MIN_PCT, drag.startPct + deltaPct));
    setWidthPct(next);
  }, []);

  const handleDragEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  if (state === 'closed' || tabs.length === 0) return null;

  if (state === 'minimized') {
    return (
      <div className="flex w-9 shrink-0 flex-col items-center gap-2 border-l border-border/60 bg-card/40 py-3">
        <Tooltip content="Expand panel" side="left">
          <button
            type="button"
            onClick={() => openPanel()}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronsLeftIcon className="h-4 w-4" />
          </button>
        </Tooltip>
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <Tooltip key={tab.id} content={tab.label} side="left">
              <button
                type="button"
                onClick={() => openPanel(tab.id)}
                className={cn(
                  'relative flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                  tab.id === effectiveTabId && 'bg-accent/60 text-foreground',
                )}
              >
                {Icon ? (
                  <Icon className="h-4 w-4" />
                ) : (
                  <span className="text-[10px] font-semibold">{tab.label[0]}</span>
                )}
                {tab.badge != null && (
                  <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-primary" />
                )}
              </button>
            </Tooltip>
          );
        })}
      </div>
    );
  }

  // state === 'open'
  return (
    <div
      className="relative flex min-h-0 shrink-0 flex-col border-l border-border/60 bg-card/40"
      style={{ width: `${widthPct}%` }}
    >
      {/* Drag handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={handleDragStart}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
        onPointerCancel={handleDragEnd}
        onDoubleClick={() => setWidthPct(DEFAULT_PCT)}
        className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize touch-none select-none hover:bg-primary/20 active:bg-primary/30"
      />

      {/* Tab bar */}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 pl-2 pr-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = tab.id === effectiveTabId;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  active
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
              >
                {Icon && <Icon className="h-3.5 w-3.5" />}
                <span>{tab.label}</span>
                {tab.badge != null && (
                  <span className="rounded bg-primary/15 px-1 text-[10px] font-semibold text-primary">{tab.badge}</span>
                )}
              </button>
            );
          })}
        </div>
        <Tooltip content="Minimize" side="bottom">
          <button
            type="button"
            onClick={minimizePanel}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronsRightIcon className="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip content="Close" side="bottom">
          <button
            type="button"
            onClick={minimizePanel}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-hidden">{activeTab?.render()}</div>
    </div>
  );
};
