/**
 * KanbanBoard — main kanban view with 5 columns and drag-and-drop.
 *
 * Adapted from Aperant's KanbanBoard pattern with dnd-kit,
 * simplified for Kai's 5-lane workflow.
 */

import { useState, useMemo, useCallback, type FC } from 'react';
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  KeyboardSensor,
  useSensors,
  useSensor,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { SearchIcon, FilterIcon, XIcon } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useTasks } from '@/providers/TaskProvider';
import type { TaskFile, KaiTaskStatus } from '@/types/task';
import { KAI_TASK_STATUS_COLUMNS, KAI_TASK_STATUS_LABELS } from '@/types/task';
import { KanbanColumn } from './KanbanColumn';
import { TaskCard } from './TaskCard';
import { TaskDetailPanel } from './TaskDetailPanel';
import { TaskDetailModal } from './TaskDetailModal';

interface KanbanBoardProps {
  /** Active workspace ID — only tasks belonging to this workspace (or unscoped) are shown */
  workspaceId?: string | null;
}

export const KanbanBoard: FC<KanbanBoardProps> = ({ workspaceId }) => {
  const { state, reorderTasks, moveTaskToColumn, selectTask } =
    useTasks();

  const [activeTask, setActiveTask] = useState<TaskFile | null>(null);
  const [overColumnId, setOverColumnId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilters, setStatusFilters] = useState<Set<KaiTaskStatus>>(new Set());
  const [modalTaskId, setModalTaskId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // ── Group tasks by status, respecting column order + filters ─────────

  const tasksByStatus = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    const grouped: Record<KaiTaskStatus, TaskFile[]> = {
      todo: [],
      in_progress: [],
      ai_review: [],
      human_review: [],
      done: [],
    };
    for (const task of state.tasks) {
      // Apply workspace filter — only show tasks belonging to the active workspace
      if (workspaceId && task.workspaceId !== workspaceId) continue;
      // Apply search filter
      if (query && !task.title.toLowerCase().includes(query) && !task.description.toLowerCase().includes(query)) continue;
      // Apply status filter
      if (statusFilters.size > 0 && !statusFilters.has(task.status)) continue;
      grouped[task.status]?.push(task);
    }
    // Sort within columns by order, fallback to createdAt descending
    for (const status of KAI_TASK_STATUS_COLUMNS) {
      const order = state.taskOrder[status];
      if (order?.length) {
        const indexMap = new Map(order.map((id, i) => [id, i]));
        grouped[status].sort(
          (a, b) => (indexMap.get(a.id) ?? 999) - (indexMap.get(b.id) ?? 999),
        );
      } else {
        grouped[status].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      }
    }
    return grouped;
  }, [state.tasks, state.taskOrder, searchQuery, statusFilters, workspaceId]);

  // ── Drag handlers ───────────────────────────────────────────────────

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const taskId = event.active.id as string;
      const task = state.tasks.find((t) => t.id === taskId);
      if (task) setActiveTask(task);
    },
    [state.tasks],
  );

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { over } = event;
    if (!over) {
      setOverColumnId(null);
      return;
    }
    // `over.id` is either a column ID (status) or a task ID
    const isColumn = KAI_TASK_STATUS_COLUMNS.includes(over.id as KaiTaskStatus);
    setOverColumnId(isColumn ? (over.id as string) : null);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveTask(null);
      setOverColumnId(null);

      if (!over || !active) return;

      const activeId = active.id as string;
      const overId = over.id as string;
      const task = state.tasks.find((t) => t.id === activeId);
      if (!task) return;

      const sourceStatus = task.status;

      // Dropping on a column directly
      const isColumn = KAI_TASK_STATUS_COLUMNS.includes(overId as KaiTaskStatus);
      if (isColumn) {
        const targetStatus = overId as KaiTaskStatus;
        if (targetStatus !== sourceStatus) {
          moveTaskToColumn(activeId, targetStatus, sourceStatus);
        }
        return;
      }

      // Dropping on another task
      const overTask = state.tasks.find((t) => t.id === overId);
      if (!overTask) return;

      if (sourceStatus === overTask.status) {
        // Reorder within same column
        if (activeId !== overId) {
          reorderTasks(sourceStatus, activeId, overId);
        }
      } else {
        // Move across columns
        moveTaskToColumn(activeId, overTask.status, sourceStatus);
      }
    },
    [state.tasks, moveTaskToColumn, reorderTasks],
  );

  const handleTaskClick = useCallback(
    (task: TaskFile) => {
      setModalTaskId(task.id);
    },
    [],
  );

  const handleOpenFullView = useCallback(
    (taskId: string) => {
      setModalTaskId(null);
      selectTask(taskId);
    },
    [selectTask],
  );

  const selectedTask = useMemo(
    () => state.tasks.find((t) => t.id === state.selectedTaskId) ?? null,
    [state.tasks, state.selectedTaskId],
  );

  const modalTask = useMemo(
    () => (modalTaskId ? state.tasks.find((t) => t.id === modalTaskId) ?? null : null),
    [state.tasks, modalTaskId],
  );

  // ── Loading state ───────────────────────────────────────────────────

  if (state.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p className="text-sm">Loading tasks…</p>
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────

  // When a task is selected from sidebar, show full-width detail view (no breadcrumb — App.tsx title bar handles it)
  if (selectedTask) {
    return <TaskDetailPanel task={selectedTask} />;
  }

  return (
    <div className="flex h-full flex-col pt-12 md:pt-14">
      {/* Board toolbar */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border/50 px-6 py-2.5">
        {/* Search */}
        <div className="relative w-64">
          <SearchIcon className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search tasks…"
            className="h-8 w-full rounded-lg border border-border/70 bg-card pl-8 pr-7 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            >
              <XIcon className="h-3 w-3" />
            </button>
          )}
        </div>

        {/* Status filter dropdown */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className={`relative rounded-lg p-1.5 transition-colors hover:bg-muted/60 ${
                statusFilters.size > 0 ? 'text-primary' : 'text-muted-foreground'
              }`}
              aria-label="Filter by status"
            >
              <FilterIcon className="h-4 w-4" />
              {statusFilters.size > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-bold text-primary-foreground">
                  {statusFilters.size}
                </span>
              )}
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              sideOffset={6}
              className="z-[9999] min-w-[160px] rounded-xl border border-border/70 bg-popover/95 p-1 text-popover-foreground shadow-xl backdrop-blur-md"
            >
              {KAI_TASK_STATUS_COLUMNS.map((status) => (
                <DropdownMenu.CheckboxItem
                  key={status}
                  checked={statusFilters.has(status)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(checked) => {
                    setStatusFilters((prev) => {
                      const next = new Set(prev);
                      if (checked) next.add(status);
                      else next.delete(status);
                      return next;
                    });
                  }}
                  className="flex cursor-default items-center gap-2 rounded-lg px-3 py-1.5 text-xs outline-none transition-colors data-[highlighted]:bg-muted/70"
                >
                  <DropdownMenu.ItemIndicator className="inline-flex h-3.5 w-3.5 items-center justify-center">
                    <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none">
                      <path d="M2.5 6l2.5 2.5 4.5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </DropdownMenu.ItemIndicator>
                  <span className={statusFilters.has(status) ? '' : 'ml-5'}>
                    {KAI_TASK_STATUS_LABELS[status]}
                  </span>
                </DropdownMenu.CheckboxItem>
              ))}
              {statusFilters.size > 0 && (
                <>
                  <DropdownMenu.Separator className="my-1 h-px bg-border/50" />
                  <DropdownMenu.Item
                    className="flex cursor-default items-center gap-2 rounded-lg px-3 py-1.5 text-xs text-muted-foreground outline-none transition-colors data-[highlighted]:bg-muted/70"
                    onSelect={() => setStatusFilters(new Set())}
                  >
                    Clear filters
                  </DropdownMenu.Item>
                </>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      {/* Columns */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="flex flex-1 gap-3 overflow-x-auto p-4">
          {KAI_TASK_STATUS_COLUMNS.map((status) => (
            <KanbanColumn
              key={status}
              status={status}
              tasks={tasksByStatus[status]}
              isOver={overColumnId === status}
              selectedTaskId={state.selectedTaskId}
              onTaskClick={handleTaskClick}
            />
          ))}
        </div>

        <DragOverlay dropAnimation={null}>
          {activeTask && (
            <div className="w-[220px] scale-105 rotate-1 opacity-90 shadow-lg shadow-black/20">
              <TaskCard task={activeTask} onClick={() => {}} />
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {/* Read-only task preview modal */}
      <TaskDetailModal
        task={modalTask}
        open={!!modalTask}
        onOpenChange={(open) => { if (!open) setModalTaskId(null); }}
        onOpenFullView={handleOpenFullView}
      />
    </div>
  );
};
