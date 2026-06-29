import {
  useState,
  useRef,
  useCallback,
  useMemo,
  type FC,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { DndContext, PointerSensor, useSensors, useSensor, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, arrayMove, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVerticalIcon } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/utils';

/* ── Types ────────────────────────────────────────────── */

export interface DockItem {
  /** Unique key */
  id: string;
  /** Tooltip label */
  label: string;
  /** Icon element (rendered inside the button) */
  icon: ReactNode;
  /** Click handler */
  onClick: () => void;
  /** Whether this item is currently "active" (highlighted) */
  active?: boolean;
  /** Secondary/parent highlight — lighter than active, indicates related context */
  subdued?: boolean;
  /** Optional badge (e.g. notification dot) */
  badge?: ReactNode;
  /**
   * Grouping discriminator. 'plugin' items live inside the collapsible plugin
   * bubble and reorder only among themselves (and the box anchor); everything
   * else is a built-in unit that reorders among the built-ins. Defaults to
   * 'builtin'.
   */
  group?: 'builtin' | 'plugin';
}

interface SidebarDockProps {
  items: DockItem[];
  /** Element pinned to the right edge, outside the scrollable area (e.g. ThemeToggle) */
  trailing?: ReactNode;
  className?: string;
  /** Whether the plugin bubble is expanded (plugin icons visible). */
  bubbleExpanded: boolean;
  /** Toggle the plugin bubble expand/collapse. */
  onToggleBubble: () => void;
  /** Persist a new outer unit order (unit ids, incl. 'pluginBubble'). */
  onReorderUnits: (orderedUnitIds: string[]) => void;
  /** Persist a new inner bubble order (box anchor id + plugin item ids). */
  onReorderPlugins: (orderedInnerIds: string[]) => void;
  /** Persisted outer unit order. Reconciled against live items at render. */
  unitOrder?: string[];
  /** Persisted inner bubble order. Reconciled against live items at render. */
  pluginOrder?: string[];
}

/** Synthetic unit id representing the whole plugin bubble in the outer order. */
const PLUGIN_BUBBLE_UNIT = 'pluginBubble';
/** Synthetic id for the box anchor as a sortable member inside the bubble. */
const PLUGIN_BUBBLE_ANCHOR = 'pluginBubbleAnchor';
/** Built-in id that anchors the plugin bubble (the "box" icon). */
const PLUGINS_ANCHOR_ID = 'plugins';

/* ── Magnification math ───────────────────────────────── */

/**
 * Kept modest (1.25×) so Lucide SVG icons stay crisp — they're vector but the
 * browser rasterises at the base size before CSS-scaling, so large factors
 * introduce visible blur on non-retina displays.
 */
const MAX_SCALE = 1.25;
/** How many pixels away the effect reaches (in either direction) */
const INFLUENCE_RADIUS = 70;

function getScale(distance: number): number {
  if (distance > INFLUENCE_RADIUS) return 1;
  // cosine-based falloff — smooth ease at edges
  const ratio = distance / INFLUENCE_RADIUS;
  const boost = (MAX_SCALE - 1) * (0.5 * (1 + Math.cos(Math.PI * ratio)));
  return 1 + boost;
}

/* ── Ordering helpers ─────────────────────────────────── */

/**
 * Reconcile a persisted order against the live id list: keep persisted ids
 * that still exist (deduped, first occurrence wins, in their saved order),
 * then append any new ids in their natural order. Removed ids drop out.
 */
function reconcileOrder(persisted: string[] | undefined, live: string[]): string[] {
  const liveSet = new Set(live);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const id of persisted ?? []) {
    if (!liveSet.has(id) || seen.has(id)) continue;
    seen.add(id);
    kept.push(id);
  }
  const appended = live.filter((id) => !seen.has(id));
  return [...kept, ...appended];
}

/* ── Component ────────────────────────────────────────── */

