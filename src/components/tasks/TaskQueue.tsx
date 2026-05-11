/**
 * TaskQueue — main task queue view with 5 status rows and drag-and-drop reordering.
 *
 * Adapted from Aperant's kanban pattern with dnd-kit,
 * simplified for Kai's 5-lane workflow.
 */

import { useState, useMemo, useCallback, useRef, useEffect, type FC } from 'react';
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensors,
  useSensor,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { SearchIcon, SlidersHorizontalIcon, XIcon } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useTasks } from '@/providers/TaskProvider';
import type { TaskFile, KaiTaskStatus } from '@/types/task';
import { KAI_TASK_STATUS_COLUMNS, KAI_TASK_STATUS_LABELS } from '@/types/task';
import { TaskQueueRow } from './TaskQueueRow';
import { TaskCard } from './TaskCard';
import { TaskDetailPanel } from './TaskDetailPanel';
import { TaskDetailModal } from './TaskDetailModal';

interface TaskQueueProps {
  /** Active workspace ID — only tasks belonging to this workspace (or unscoped) are shown */
  workspaceId?: string | null;
  /** Increment this each time the tasks view is navigated to, to re-focus the search bar */
  focusTrigger?: number;
}

export const TaskQueue: FC<TaskQueueProps> = ({ workspaceId, focusTrigger }) => {
  const { state, reorderTasks, selectTask } =
    useTasks();

  const [activeTask, setActiveTask] = useState<TaskFile | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilters, setStatusFilters] = useState<Set<KaiTaskStatus>>(new Set());
  const [modalTaskId, setModalTaskId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { const t = setTimeout(() => searchRef.current?.focus(), 50); return () => clearTimeout(t); }, [focusTrigger]);

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

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveTask(null);

      if (!over || !active || active.id === over.id) return;

      const activeId = active.id as string;
      const overId = over.id as string;

      // Find which status row these tasks belong to
      const task = state.tasks.find((t) => t.id === activeId);
      const overTask = state.tasks.find((t) => t.id === overId);
      if (!task || !overTask) return;
      if (task.status !== overTask.status) return;

      reorderTasks(task.status, activeId, overId);
    },
    [state.tasks, reorderTasks],
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
    <div className="flex flex-col h-full min-h-0">
      {/* Fixed toolbar */}
      <div className="shrink-0 pt-6 pb-2">
        <div className="mx-auto max-w-3xl px-4 flex items-center gap-2">
          {/* Search */}
          <div className="flex flex-1 items-center gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
            <SearchIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={searchRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setSearchQuery(''); }}
              placeholder="Search tasks…"
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="shrink-0 rounded p-0.5 hover:bg-muted transition-colors"
              >
                <XIcon className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            )}
          </div>

          {/* Status filter dropdown */}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors ${
                  statusFilters.size > 0
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                }`}
                aria-label="Filter by status"
              >
                <SlidersHorizontalIcon className="h-4 w-4" />
                {statusFilters.size > 0 && (
                  <span className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-bold text-primary-foreground">
                    {statusFilters.size}
                  </span>
                )}
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={6}
                className="z-[9999] min-w-[160px] rounded-xl border border-border/70 bg-popover/95 p-1 text-popover-foreground shadow-xl backdrop-blur-md"
              >
                <DropdownMenu.Label className="px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                  Filter
                </DropdownMenu.Label>
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
      </div>

      {/* Scrollable lanes */}
      <div className="relative flex-1 min-h-0">
        {/* Fade overlay */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-10 bg-gradient-to-b from-background to-transparent" />

        <div className="h-full overflow-y-auto">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <div className="mx-auto max-w-3xl flex flex-col gap-4 px-4 pt-10 pb-6">
              {KAI_TASK_STATUS_COLUMNS.map((status) => (
                <TaskQueueRow
                  key={status}
                  status={status}
                  tasks={tasksByStatus[status]}
                  selectedTaskId={state.selectedTaskId}
                  onTaskClick={handleTaskClick}
                />
              ))}
            </div>

            <DragOverlay dropAnimation={null}>
              {activeTask && (
                <div className="w-[180px] scale-105 rotate-1 opacity-90 shadow-lg shadow-black/20">
                  <TaskCard task={activeTask} onClick={() => {}} />
                </div>
              )}
            </DragOverlay>
          </DndContext>
        </div>
      </div>

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
