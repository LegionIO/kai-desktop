import { useEffect, useRef, useState, useCallback, useLayoutEffect, type FC } from 'react';
import { createPortal } from 'react-dom';
import { CheckIcon, XIcon } from 'lucide-react';
import type { FilterPreference } from './useConversationPreferences';

type FilterPopoverProps = {
  filter: FilterPreference;
  onFilterChange: (filter: FilterPreference) => void;
  activeFilterCount: number;
  onClear: () => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
};

/** Small toggle checkbox */
const FilterToggle: FC<{ label: string; checked: boolean | null; onChange: (v: boolean | null) => void }> = ({
  label,
  checked,
  onChange,
}) => (
  <button
    type="button"
    onClick={() => onChange(checked === true ? null : true)}
    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-muted/50"
  >
    <span
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
        checked === true
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-muted-foreground/40 bg-transparent'
      }`}
    >
      {checked === true && <CheckIcon className="h-2.5 w-2.5" />}
    </span>
    <span className="text-foreground/80 font-medium">{label}</span>
  </button>
);

/** Number input row */
const NumberRangeRow: FC<{
  label: string;
  min: number | null;
  max: number | null;
  onMinChange: (v: number | null) => void;
  onMaxChange: (v: number | null) => void;
}> = ({ label, min, max, onMinChange, onMaxChange }) => (
  <div className="px-3 py-2">
    <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
      {label}
    </div>
    <div className="flex items-center gap-2">
      <input
        type="number"
        placeholder="Min"
        value={min ?? ''}
        onChange={(e) => onMinChange(e.target.value ? Number(e.target.value) : null)}
        min={0}
        className="w-[80px] rounded-lg border border-sidebar-border/70 bg-sidebar-accent/45 px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none"
      />
      <span className="text-[10px] text-muted-foreground">to</span>
      <input
        type="number"
        placeholder="Max"
        value={max ?? ''}
        onChange={(e) => onMaxChange(e.target.value ? Number(e.target.value) : null)}
        min={0}
        className="w-[80px] rounded-lg border border-sidebar-border/70 bg-sidebar-accent/45 px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none"
      />
    </div>
  </div>
);

/** Date range row */
const DateRangeRow: FC<{
  label: string;
  after: string | null;
  before: string | null;
  onAfterChange: (v: string | null) => void;
  onBeforeChange: (v: string | null) => void;
}> = ({ label, after, before, onAfterChange, onBeforeChange }) => (
  <div className="px-3 py-2">
    <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
      {label}
    </div>
    <div className="flex items-center gap-2">
      <div className="flex flex-col gap-1">
        <span className="text-[10px] text-muted-foreground/50">After</span>
        <input
          type="date"
          value={after ?? ''}
          onChange={(e) => onAfterChange(e.target.value || null)}
          className="w-[115px] rounded-lg border border-sidebar-border/70 bg-sidebar-accent/45 px-2 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none"
        />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[10px] text-muted-foreground/50">Before</span>
        <input
          type="date"
          value={before ?? ''}
          onChange={(e) => onBeforeChange(e.target.value || null)}
          className="w-[115px] rounded-lg border border-sidebar-border/70 bg-sidebar-accent/45 px-2 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none"
        />
      </div>
    </div>
  </div>
);

export const FilterPopover: FC<FilterPopoverProps> = ({
  filter,
  onFilterChange,
  activeFilterCount,
  onClear,
  onClose,
  anchorRef,
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Position the popover relative to the anchor button. The filter button sits at
  // the right edge of the toolbar, so anchor the popover's RIGHT edge to the
  // button's right edge and clamp within the viewport (an 8px gutter) so a
  // 280px-wide panel never runs off-screen.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const PANEL_WIDTH = 280;
    const GUTTER = 8;
    const maxLeft = window.innerWidth - PANEL_WIDTH - GUTTER;
    const preferredLeft = rect.right - PANEL_WIDTH; // right-align to the button
    const left = Math.max(GUTTER, Math.min(preferredLeft, maxLeft));
    setPos({ top: rect.bottom + 8, left });
  }, [anchorRef]);

  // Local state for debounced numeric inputs
  const [localMinCount, setLocalMinCount] = useState<number | null>(filter.messageCountMin);
  const [localMaxCount, setLocalMaxCount] = useState<number | null>(filter.messageCountMax);

  // Sync local state when filter changes externally (e.g. clear)
  useEffect(() => {
    setLocalMinCount(filter.messageCountMin);
    setLocalMaxCount(filter.messageCountMax);
  }, [filter.messageCountMin, filter.messageCountMax]);

  // Debounce numeric inputs. Both bounds share one timer AND the delayed write merges
  // into the LATEST filter (via filterRef), not the filter captured when the timer armed:
  // - one timer for the whole range so entering min then max within 300ms doesn't cancel
  //   the min write (previously only the last field survived);
  // - merging the freshest numeric locals into the latest filter so a concurrent toggle
  //   ("Has media") isn't undone by a stale `{ ...filter }` spread from the delayed callback.
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const localMinRef = useRef(localMinCount);
  localMinRef.current = localMinCount;
  const localMaxRef = useRef(localMaxCount);
  localMaxRef.current = localMaxCount;
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRangeUpdate = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      onFilterChange({
        ...filterRef.current,
        messageCountMin: localMinRef.current,
        messageCountMax: localMaxRef.current,
      });
    }, 300);
  }, [onFilterChange]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        onClose();
      }
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [onClose]);

  const update = (partial: Partial<FilterPreference>) => {
    onFilterChange({ ...filter, ...partial });
  };

  if (!pos) return null;

  return createPortal(
    <div
      ref={rootRef}
      style={{ top: pos.top, left: pos.left }}
      className="fixed z-[9999] w-[280px] rounded-2xl border border-border/70 bg-popover/95 p-1.5 shadow-[0_16px_40px_rgba(5,4,15,0.28)] backdrop-blur-xl"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
          Filters
        </span>
        {activeFilterCount > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="flex items-center gap-1 text-xs text-primary transition-colors hover:text-primary/80"
          >
            <XIcon className="h-3 w-3" />
            Clear all
          </button>
        )}
      </div>

      {/* Boolean toggles */}
      <FilterToggle
        label="Has tool calls"
        checked={filter.hasToolCalls}
        onChange={(v) => update({ hasToolCalls: v })}
      />
      <FilterToggle
        label="Has autopilot"
        checked={filter.hasComputerUse}
        onChange={(v) => update({ hasComputerUse: v })}
      />
      <FilterToggle label="Has media" checked={filter.hasMedia} onChange={(v) => update({ hasMedia: v })} />

      {/* Divider */}
      <div className="mx-2 my-1 border-t border-border/30" />

      {/* Message count */}
      <NumberRangeRow
        label="Messages"
        min={localMinCount}
        max={localMaxCount}
        onMinChange={(v) => {
          setLocalMinCount(v);
          localMinRef.current = v;
          scheduleRangeUpdate();
        }}
        onMaxChange={(v) => {
          setLocalMaxCount(v);
          localMaxRef.current = v;
          scheduleRangeUpdate();
        }}
      />

      {/* Divider */}
      <div className="mx-2 my-1 border-t border-border/30" />

      {/* Date ranges */}
      <DateRangeRow
        label="Created"
        after={filter.createdAfter}
        before={filter.createdBefore}
        onAfterChange={(v) => update({ createdAfter: v })}
        onBeforeChange={(v) => update({ createdBefore: v })}
      />
      <DateRangeRow
        label="Last updated"
        after={filter.updatedAfter}
        before={filter.updatedBefore}
        onAfterChange={(v) => update({ updatedAfter: v })}
        onBeforeChange={(v) => update({ updatedBefore: v })}
      />
    </div>,
    document.body,
  );
};
