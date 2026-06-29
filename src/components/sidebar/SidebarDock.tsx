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
  // Which sortable context is mid-drag: 'unit' (outer dock units), 'inner'
  // (icons inside the plugin bubble), or null. Tracked separately so the
  // bubble can collapse to a single-icon width during an OUTER drag — mixing
  // a wide bubble with narrow built-ins in one horizontal sortable makes
  // dnd-kit stretch/condense the mismatched-width siblings.
  const [dragScope, setDragScope] = useState<'unit' | 'inner' | null>(null);
  const isDragging = dragScope !== null;

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
      setDragScope(null);
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
      setDragScope(null);
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

  const handleUnitDragStart = useCallback(() => {
    setDragScope('unit');
    setMouseX(null);
  }, []);

  const handleInnerDragStart = useCallback(() => {
    setDragScope('inner');
    setMouseX(null);
  }, []);

  const handleDragCancel = useCallback(() => setDragScope(null), []);

  const dragActive = isDragging;
  const outerDragActive = dragScope === 'unit';

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
        className="dock-scroll min-w-0 flex-1 overflow-x-auto pb-2 pt-5"
        style={{
          scrollbarWidth: 'none',
        }}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleUnitDragStart}
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
                      outerDragActive={outerDragActive}
                      onInnerDragStart={handleInnerDragStart}
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
  /** True while an OUTER (unit) drag is in progress anywhere in the dock. */
  outerDragActive: boolean;
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
  outerDragActive,
  onInnerDragStart,
  onInnerDragCancel,
  onInnerDragEnd,
}) => {
  const pluginCount = pluginById.size;
  const hasMembers = pluginCount > 0;
  // Collapsed = the bubble shows only the box icon; the plugin icons are pulled
  // inward toward the box (animated to zero width). A bubble with no members is
  // always "collapsed". We also force-collapse during any OUTER (unit) drag so
  // the bubble's width matches the single-icon built-ins — otherwise dnd-kit's
  // horizontal sort distorts widths when a built-in is dragged past the wide
  // expanded pill.
  const collapsed = !expanded || !hasMembers || outerDragActive;

  // Keep a handle on the pill node so we can magnify its background in step with
  // the icons. Forward it to dnd-kit's setNodeRef as well.
  const pillRef = useRef<HTMLDivElement | null>(null);

  // The bubble is one sortable UNIT in the outer dock context. We disable only
  // the DRAGGABLE side when expanded (so the wide pill can't be picked up and
  // distort the horizontal sort), but keep it DROPPABLE so other dock items can
  // still be dropped relative to the group — including at the row edges.
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id: PLUGIN_BUBBLE_UNIT,
    disabled: { draggable: !collapsed, droppable: false },
  });

  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      pillRef.current = node;
      setNodeRef(node);
    },
    [setNodeRef],
  );

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 50 : undefined,
    touchAction: 'none' as const,
  };

  // Magnify the pill background in step with the icons so the rounded boundary
  // grows to contain the enlarged icons on hover (peak at the icon nearest the
  // cursor). Icons grow upward from their bottom edge, so the background needs
  // mostly HEIGHT and only a little WIDTH — a uniform scale balloons sideways
  // past the icons into neighbouring built-ins. Only when expanded.
  let bgScaleY = 1;
  let bgScaleX = 1;
  if (!collapsed && mouseX !== null && pillRef.current && containerRef.current) {
    const pillRect = pillRef.current.getBoundingClientRect();
    const containerRect = containerRef.current.getBoundingClientRect();
    const left = pillRect.left - containerRect.left + containerRef.current.scrollLeft;
    const right = left + pillRect.width;
    // Distance from cursor to the nearest pill edge (0 when cursor is inside).
    const dist = mouseX < left ? left - mouseX : mouseX > right ? mouseX - right : 0;
    bgScaleY = getScale(dist);
    // Width grows only ~15% as much as height.
    bgScaleX = 1 + (bgScaleY - 1) * 0.15;
  }

  // Aggregate badge dot when collapsed and any member has a badge.
  const hasMemberBadge = useMemo(() => Array.from(pluginById.values()).some((i) => i.badge != null), [pluginById]);

  // Single always-mounted structure so the collapse animation works: every
  // inner slot (box anchor + plugins) is rendered in order. The box anchor
  // never collapses; the plugin slots animate their width/opacity to zero when
  // collapsed, pulling inward toward the box wherever it sits in the order.
  // Outer-unit drag listeners go on the pill root only when collapsed (then the
  // pill is just the box); inner sortables are disabled while collapsed so they
  // don't compete with the outer drag.
  return (
    <div
      ref={setRefs}
      style={style}
      {...(collapsed ? listeners : {})}
      className={cn('relative flex shrink-0 items-end gap-0.5', collapsed ? 'px-0' : 'px-1')}
    >
      {/* Magnifying background — scales from the bottom in step with the icons so
          its rounded boundary expands to contain the grown icons. */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-0 origin-bottom rounded-full transition-[background-color,box-shadow,opacity] duration-200 ease-out',
          collapsed
            ? 'bg-transparent opacity-0 ring-0'
            : 'bg-sidebar-accent/40 opacity-100 ring-1 ring-inset ring-sidebar-border/60',
        )}
        style={{
          transform: `scale(${bgScaleX}, ${bgScaleY})`,
          transition:
            mouseX !== null
              ? 'transform 0.15s cubic-bezier(0.22, 1, 0.36, 1)'
              : 'transform 0.3s cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      />
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onInnerDragStart}
        onDragCancel={onInnerDragCancel}
        onDragEnd={onInnerDragEnd}
      >
        <SortableContext items={orderedInnerIds} strategy={horizontalListSortingStrategy}>
          {/* gap-0 when collapsed so the zero-width plugin slots don't each add
              a gap (which would keep a multi-plugin bubble wider than one icon
              and distort the outer sort). Expanded uses the same gap-0.5 as the
              built-in row; magnify spacing is added per-icon via margin. */}
          <div className={cn('relative z-10 flex items-end', collapsed ? 'gap-0' : 'gap-0.5')}>
            {orderedInnerIds.map((innerId) => {
              if (innerId === PLUGIN_BUBBLE_ANCHOR) {
                return (
                  <SortableDockIcon
                    key={innerId}
                    id={PLUGIN_BUBBLE_ANCHOR}
                    disabled={collapsed}
                    item={
                      anchorItem
                        ? {
                            ...anchorItem,
                            onClick: () => {
                              anchorItem.onClick();
                              if (hasMembers) onToggle();
                            },
                            badge:
                              anchorItem.badge ??
                              (collapsed && hasMemberBadge ? (
                                <span className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-blue-500" />
                              ) : undefined),
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
                <CollapsibleSlot key={item.id} collapsed={collapsed} animate={!outerDragActive}>
                  <SortableDockIcon
                    id={item.id}
                    disabled={collapsed}
                    item={item}
                    mouseX={mouseX}
                    containerRef={containerRef}
                  />
                </CollapsibleSlot>
              );
            })}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
};

/* ── Collapsible slot — animates width to zero, pulling inward ── */

/**
 * Wraps an inner plugin icon so it can collapse to zero width. The CSS grid
 * `grid-template-columns: 1fr → 0fr` trick animates an unknown-width child to
 * nothing; combined with `overflow-hidden` + opacity it makes the icon pull
 * inward toward the box anchor instead of snapping. While collapsed the slot is
 * `inert` + `aria-hidden` so its (invisible) button leaves the tab order.
 *
 * `overflow` is hidden ONLY while collapsed — when expanded it must stay
 * visible so on-hover magnification, notification badges, and the drag
 * transform of a reordering icon are not clipped by the slot box.
 */
const CollapsibleSlot: FC<{ collapsed: boolean; animate?: boolean; children: ReactNode }> = ({
  collapsed,
  animate = true,
  children,
}) => (
  <div
    className={cn('grid items-end', animate && 'transition-[grid-template-columns,opacity] duration-200 ease-out')}
    style={{
      gridTemplateColumns: collapsed ? '0fr' : '1fr',
      opacity: collapsed ? 0 : 1,
    }}
    aria-hidden={collapsed || undefined}
    inert={collapsed || undefined}
  >
    <div className={collapsed ? 'overflow-hidden' : 'overflow-visible'}>{children}</div>
  </div>
);

/* ── Sortable wrapper around a dock icon ──────────────── */

interface SortableDockIconProps {
  /** Sortable id — may differ from item.id (e.g. the box anchor inside the bubble). */
  id: string;
  item: DockItem | undefined;
  mouseX: number | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** When true, the icon is not draggable (e.g. plugin icons in a collapsed bubble). */
  disabled?: boolean;
}

const SortableDockIcon: FC<SortableDockIconProps> = ({ id, item, mouseX, containerRef, disabled }) => {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id, disabled });

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
  // The spacer applied on the last render. We subtract it back out when reading
  // the button's position so a magnified icon's own left margin doesn't shift
  // the center we measure (which would make scale/spacer chase themselves).
  const appliedSpacerRef = useRef(0);

  let scale = 1;
  let spacer = 0;
  if (mouseX !== null && btnRef.current && containerRef.current) {
    const btnRect = btnRef.current.getBoundingClientRect();
    const containerRect = containerRef.current.getBoundingClientRect();
    // `origin-bottom` scaling keeps center-x fixed; subtracting the previously
    // applied left margin removes this icon's own contribution to its position,
    // so the measured center is stable across renders.
    const btnCenter =
      btnRect.left +
      btnRect.width / 2 -
      containerRect.left +
      containerRef.current.scrollLeft -
      appliedSpacerRef.current;
    scale = getScale(Math.abs(mouseX - btnCenter));
    // `scale` is a CSS transform and doesn't affect layout, so a magnified icon
    // would overlap its neighbours. Reserve real horizontal margin equal to the
    // growth (half per side) so siblings are pushed apart ONLY as much as this
    // icon magnifies — at rest (scale 1) there's no extra spacing, matching the
    // tight built-in layout. `offsetWidth` ignores the transform, giving a
    // stable base width.
    const baseWidth = btnRef.current.offsetWidth;
    spacer = ((scale - 1) * baseWidth) / 2;
  }
  appliedSpacerRef.current = spacer;

  return (
    // Wrapper carries the magnify spacer margin; the button (inside the Tooltip)
    // carries the scale transform. Keeping the margin off the measured button —
    // and subtracting the prior spacer above — avoids a measure->margin->measure
    // feedback loop. The margin transitions only while hovering so it snaps to
    // zero instantly on drag start (mouseX cleared), keeping the collapsed
    // bubble icon-width.
    <div
      className="flex shrink-0 items-end"
      style={{
        marginLeft: spacer,
        marginRight: spacer,
        transition: mouseX !== null ? 'margin 0.15s cubic-bezier(0.22, 1, 0.36, 1)' : undefined,
      }}
    >
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
    </div>
  );
};