export const SidebarDock: FC<SidebarDockProps> = ({
  items,
  trailing,
  className,
  bubbleExpanded,
  onToggleBubble,
  onReorderUnits,
  onReorderPlugins,
  unitOrder,
  pluginOrder,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [mouseX, setMouseX] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const sensors = useSensors(
    // Long-press to drag: a held press starts a drag, a quick click still fires
    // onClick. Pointer-only — no KeyboardSensor, so Enter/Space stay bound to
    // the underlying dock <button> for keyboard navigation.
    useSensor(PointerSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
  );

  const handleMouseMove = useCallback(
    (e: ReactMouseEvent) => {
      if (isDragging || !scrollRef.current) return;
      const rect = scrollRef.current.getBoundingClientRect();
      setMouseX(e.clientX - rect.left + scrollRef.current.scrollLeft);
    },
    [isDragging],
  );

  const handleMouseLeave = useCallback(() => {
    setMouseX(null);
  }, []);

  // Partition live items into built-ins and plugin (bubble member) items.
  const pluginItems = useMemo(() => items.filter((i) => i.group === 'plugin'), [items]);
  const anchorItem = useMemo(() => items.find((i) => i.id === PLUGINS_ANCHOR_ID), [items]);
  const builtinItems = useMemo(() => items.filter((i) => i.group !== 'plugin' && i.id !== PLUGINS_ANCHOR_ID), [items]);

  // Outer units = built-ins (minus the plugins anchor) + the synthetic bubble unit.
  const liveUnitIds = useMemo(() => [...builtinItems.map((i) => i.id), PLUGIN_BUBBLE_UNIT], [builtinItems]);
  const orderedUnitIds = useMemo(() => reconcileOrder(unitOrder, liveUnitIds), [unitOrder, liveUnitIds]);

  // Inner bubble order = the box anchor + plugin items, all reorderable together.
  const liveInnerIds = useMemo(() => [PLUGIN_BUBBLE_ANCHOR, ...pluginItems.map((i) => i.id)], [pluginItems]);
  const orderedInnerIds = useMemo(() => reconcileOrder(pluginOrder, liveInnerIds), [pluginOrder, liveInnerIds]);

  const builtinById = useMemo(() => new Map(builtinItems.map((i) => [i.id, i])), [builtinItems]);
  const pluginById = useMemo(() => new Map(pluginItems.map((i) => [i.id, i])), [pluginItems]);

  const handleUnitDragEnd = useCallback(
    (event: DragEndEvent) => {
      setIsDragging(false);
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeId = String(active.id);
      const overId = String(over.id);
      const from = orderedUnitIds.indexOf(activeId);
      const to = orderedUnitIds.indexOf(overId);
      if (from === -1 || to === -1) return;
      onReorderUnits(arrayMove(orderedUnitIds, from, to));
    },
    [orderedUnitIds, onReorderUnits],
  );

  const handleInnerDragEnd = useCallback(
    (event: DragEndEvent) => {
      setIsDragging(false);
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeId = String(active.id);
      const overId = String(over.id);
      const from = orderedInnerIds.indexOf(activeId);
      const to = orderedInnerIds.indexOf(overId);
      if (from === -1 || to === -1) return;
      onReorderPlugins(arrayMove(orderedInnerIds, from, to));
    },
    [orderedInnerIds, onReorderPlugins],
  );

  const handleDragStart = useCallback(() => {
    setIsDragging(true);
    setMouseX(null);
  }, []);

  const handleDragCancel = useCallback(() => setIsDragging(false), []);

  const dragActive = isDragging;

  return (
    <div className={cn('flex items-end border-t border-sidebar-border/80', className)}>
      {/* ── Scrollable icon area ──
           IMPORTANT: Do NOT use justify-center here. When the icons overflow,
           justify-center pushes content equally left and right — but only the
           right overflow is reachable via scroll. The left side gets clipped
           with no way to scroll to it. Instead we use margin:auto on the inner
           wrapper to centre when there's room, and left-align when overflowing. */}
      <div
        ref={scrollRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        className="dock-scroll min-w-0 flex-1 overflow-x-auto pb-2 pt-3"
        style={{
          scrollbarWidth: 'none',
        }}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragCancel={handleDragCancel}
          onDragEnd={handleUnitDragEnd}
        >
          <SortableContext items={orderedUnitIds} strategy={horizontalListSortingStrategy}>
            <div className="flex w-max items-end gap-0.5 px-2 mx-auto">
              {orderedUnitIds.map((unitId) => {
                if (unitId === PLUGIN_BUBBLE_UNIT) {
                  return (
                    <PluginBubble
                      key={unitId}
                      anchorItem={anchorItem}
                      pluginById={pluginById}
                      orderedInnerIds={orderedInnerIds}
                      expanded={bubbleExpanded}
                      onToggle={onToggleBubble}
                      mouseX={dragActive ? null : mouseX}
                      containerRef={scrollRef}
                      sensors={sensors}
                      onInnerDragStart={handleDragStart}
                      onInnerDragCancel={handleDragCancel}
                      onInnerDragEnd={handleInnerDragEnd}
                    />
                  );
                }
                const item = builtinById.get(unitId);
                if (!item) return null;
                return (
                  <SortableDockIcon
                    key={item.id}
                    id={item.id}
                    item={item}
                    mouseX={dragActive ? null : mouseX}
                    containerRef={scrollRef}
                  />
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      {/* ── Fixed trailing element (e.g. theme toggle) ── */}
      {trailing && (
        <div className="flex shrink-0 items-center border-l border-sidebar-border/40 px-1.5 pb-2 pt-3">{trailing}</div>
      )}
    </div>
  );
};

/* ── Plugin bubble (collapsible group of plugin icons) ── */

interface PluginBubbleProps {
  anchorItem: DockItem | undefined;
  pluginById: Map<string, DockItem>;
  orderedInnerIds: string[];
  expanded: boolean;
  onToggle: () => void;
  mouseX: number | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  sensors: ReturnType<typeof useSensors>;
  onInnerDragStart: () => void;
  onInnerDragCancel: () => void;
  onInnerDragEnd: (event: DragEndEvent) => void;
}

const PluginBubble: FC<PluginBubbleProps> = ({
  anchorItem,
  pluginById,
  orderedInnerIds,
  expanded,
  onToggle,
  mouseX,
  containerRef,
  sensors,
  onInnerDragStart,
  onInnerDragCancel,
  onInnerDragEnd,
}) => {
  // The bubble is one sortable UNIT in the outer context. Its drag handle is a
  // dedicated grip (when expanded) or the box icon itself (when collapsed) —
  // see below; we attach `listeners` to whichever element is the handle.
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id: PLUGIN_BUBBLE_UNIT,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 50 : undefined,
    touchAction: 'none' as const,
  };

  const pluginCount = pluginById.size;
  const hasMembers = pluginCount > 0;
  const showMembers = expanded && hasMembers;

  // Aggregate badge dot when collapsed and any member has a badge.
  const hasMemberBadge = useMemo(() => Array.from(pluginById.values()).some((i) => i.badge != null), [pluginById]);

  const boxButton = anchorItem ? (
    <DockIconButton
      item={{
        ...anchorItem,
        onClick: () => {
          anchorItem.onClick();
          if (hasMembers) onToggle();
        },
        badge:
          anchorItem.badge ??
          (!expanded && hasMemberBadge ? (
            <span className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-blue-500" />
          ) : undefined),
      }}
      mouseX={mouseX}
      containerRef={containerRef}
    />
  ) : null;

  // Collapsed: the whole bubble is just the box icon, and the box icon is the
  // outer drag handle (long-press to move the bubble among the built-ins).
  if (!showMembers) {
    return (
      <div ref={setNodeRef} style={style} {...listeners} className="flex shrink-0 items-end">
        {boxButton}
      </div>
    );
  }

  // Expanded: a pill with a grip handle (drags the whole bubble in the outer
  // context) followed by a NESTED DndContext whose members are the box anchor
  // and the plugin icons — all reorderable together inside the bubble.
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex shrink-0 items-end gap-0.5 rounded-full bg-sidebar-accent/40 px-1 ring-1 ring-inset ring-sidebar-border/60"
    >
      {/* Grip — outer drag handle for moving the whole bubble. */}
      <Tooltip content="Drag to move plugin group" side="top" sideOffset={6}>
        <div
          {...listeners}
          className="flex h-7 cursor-grab items-center self-center text-muted-foreground/50 hover:text-muted-foreground"
          style={{ touchAction: 'none' }}
          aria-label="Drag to move plugin group"
        >
          <GripVerticalIcon className="h-3.5 w-3.5" />
        </div>
      </Tooltip>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onInnerDragStart}
        onDragCancel={onInnerDragCancel}
        onDragEnd={onInnerDragEnd}
      >
        <SortableContext items={orderedInnerIds} strategy={horizontalListSortingStrategy}>
          <div className="flex items-end gap-0.5">
            {orderedInnerIds.map((innerId) => {
              if (innerId === PLUGIN_BUBBLE_ANCHOR) {
                return (
                  <SortableDockIcon
                    key={innerId}
                    id={PLUGIN_BUBBLE_ANCHOR}
                    item={
                      anchorItem
                        ? {
                            ...anchorItem,
                            onClick: () => {
                              anchorItem.onClick();
                              onToggle();
                            },
                          }
                        : undefined
                    }
                    mouseX={mouseX}
                    containerRef={containerRef}
                  />
                );
              }
              const item = pluginById.get(innerId);
              if (!item) return null;
              return (
                <SortableDockIcon key={item.id} id={item.id} item={item} mouseX={mouseX} containerRef={containerRef} />
              );
            })}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
};

/* ── Sortable wrapper around a dock icon ──────────────── */

interface SortableDockIconProps {
  /** Sortable id — may differ from item.id (e.g. the box anchor inside the bubble). */
  id: string;
  item: DockItem | undefined;
  mouseX: number | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

const SortableDockIcon: FC<SortableDockIconProps> = ({ id, item, mouseX, containerRef }) => {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 50 : undefined,
    touchAction: 'none' as const,
  };

  if (!item) return null;

  // Pointer-only drag: spread `listeners` (pointer handlers) but NOT
  // `attributes`, which would add role="button"/tabIndex=0 and create a dead
  // keyboard focus stop in front of the real <button>.
  return (
    <div ref={setNodeRef} style={style} {...listeners} className="flex shrink-0 items-end">
      <DockIconButton item={item} mouseX={isDragging ? null : mouseX} containerRef={containerRef} />
    </div>
  );
};

/* ── Individual dock icon button ──────────────────────── */

interface DockIconButtonProps {
  item: DockItem;
  mouseX: number | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

const DockIconButton: FC<DockIconButtonProps> = ({ item, mouseX, containerRef }) => {
  const btnRef = useRef<HTMLButtonElement>(null);

  // Compute scale based on distance from cursor
  let scale = 1;
  if (mouseX !== null && btnRef.current && containerRef.current) {
    const btnRect = btnRef.current.getBoundingClientRect();
    const containerRect = containerRef.current.getBoundingClientRect();
    // Account for scroll position so the calculation stays correct when scrolled
    const btnCenter = btnRect.left + btnRect.width / 2 - containerRect.left + containerRef.current.scrollLeft;
    scale = getScale(Math.abs(mouseX - btnCenter));
  }

  return (
    <Tooltip content={item.label} side="top" sideOffset={6}>
      <button
        ref={btnRef}
        type="button"
        onClick={item.onClick}
        className={cn(
          'titlebar-no-drag relative flex shrink-0 items-center justify-center rounded-xl p-1.5 transition-colors',
          'hover:bg-sidebar-accent/80',
          'origin-bottom will-change-transform',
          item.active
            ? 'bg-[var(--brand-accent)]/20 text-[var(--brand-accent)]'
            : item.subdued
              ? 'text-[var(--brand-accent)]/60 ring-1 ring-inset ring-[var(--brand-accent)]/30'
              : 'text-muted-foreground',
        )}
        style={{
          transform: `scale(${scale})`,
          transition:
            mouseX !== null
              ? 'transform 0.15s cubic-bezier(0.22, 1, 0.36, 1)'
              : 'transform 0.3s cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        {item.icon}
        {item.badge}
      </button>
    </Tooltip>
  );
};
