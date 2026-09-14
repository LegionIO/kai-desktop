import { useMemo, type FC, type ReactNode } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVerticalIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Reusable draggable-reorder list primitive built on dnd-kit.
 *
 * Reordering is the ONLY thing this component owns — it does not own add,
 * remove, or a row's content. Callers pass those in via `renderItem` (and
 * optionally `renderLeading`).
 *
 * Rows drag via a dedicated handle (not the whole row) so interactive
 * controls inside row content — text inputs, selects, remove buttons —
 * keep working normally. The handle is keyboard-focusable, so reordering
 * works via keyboard (arrow keys while the handle has focus, after
 * pressing space/enter to pick up) as well as via pointer drag.
 */

export interface SortableListProps<T extends string = string> {
  /** Ordered array of item ids. Order here IS the list's order. */
  items: T[];
  /** Called with the full reordered id array after a drag/keyboard move completes. */
  onReorder: (nextIds: T[]) => void;
  /** Render a single row's content for the given item id. */
  renderItem: (id: T, index: number) => ReactNode;
  /** Optional per-index adornment rendered before the row content (after the handle). */
  renderLeading?: (index: number) => ReactNode;
  /** Accessible label for the list container (`role="list"`). */
  ariaLabel: string;
  /**
   * Accessible name for an individual row's drag handle — should say what it
   * moves (e.g. a model's display name), not just its position. Defaults to
   * `Reorder item ${index + 1}` when omitted.
   */
  getItemLabel?: (id: T, index: number) => string;
  className?: string;
  /** Class applied to each row wrapper. */
  itemClassName?: string;
}

export function SortableList<T extends string = string>({
  items,
  onReorder,
  renderItem,
  renderLeading,
  ariaLabel,
  getItemLabel,
  className,
  itemClassName,
}: SortableListProps<T>) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = items.indexOf(active.id as T);
    const to = items.indexOf(over.id as T);
    if (from === -1 || to === -1) return;
    onReorder(arrayMove(items, from, to));
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        <div role="list" aria-label={ariaLabel} className={className}>
          {items.map((id, index) => (
            <SortableListRow key={id} id={id} className={itemClassName}>
              {(handleProps) => (
                <>
                  <SortableListHandle
                    {...handleProps}
                    label={getItemLabel ? `Reorder ${getItemLabel(id, index)}` : `Reorder item ${index + 1}`}
                  />
                  {renderLeading?.(index)}
                  {renderItem(id, index)}
                </>
              )}
            </SortableListRow>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

interface HandleRenderProps {
  setActivatorNodeRef: (element: HTMLElement | null) => void;
  attributes: ReturnType<typeof useSortable>['attributes'];
  listeners: ReturnType<typeof useSortable>['listeners'];
  isDragging: boolean;
}

const SortableListRow: FC<{
  id: string;
  className?: string;
  children: (handleProps: HandleRenderProps) => ReactNode;
}> = ({ id, className, children }) => {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });

  const reducedMotion = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: reducedMotion ? undefined : transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      role="listitem"
      className={cn(isDragging && 'opacity-60', isDragging && 'z-10 relative', className)}
    >
      {children({ setActivatorNodeRef, attributes, listeners, isDragging })}
    </div>
  );
};

const SortableListHandle: FC<
  HandleRenderProps & {
    label: string;
  }
> = ({ setActivatorNodeRef, attributes, listeners, label }) => (
  <button
    ref={setActivatorNodeRef}
    type="button"
    aria-label={label}
    className="flex shrink-0 cursor-grab touch-none items-center justify-center rounded-md p-1 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-muted-foreground active:cursor-grabbing"
    {...attributes}
    {...listeners}
  >
    <GripVerticalIcon className="h-3.5 w-3.5" />
  </button>
);
